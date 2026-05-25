// Minimal MQTT-over-WebSocket client built on Bun's native WebSocket +
// `mqtt-packet`. Replaces the `mqtt` npm package, which fell over in Bun
// (its Node bundle hits `node:net`/`node:tls` paths Bun hasn't implemented,
// and its browser bundle has its own polyfill issues).
//
// Why we're doing this at all: the official iOS app keeps a persistent MQTT
// connection open and subscribes to the device's shadow update topics.
// Doing that from the CLI is what gets the device to apply shadow changes
// in seconds rather than 30-90 minutes. See
// docs/cloud-api-reverse-engineering.md for the full discovery.

import mqttPacket from "mqtt-packet";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { REGION } from "./config.ts";

// Standard AWS IoT account-specific data endpoint — accepts both
// SigV4 WebSocket from Cognito-vended creds AND mutual-TLS direct MQTT.
// The `prod.iot-app-v1.salusconnect.io` custom-domain endpoint is for the
// device firmware only (mutual TLS), it hangs up on any other client.
const IOT_MQTT_HOST = "asyh9zqgbddbc-ats.iot.us-west-2.amazonaws.com";
const KEEPALIVE_SECONDS = 60;

async function signedWsUrl(
  credsProvider: AwsCredentialIdentityProvider,
): Promise<string> {
  const creds = await credsProvider();
  const signer = new SignatureV4({
    service: "iotdevicegateway",
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      // sessionToken intentionally appended AFTER signing — IoT accepts it
      // un-signed in the query string.
    },
    sha256: Sha256,
  });
  const request = new HttpRequest({
    method: "GET",
    protocol: "wss:",
    hostname: IOT_MQTT_HOST,
    path: "/mqtt",
    headers: { host: IOT_MQTT_HOST },
  });
  const signed = await signer.presign(request, { expiresIn: 86_400 });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(signed.query ?? {})) {
    if (typeof v === "string") params.set(k, v);
  }
  if (creds.sessionToken) params.set("X-Amz-Security-Token", creds.sessionToken);
  return `wss://${IOT_MQTT_HOST}/mqtt?${params.toString()}`;
}

type Listener = (topic: string, payload: Uint8Array) => void;

export class MqttClient {
  private ws: WebSocket;
  private parser = mqttPacket.parser({ protocolVersion: 4 });
  private listeners = new Set<Listener>();
  private nextMessageId = 1;
  private pendingAcks = new Map<number, () => void>();
  private connacked = false;
  private connackResolve!: () => void;
  private connackReject!: (e: Error) => void;
  private connackPromise: Promise<void>;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  public closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.connackPromise = new Promise((res, rej) => {
      this.connackResolve = res;
      this.connackReject = rej;
    });

    this.parser.on("packet", (pkt: mqttPacket.Packet) => {
      switch (pkt.cmd) {
        case "connack": {
          const c = pkt as mqttPacket.IConnackPacket;
          if (c.returnCode === 0) {
            this.connacked = true;
            this.connackResolve();
            this.keepaliveTimer = setInterval(
              () => this.send({ cmd: "pingreq" }),
              (KEEPALIVE_SECONDS - 5) * 1000,
            );
          } else {
            this.connackReject(new Error(`CONNACK rc=${c.returnCode}`));
          }
          break;
        }
        case "publish": {
          const p = pkt as mqttPacket.IPublishPacket;
          for (const l of this.listeners) l(p.topic, p.payload as Uint8Array);
          if (p.qos === 1 && typeof p.messageId === "number") {
            this.send({ cmd: "puback", messageId: p.messageId });
          }
          break;
        }
        case "puback":
        case "suback": {
          const ack = (pkt as mqttPacket.IPubackPacket | mqttPacket.ISubackPacket).messageId;
          if (typeof ack === "number") {
            const r = this.pendingAcks.get(ack);
            if (r) {
              this.pendingAcks.delete(ack);
              r();
            }
          }
          break;
        }
        case "pingresp":
          break;
      }
    });
    this.parser.on("error", (e: Error) => {
      this.connackReject(e);
    });

    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (ev) => {
      const data = ev.data;
      const buf =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data as Uint8Array);
      this.parser.parse(buf);
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      if (!this.connacked) this.connackReject(new Error("WebSocket closed before CONNACK"));
    });
    this.ws.addEventListener("error", () => {
      if (!this.connacked) this.connackReject(new Error("WebSocket error before CONNACK"));
    });
  }

  private send(packet: mqttPacket.Packet): void {
    const buf = mqttPacket.generate(packet);
    this.ws.send(buf);
  }

  async connect(clientId: string): Promise<void> {
    this.send({
      cmd: "connect",
      protocolId: "MQTT",
      protocolVersion: 4,
      clean: true,
      clientId,
      keepalive: KEEPALIVE_SECONDS,
    });
    await this.connackPromise;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subscribe(topic: string, qos: 0 | 1 = 1): Promise<void> {
    const messageId = this.nextMessageId++;
    const waitAck = new Promise<void>((resolve) =>
      this.pendingAcks.set(messageId, resolve),
    );
    this.send({
      cmd: "subscribe",
      messageId,
      subscriptions: [{ topic, qos }],
    });
    await waitAck;
  }

  async publish(topic: string, payload: string, qos: 0 | 1 = 1): Promise<void> {
    if (qos === 0) {
      this.send({ cmd: "publish", topic, payload, qos: 0, dup: false, retain: false });
      return;
    }
    const messageId = this.nextMessageId++;
    const waitAck = new Promise<void>((resolve) =>
      this.pendingAcks.set(messageId, resolve),
    );
    this.send({
      cmd: "publish",
      topic,
      payload,
      qos: 1,
      dup: false,
      retain: false,
      messageId,
    });
    await waitAck;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.ws.addEventListener("close", () => resolve(), { once: true });
      try {
        this.send({ cmd: "disconnect" });
      } catch {}
      try {
        this.ws.close();
      } catch {}
    });
  }
}

export async function connectMqtt(
  credsProvider: AwsCredentialIdentityProvider,
  clientId: string,
): Promise<MqttClient> {
  const url = await signedWsUrl(credsProvider);
  if (process.env.HABITAT_DEBUG) {
    console.error("[debug] WSS URL (signed):", url.slice(0, 120) + "...");
  }
  const ws = new WebSocket(url, ["mqtt"]);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = (ev: Event) => {
      ws.removeEventListener("open", onOpen);
      const errMsg = (ev as ErrorEvent).message ?? "unknown WebSocket error";
      reject(new Error(`WebSocket connect failed: ${errMsg}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onErr, { once: true });
  });
  const client = new MqttClient(ws);
  await client.connect(clientId);
  return client;
}

/**
 * Generate an MQTT clientId in the same shape the official app uses:
 * `<gateway-thing-name>-<random>-<random>-<random>-<random>`.
 */
export function makeClientId(thingName: string): string {
  const parts = thingName.split("-");
  const gateway = parts.slice(0, 2).join("-");
  const rand = () => Math.random().toString().replace(".", "").slice(0, 16);
  return `${gateway}-${rand()}-${rand()}-${rand()}-${rand()}`;
}

export function shadowUpdateTopic(thingName: string): string {
  return `$aws/things/${thingName}/shadow/update`;
}

export async function subscribeAll(
  client: MqttClient,
  thingNames: string[],
): Promise<void> {
  for (const t of thingNames) {
    await client.subscribe(shadowUpdateTopic(t), 1);
  }
}

export async function publishUpdate(
  client: MqttClient,
  thingName: string,
  desired: Record<string, unknown>,
  subDeviceId: string,
): Promise<void> {
  const payload = JSON.stringify({
    state: { desired: { [subDeviceId]: { properties: desired } } },
  });
  await client.publish(shadowUpdateTopic(thingName), payload, 1);
}

/**
 * Wait until the shadow's reported state for the target thing/sub-device
 * reflects every key in `expected`. The reported keys are `Set*` → unprefixed
 * (e.g. `SetFanMode` → `FanMode`, also try `FanMode_a` for the device's
 * "acknowledged" variant).
 */
export function waitForReported(
  client: MqttClient,
  thingName: string,
  subDeviceId: string,
  expected: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const targetTopic = shadowUpdateTopic(thingName);
  const reportedKeys: Record<string, [string, string]> = {};
  for (const k of Object.keys(expected)) {
    const stripped = k.replace(/:Set/g, ":");
    reportedKeys[k] = [stripped, stripped + "_a"];
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for device to apply change`));
    }, timeoutMs);
    const off = client.on((topic, payload) => {
      if (topic !== targetTopic) return;
      let msg: unknown;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      const reported = (msg as {
        state?: { reported?: Record<string, { properties?: Record<string, unknown> }> };
      })?.state?.reported?.[subDeviceId]?.properties;
      if (!reported) return;
      const eq = (a: unknown, b: unknown): boolean => {
        if (a === b) return true;
        if (typeof a === "string" && typeof b === "string") {
          return a.toLowerCase() === b.toLowerCase();
        }
        return false;
      };
      const allMatch = Object.entries(expected).every(([k, v]) => {
        const [k1, k2] = reportedKeys[k]!;
        return eq(reported[k1], v) || eq(reported[k2], v);
      });
      if (allMatch) {
        clearTimeout(timer);
        off();
        resolve(msg);
      }
    });
  });
}

export async function closeMqtt(client: MqttClient): Promise<void> {
  await client.close();
}
