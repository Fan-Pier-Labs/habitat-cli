import {
  IoTDataPlaneClient,
  GetThingShadowCommand,
  UpdateThingShadowCommand,
} from "@aws-sdk/client-iot-data-plane";
import {
  IoTClient,
  ListThingsInThingGroupCommand,
} from "@aws-sdk/client-iot";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { REGION } from "./config.ts";

// Hardcoded AWS IoT data-plane endpoint (REST). Standard ATS account-specific
// endpoint, extracted from the iOS app JS. The Cognito-vended IAM role does
// NOT allow iot:DescribeEndpoint, so the official app hardcodes this too.
// (The custom-domain `prod.iot-app-v1.salusconnect.io` is MQTT-only.)
const IOT_DATA_ENDPOINT = "https://asyh9zqgbddbc-ats.iot.us-west-2.amazonaws.com";

// Per-user device list lives in DynamoDB, not in any REST API.
// Discovered by reading requireDeviceList() in main.*.js — the app queries
// `UserToDeviceList` keyed by Cognito IdentityId.
const USER_DEVICE_TABLE = "UserToDeviceList";

export interface IoTContext {
  data: IoTDataPlaneClient;
  ddb: DynamoDBDocumentClient;
  iot: IoTClient;
}

export function buildIoT(
  credentials: AwsCredentialIdentityProvider,
): IoTContext {
  const data = new IoTDataPlaneClient({
    region: REGION,
    credentials,
    endpoint: IOT_DATA_ENDPOINT,
  });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION, credentials }),
  );
  const iot = new IoTClient({ region: REGION, credentials });
  return { data, ddb, iot };
}

/**
 * List all things in a gateway's thing group. Each gateway has a sibling group
 * named "Gateway-<MAC>" containing the gateway thing plus child things (the
 * actual HVAC controller and the wall thermostat).
 */
export async function listThingsInGroup(
  ctx: IoTContext,
  gatewayDeviceId: string,
): Promise<string[]> {
  // gatewayDeviceId is like "SAUPTZ1GW-<12-hex-MAC>"; group name is "Gateway-<MAC>"
  const mac = gatewayDeviceId.split("-")[1];
  if (!mac) throw new Error(`Bad gatewayDeviceId: ${gatewayDeviceId}`);
  const groupName = `Gateway-${mac}`;

  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await ctx.iot.send(
      new ListThingsInThingGroupCommand({ thingGroupName: groupName, nextToken }),
    );
    for (const t of resp.things ?? []) if (t) out.push(t);
    nextToken = resp.nextToken;
  } while (nextToken);
  return out;
}

export interface DeviceListResult {
  own: string[];
  shared: string[];
  raw?: Record<string, unknown>;
}

/**
 * Fetch the user's device list from DynamoDB. Mirrors what requireDeviceList()
 * does in the iOS app: query UserToDeviceList where userid = <Cognito IdentityId>,
 * then parse the Own + Sharer columns (JSON strings holding {list: [...]}).
 */
export async function listDevices(
  ctx: IoTContext,
  identityId: string,
): Promise<DeviceListResult> {
  const resp = await ctx.ddb.send(
    new QueryCommand({
      TableName: USER_DEVICE_TABLE,
      KeyConditionExpression: "userid = :uid",
      ExpressionAttributeValues: { ":uid": identityId },
    }),
  );

  if (!resp.Items || resp.Items.length === 0) {
    return { own: [], shared: [] };
  }
  const row = resp.Items[0]!;
  let own: string[] = [];
  let shared: string[] = [];
  try {
    if (typeof row.Own === "string") own = (JSON.parse(row.Own).list as string[]) ?? [];
    if (typeof row.Sharer === "string") shared = (JSON.parse(row.Sharer).list as string[]) ?? [];
  } catch (e) {
    throw new Error(`Failed to parse Own/Sharer JSON: ${(e as Error).message}`);
  }
  return { own, shared, raw: row };
}

export async function getShadow(ctx: IoTContext, thingName: string): Promise<unknown> {
  const resp = await ctx.data.send(new GetThingShadowCommand({ thingName }));
  if (!resp.payload) throw new Error(`No shadow for ${thingName}`);
  return JSON.parse(new TextDecoder().decode(resp.payload));
}

export async function updateShadow(
  ctx: IoTContext,
  thingName: string,
  desired: Record<string, unknown>,
): Promise<unknown> {
  const payload = JSON.stringify({ state: { desired } });
  const resp = await ctx.data.send(
    new UpdateThingShadowCommand({
      thingName,
      payload: new TextEncoder().encode(payload),
    }),
  );
  if (!resp.payload) return null;
  return JSON.parse(new TextDecoder().decode(resp.payload));
}
