// PTAC thermostat (HTM-01 + HTE-01 over 868 MHz) data model.
//
// Shadow lives on the child thing `<GATEWAY>-SAUPTZ1PT868-0000000000000000`.
// State is namespaced under sub-device "000000000003".
// Properties use a Zigbee-style prefix `ep0:sPTAC868:<Property>`.
// Temperatures are stored as Celsius × 100 (e.g. 2111 = 21.11 °C = 70 °F).

import { getShadow, updateShadow, listThingsInGroup, type IoTContext } from "./iot.ts";
import {
  closeMqtt,
  connectMqtt,
  makeClientId,
  publishUpdate,
  subscribeAll,
  waitForReported,
} from "./mqtt.ts";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

export const PTAC_SUBDEVICE = "000000000003";

// Standard ZCL Thermostat fan modes — match exactly what FanMode_a reports.
export const FAN_MODE = {
  off: 0,
  low: 1,
  med: 2,
  high: 3,
  on: 4,
  auto: 5,
  smart: 6,
} as const;
export type FanModeName = keyof typeof FAN_MODE;

// Standard ZCL Thermostat system modes
export const SYSTEM_MODE = {
  off: 0,
  auto: 1,
  cool: 3,
  heat: 4,
  "emergency-heat": 5,
  precooling: 6,
  "fan-only": 7,
  dry: 8,
  sleep: 9,
} as const;
export type SystemModeName = keyof typeof SYSTEM_MODE;

export function fahrenheitToShadow(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 100);
}
export function shadowToFahrenheit(v: number): number {
  return Math.round((v / 100) * 9 / 5 + 32);
}
export function nameOf<T extends Record<string, number>>(
  table: T,
  value: number,
): string {
  for (const k of Object.keys(table)) if (table[k as keyof T] === value) return k;
  return `unknown(${value})`;
}

/** Compact summary of the current thermostat state — for `status` command. */
export interface PtacSummary {
  connected: boolean;
  roomTempF: number;
  coolSetpointF: number;
  heatSetpointF: number;
  systemMode: string;       // human-readable
  systemModeRaw: number;
  fanMode: string;          // human-readable
  fanModeRaw: number;
  holdType: number;
  scheduleEnabled: boolean;
  filterDays: number;
  filterRunDays: number;
}

export async function getStatus(
  ctx: IoTContext,
  thingName: string,
): Promise<PtacSummary> {
  const shadow = (await getShadow(ctx, thingName)) as {
    state?: { reported?: Record<string, unknown> };
  };
  const reported = shadow.state?.reported ?? {};
  const dev = (reported as Record<string, { properties?: Record<string, unknown> }>)[
    PTAC_SUBDEVICE
  ];
  const p = dev?.properties ?? {};
  const num = (k: string): number => Number(p[k] ?? 0);
  const sys = num("ep0:sPTAC868:SystemMode_a");
  const fan = num("ep0:sPTAC868:FanMode_a");
  return {
    connected: String(reported.connected) === "true",
    roomTempF: shadowToFahrenheit(num("ep0:sPTAC868:LocalTemperature_x100")),
    coolSetpointF: shadowToFahrenheit(num("ep0:sPTAC868:CoolingSetpoint_x100_a")),
    heatSetpointF: shadowToFahrenheit(num("ep0:sPTAC868:HeatingSetpoint_x100_a")),
    systemMode: nameOf(SYSTEM_MODE, sys),
    systemModeRaw: sys,
    fanMode: nameOf(FAN_MODE, fan),
    fanModeRaw: fan,
    holdType: num("ep0:sPTAC868:HoldType_a"),
    scheduleEnabled: num("ep0:sTimeHold:ScheduleStatus") === 1,
    filterDays: num("ep0:sPTAC868:FilterDays"),
    filterRunDays: num("ep0:sPTAC868:FilterRunDays"),
  };
}

/** Build a shadow `desired` payload that sets PTAC properties on subdevice 003. */
export function buildDesiredPayload(props: Record<string, unknown>) {
  return {
    state: {
      desired: {
        [PTAC_SUBDEVICE]: { properties: props },
      },
    },
  };
}

export async function setPtacProperties(
  ctx: IoTContext,
  thingName: string,
  props: Record<string, unknown>,
): Promise<unknown> {
  return updateShadow(ctx, thingName, {
    [PTAC_SUBDEVICE]: { properties: props },
  });
}

// Irregular desired→reported key mappings the device uses. Most properties
// just drop the `Set` prefix (SetFanMode → FanMode), but a few don't:
const REPORTED_ALIASES: Record<string, string[]> = {
  "ep0:sTimeHold:SetScheduleEnable": ["ep0:sTimeHold:ScheduleStatus"],
  // Alert reset writes are triggers (no clean reported counterpart):
  "ep0:sPTAC868:SetResetCoolingAlert": [],
  "ep0:sPTAC868:SetResetHeatingAlert": [],
  "ep0:sPTAC868:SetAlarmReset": [],
};

export type ConfirmedVia = "mqtt" | "rest-reported" | "rest-desired-only";

export interface LiveResult {
  confirmedVia: ConfirmedVia;
  message?: unknown;
}

/**
 * The reliable, real-time write path that matches what the official app does:
 * open MQTT, subscribe to the gateway + its child things' shadow update topics,
 * publish the desired change, wait for the device to report it back. If MQTT
 * confirmation doesn't arrive, fall back to a REST shadow GET and verify by
 * either:
 *   1. matching reported keys (handles irregular Set* → reported aliases), or
 *   2. matching the shadow's `desired` against what we just published
 *      (the case where the device exposes no clean reported counterpart,
 *      e.g. write-only triggers like SetResetCoolingAlert).
 */
export async function setPtacPropertiesLive(
  ctx: IoTContext,
  credentialsProvider: AwsCredentialIdentityProvider,
  thingName: string,
  props: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<LiveResult> {
  const gatewayName = thingName.split("-").slice(0, 2).join("-");
  const siblings = await listThingsInGroup(ctx, gatewayName);
  const subscribeTo = [gatewayName, ...siblings];

  const clientId = makeClientId(thingName);
  const client = await connectMqtt(credentialsProvider, clientId);
  let mqttResult: unknown;
  try {
    await subscribeAll(client, subscribeTo);
    const waitPromise = waitForReported(
      client,
      thingName,
      PTAC_SUBDEVICE,
      props,
      options.timeoutMs ?? 30_000,
    );
    await publishUpdate(client, thingName, props, PTAC_SUBDEVICE);
    try {
      mqttResult = await waitPromise;
      return { confirmedVia: "mqtt", message: mqttResult };
    } catch {
      // fall through to REST fallback
    }
  } finally {
    await closeMqtt(client);
  }

  // ---- REST fallback ----
  const shadow = (await getShadow(ctx, thingName)) as {
    state?: {
      reported?: Record<string, { properties?: Record<string, unknown> }>;
      desired?: Record<string, { properties?: Record<string, unknown> }>;
    };
  };
  const reported = shadow.state?.reported?.[PTAC_SUBDEVICE]?.properties ?? {};
  const desired = shadow.state?.desired?.[PTAC_SUBDEVICE]?.properties ?? {};

  const valueEq = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a === "string" && typeof b === "string") {
      return a.toLowerCase() === b.toLowerCase();
    }
    return false;
  };

  // Try reported (regular & irregular aliases).
  const reportedAllMatch = Object.entries(props).every(([setKey, val]) => {
    const stripped = setKey.replace(/:Set/g, ":");
    const aliases = REPORTED_ALIASES[setKey] ?? [stripped, stripped + "_a"];
    if (aliases.length === 0) return false;
    return aliases.some((k) => valueEq(reported[k], val));
  });
  if (reportedAllMatch) {
    return { confirmedVia: "rest-reported" };
  }

  // Fall back to "desired arrived" — useful for write-only triggers (alert
  // resets) and for properties with no exposed reported counterpart.
  const desiredAllMatch = Object.entries(props).every(([k, v]) => valueEq(desired[k], v));
  if (desiredAllMatch) {
    return { confirmedVia: "rest-desired-only" };
  }

  throw new Error(
    `Publish accepted by AWS but neither reported nor desired matches what we sent`,
  );
}

export interface ScheduleTransition {
  time: string;       // "HH:MM" or "(empty)"
  setpointF: number;  // °F
  setpointC: number;  // raw °C
  raw: string;        // 13-byte hex slot
}

const SCHEDULE_HEADER = Buffer.from([0x20, 0xff, 0xff, 0xff]);
const SCHEDULE_SLOT_COUNT = 6;
const SCHEDULE_SLOT_SIZE = 13;
const SCHEDULE_DAY_KEYS = [
  "ep0:sTimeHold:SetSchedule1",
  "ep0:sTimeHold:SetSchedule2",
  "ep0:sTimeHold:SetSchedule3",
  "ep0:sTimeHold:SetSchedule4",
  "ep0:sTimeHold:SetSchedule5",
  "ep0:sTimeHold:SetSchedule6",
  "ep0:sTimeHold:SetSchedule7",
];
export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function bcd(n: number): number {
  if (n < 0 || n > 99) throw new Error(`BCD out of range: ${n}`);
  return ((Math.floor(n / 10)) << 4) | (n % 10);
}

/**
 * Encode a day schedule. Input is a list of {timeHHMM, setpointF} transitions
 * — they'll be sorted by time and packed into the 6-slot format. Empty slots
 * use the device's "no transition" sentinel: `ff ff 21 11 ff*9`.
 */
export interface SetTransition {
  hour: number;       // 0-23
  minute: number;     // 0-59
  setpointF: number;  // °F
}

export function encodeDaySchedule(transitions: SetTransition[]): string {
  if (transitions.length > SCHEDULE_SLOT_COUNT) {
    throw new Error(
      `Too many transitions: ${transitions.length}, max ${SCHEDULE_SLOT_COUNT}`,
    );
  }
  const sorted = [...transitions].sort(
    (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute),
  );

  const out = Buffer.alloc(4 + SCHEDULE_SLOT_COUNT * SCHEDULE_SLOT_SIZE);
  SCHEDULE_HEADER.copy(out, 0);

  for (let i = 0; i < SCHEDULE_SLOT_COUNT; i++) {
    const off = 4 + i * SCHEDULE_SLOT_SIZE;
    const tr = sorted[i];
    if (tr) {
      // Sanity-bound the setpoint so we can't accidentally write nonsense.
      if (tr.setpointF < 50 || tr.setpointF > 90) {
        throw new Error(`Setpoint ${tr.setpointF}°F outside safe range 50–90`);
      }
      const cVal = ((tr.setpointF - 32) * 5) / 9;
      const cInt = Math.floor(cVal);
      const cFrac = Math.round((cVal - cInt) * 100);
      out[off] = bcd(tr.hour);
      out[off + 1] = bcd(tr.minute);
      out[off + 2] = bcd(cInt);
      out[off + 3] = bcd(cFrac);
      // bytes 4-12 stay 0 (active-slot padding pattern observed in real data)
    } else {
      // Inactive slot: ff ff 21 11 ff ff ff ff ff ff ff ff ff
      out[off] = 0xff;
      out[off + 1] = 0xff;
      out[off + 2] = 0x21;
      out[off + 3] = 0x11;
      for (let j = 4; j < SCHEDULE_SLOT_SIZE; j++) out[off + j] = 0xff;
    }
  }
  // Match the on-device blob length exactly (observed 82 bytes; spec says
  // 4 + 6*13 = 82, but the last slot was sometimes 1 byte short — keep full).
  return out.toString("hex").toUpperCase();
}

/** Set one day's schedule via the live MQTT path. Day = "Mon".."Sun" or 1..7. */
export async function setDaySchedule(
  ctx: IoTContext,
  credentialsProvider: AwsCredentialIdentityProvider,
  thingName: string,
  day: string | number,
  transitions: SetTransition[],
  options: { timeoutMs?: number } = {},
): Promise<{ confirmedVia: "mqtt" | "rest-fallback" }> {
  const idx =
    typeof day === "number" ? day - 1 : DAY_NAMES.findIndex((d) => d.toLowerCase() === day.toLowerCase());
  if (idx < 0 || idx > 6) throw new Error(`Bad day: ${day}`);
  const setKey = SCHEDULE_DAY_KEYS[idx]!;
  const reportKey = setKey.replace(":Set", ":");
  const hex = encodeDaySchedule(transitions);

  // Compare active transitions (not raw hex) — the device subtly rewrites
  // inactive-slot temps to carry forward the previous active setpoint.
  const sortedExpected = [...transitions]
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
    .map((t) => `${t.hour}:${t.minute}@${t.setpointF}`);

  const isApplied = async (): Promise<boolean> => {
    const shadow = (await getShadow(ctx, thingName)) as {
      state?: { reported?: Record<string, { properties?: Record<string, unknown> }> };
    };
    const reportedHex = String(
      shadow.state?.reported?.[PTAC_SUBDEVICE]?.properties?.[reportKey] ?? "",
    );
    if (!reportedHex) return false;
    const day = { day: "?", transitions: [] as ScheduleTransition[], rawHex: reportedHex };
    Object.assign(day, decodeDayBlob(reportedHex));
    const actual = day.transitions
      .filter((t) => t.time !== "(empty)")
      .map((t) => {
        const [hh, mm] = t.time.split(":").map(Number);
        return `${hh}:${mm}@${t.setpointF}`;
      });
    return (
      actual.length === sortedExpected.length &&
      actual.every((v, i) => v === sortedExpected[i])
    );
  };

  try {
    await setPtacPropertiesLive(
      ctx,
      credentialsProvider,
      thingName,
      { [setKey]: hex },
      options,
    );
    return { confirmedVia: "mqtt" };
  } catch (mqttErr) {
    // MQTT confirmation can drop messages on back-to-back publishes. Fall back
    // to a direct REST shadow GET; if reported transitions match, success.
    if (await isApplied()) return { confirmedVia: "rest-fallback" };
    // One more retry after a short delay (eventual consistency).
    await new Promise((r) => setTimeout(r, 2000));
    if (await isApplied()) return { confirmedVia: "rest-fallback" };
    throw mqttErr;
  }
}

// -------- Generic single-property setters for the PTAC --------

/** 0=schedule (no hold), 1=temporary hold (override until manually cleared). */
export const HOLD_TYPE = { off: 0, on: 1 } as const;
/** 0=Celsius, 1=Fahrenheit (matches device convention; user units are auto-handled by `temp`). */
export const DISPLAY_UNITS = { c: 0, f: 1 } as const;
/** 0=off, 1=on (audible beeper on button press). */
export const ON_OFF = { off: 0, on: 1 } as const;

const SAFE_TEMP_MIN_F = 50;
const SAFE_TEMP_MAX_F = 90;

function tempPayload(prop: string, f: number): Record<string, number> {
  if (!Number.isFinite(f) || f < SAFE_TEMP_MIN_F || f > SAFE_TEMP_MAX_F) {
    throw new Error(`${prop}=${f} outside safety range ${SAFE_TEMP_MIN_F}-${SAFE_TEMP_MAX_F} °F`);
  }
  return { [`ep0:sPTAC868:${prop}`]: fahrenheitToShadow(f) };
}

/** Hold (temporary override of schedule). on=1 / off=0. */
export const buildHoldPayload = (on: boolean): Record<string, number> => ({
  "ep0:sPTAC868:SetHoldType": on ? 1 : 0,
});

/** Enable/disable the away/setback feature. */
export const buildSetbackEnablePayload = (on: boolean): Record<string, number> => ({
  "ep0:sPTAC868:SetSetbackEnable": on ? 1 : 0,
});
export const buildHeatSetbackPayload = (f: number) =>
  tempPayload("SetHeatSetbackSetpoint_x100", f);
export const buildCoolSetbackPayload = (f: number) =>
  tempPayload("SetCoolSetbackSetpoint_x100", f);

/** Enable/disable the weekly schedule entirely. */
export const buildScheduleEnablePayload = (on: boolean): Record<string, number> => ({
  "ep0:sTimeHold:SetScheduleEnable": on ? 1 : 0,
});

/** Child lock + 4-digit PIN. */
export const buildLockEnablePayload = (on: boolean): Record<string, number> => ({
  "ep0:sPTAC868:SetLockEnable": on ? 1 : 0,
});
export const buildLockKeyPayload = (pin: number): Record<string, number> => {
  if (!Number.isInteger(pin) || pin < 0 || pin > 9999) {
    throw new Error(`PIN must be a 4-digit integer 0000..9999, got ${pin}`);
  }
  return { "ep0:sPTAC868:SetLockKey": pin };
};

/** Setpoint guardrails (min/max cool, min/max heat). */
export const buildMaxCoolPayload = (f: number) => tempPayload("SetMaxCoolingSetpoint_x100", f);
export const buildMinCoolPayload = (f: number) => tempPayload("SetMinCoolingSetpoint_x100", f);
export const buildMaxHeatPayload = (f: number) => tempPayload("SetMaxHeatingSetpoint_x100", f);
export const buildMinHeatPayload = (f: number) => tempPayload("SetMinHeatingSetpoint_x100", f);

/** Display: temperature units (F/C) and audible beeper. */
export const buildDisplayUnitsPayload = (units: "f" | "c"): Record<string, number> => ({
  "ep0:sPTAC868:SetTemperatureDisplayMode": DISPLAY_UNITS[units],
});
export const buildSoundPayload = (on: boolean): Record<string, number> => ({
  "ep0:sPTAC868:SetAudibleSound": on ? 1 : 0,
});

/** Reset alert flags. Writes a 1 to trigger the reset. */
export const buildResetCoolAlertPayload = (): Record<string, number> => ({
  "ep0:sPTAC868:SetResetCoolingAlert": 1,
});
export const buildResetHeatAlertPayload = (): Record<string, number> => ({
  "ep0:sPTAC868:SetResetHeatingAlert": 1,
});
export const buildResetAlarmPayload = (): Record<string, number> => ({
  "ep0:sPTAC868:SetAlarmReset": 1,
});

/** Filter monitoring on/off. (To reset filter runtime, the device also exposes
 *  SysMaintenanceFilter* but the reset trigger isn't a single bit. Toggling
 *  FilterEnable off→on is the documented user-visible reset.) */
export const buildFilterEnablePayload = (on: boolean): Record<string, number> => ({
  "ep0:sPTAC868:SetFilterEnable": on ? 1 : 0,
});

/** Decode a single day's blob — extracted so setDaySchedule's fallback can use it. */
function decodeDayBlob(hex: string): { transitions: ScheduleTransition[] } {
  const bytes = Buffer.from(hex, "hex");
  const transitions: ScheduleTransition[] = [];
  const bcdDec = (b: number) => (b >> 4) * 10 + (b & 0xf);
  for (let slot = 0; slot < SCHEDULE_SLOT_COUNT; slot++) {
    const off = 4 + slot * SCHEDULE_SLOT_SIZE;
    const rec = bytes.subarray(off, off + SCHEDULE_SLOT_SIZE);
    if (rec.length < 4) break;
    const [h, m, tInt, tFrac] = [rec[0]!, rec[1]!, rec[2]!, rec[3]!];
    const isActive = h !== 0xff && (h | m) !== 0;
    const cVal = bcdDec(tInt) + bcdDec(tFrac) / 100;
    transitions.push({
      time: isActive ? `${bcdDec(h)}:${bcdDec(m)}` : "(empty)",
      setpointF: Math.round((cVal * 9) / 5 + 32),
      setpointC: cVal,
      raw: rec.toString("hex"),
    });
  }
  return { transitions };
}

export interface DaySchedule {
  day: string;
  transitions: ScheduleTransition[];
  rawHex: string;
}

/**
 * Decode one day's schedule blob. Format (reverse-engineered):
 *  4-byte header: `20 ff ff ff`
 *  6 × 13-byte slots, each:
 *    byte 0:   hour  (BCD; 0xff = empty slot)
 *    byte 1:   minute (BCD)
 *    byte 2:   temp °C integer part (BCD)
 *    byte 3:   temp °C decimal part (BCD)
 *    bytes 4-12: flags/padding (mostly 0 or 0xff)
 */
function decodeDay(hex: string, day: string): DaySchedule {
  const { transitions } = decodeDayBlob(hex);
  // Pretty-format times with zero-padding for display
  for (const t of transitions) {
    if (t.time !== "(empty)") {
      const [h, m] = t.time.split(":").map(Number);
      t.time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  return { day, transitions, rawHex: hex };
}

/**
 * Friendly info from the gateway thing's shadow (sub-device 000000000001):
 * the user-assigned DeviceName, address, HVAC manufacturer, Wi-Fi info, etc.
 */
export interface GatewayInfo {
  connected: boolean;
  deviceName: string;
  manufacturer: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  wifiIp: string;
  wifiMac: string;
  wifiRssi: number;
  gatewayFwVersion: string;
  gatewayHwVersion: string;
  timeZone: string;
}

export async function getGatewayInfo(
  ctx: IoTContext,
  gatewayThingName: string,
): Promise<GatewayInfo> {
  const shadow = (await getShadow(ctx, gatewayThingName)) as {
    state?: { reported?: Record<string, unknown> };
  };
  const reported = shadow.state?.reported ?? {};
  const gw = (reported as Record<string, { properties?: Record<string, unknown> }>)[
    "000000000001"
  ];
  const p = gw?.properties ?? {};
  const s = (k: string): string => String(p[k] ?? "");
  return {
    connected: String(reported.connected) === "true",
    deviceName: s("app:DeviceName"),
    manufacturer: s("app:Manufacturer"),
    address: s("app:Address"),
    city: s("app:City"),
    state: s("app:State"),
    zip: s("app:Zip"),
    country: s("app:Country"),
    wifiIp: s("ep0:sGateway:NetworkWiFiIP"),
    wifiMac: s("ep0:sGateway:NetworkWiFiMAC"),
    wifiRssi: Number(p["ep0:sGateway:WiFiRSSI"] ?? 0),
    gatewayFwVersion: s("ep0:sGateway:GatewaySoftwareVersion"),
    gatewayHwVersion: s("ep0:sGateway:GatewayHardwareVersion"),
    timeZone: s("ep0:sGateway:TimeZone"),
  };
}

export async function getSchedule(
  ctx: IoTContext,
  thingName: string,
): Promise<DaySchedule[]> {
  const shadow = (await getShadow(ctx, thingName)) as {
    state?: { reported?: Record<string, unknown> };
  };
  const dev = (shadow.state?.reported as Record<string, { properties?: Record<string, unknown> }>)?.[
    PTAC_SUBDEVICE
  ];
  const p = dev?.properties ?? {};
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const out: DaySchedule[] = [];
  for (let i = 1; i <= 7; i++) {
    const key = `ep0:sTimeHold:Schedule${i}`;
    const hex = String(p[key] ?? "");
    out.push(decodeDay(hex, dayNames[i - 1]!));
  }
  return out;
}
