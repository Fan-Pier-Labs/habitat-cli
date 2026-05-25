#!/usr/bin/env bun
import { loginFromEnv } from "./auth.ts";
import {
  buildIoT,
  listDevices,
  listThingsInGroup,
  getShadow,
} from "./iot.ts";
import {
  DAY_NAMES,
  FAN_MODE,
  SYSTEM_MODE,
  buildCoolSetbackPayload,
  buildDesiredPayload,
  buildDisplayUnitsPayload,
  buildFilterEnablePayload,
  buildHeatSetbackPayload,
  buildHoldPayload,
  buildLockEnablePayload,
  buildLockKeyPayload,
  buildMaxCoolPayload,
  buildMaxHeatPayload,
  buildMinCoolPayload,
  buildMinHeatPayload,
  buildResetAlarmPayload,
  buildResetCoolAlertPayload,
  buildResetHeatAlertPayload,
  buildScheduleEnablePayload,
  buildSetbackEnablePayload,
  buildSoundPayload,
  encodeDaySchedule,
  fahrenheitToShadow,
  getGatewayInfo,
  getSchedule,
  getStatus,
  setDaySchedule,
  setPtacPropertiesLive,
  type FanModeName,
  type SetTransition,
  type SystemModeName,
} from "./ptac.ts";
import {
  getAlertLog,
  getCurrentAlerts,
  shareCheckRegistered,
  shareDelete,
  shareInvite,
  updateLocation,
} from "./rest.ts";
import { SETPOINT_MAX_F, SETPOINT_MIN_F } from "./config.ts";

const USAGE = `habitat — control your Habitat HomeLink thermostats from the CLI

Commands:
  habitat list                                    list your gateways and their child things
  habitat get <thingName>                         dump a thing's raw shadow JSON
  habitat status <ptacThingName>                  human-readable thermostat status
  habitat schedule <ptacThingName>                show the weekly schedule (raw hex)
  habitat fan <ptacThingName> <mode>              set fan mode: ${Object.keys(FAN_MODE).join("|")}
  habitat mode <ptacThingName> <mode>             set system mode: ${Object.keys(SYSTEM_MODE).join("|")}
  habitat temp <ptacThingName> --cool N           set cool setpoint (°F)
  habitat temp <ptacThingName> --heat N           set heat setpoint (°F)
  habitat schedule-set <ptacThingName> <Day> [HH:MM=TempF ...]
                                                  replace one day's schedule
                                                  (Day: Mon|Tue|...|Sun;
                                                   up to 6 transitions, sorted automatically;
                                                   omit transitions to clear that day)
  habitat schedule-enable <ptacThingName> <on|off>
                                                  enable/disable the weekly schedule
  habitat hold <ptacThingName> <on|off>           temporary hold (override schedule)
  habitat setback <ptacThingName> <on|off>        enable/disable away/setback mode
  habitat setback-temp <ptacThingName> [--heat F] [--cool F]
                                                  set away/setback heat & cool setpoints
  habitat limits <ptacThingName> [--max-cool F] [--min-cool F] [--max-heat F] [--min-heat F]
                                                  setpoint guardrails
  habitat lock <ptacThingName> <on|off> [--pin NNNN]
                                                  child lock with optional 4-digit PIN
  habitat display <ptacThingName> [--units f|c] [--sound on|off]
                                                  thermostat display preferences
  habitat reset-alert <ptacThingName> <cooling|heating|alarm>
                                                  clear an alert flag
  habitat filter <ptacThingName> <on|off>         filter monitoring on/off

REST endpoints (gateway-level, not per-PTAC):
  habitat share check <email>                     is this email a registered Habitat user?
  habitat share list <gatewayThingName>           who is this gateway shared with?
  habitat share add <gatewayThingName> <email>    invite a user to share
  habitat share remove <gatewayThingName> <email> revoke share
  habitat alerts <gatewayThingName>               current device alerts (REST)
  habitat alert-log <gatewayThingName>            alert history (REST)
  habitat geofence --lat F --lng F --uuid UUID    update the app's geofence position

Safety:
  All write commands are DRY-RUN by default. Pass --yes to actually send.
  --cool / --heat bounded to ${SETPOINT_MIN_F}-${SETPOINT_MAX_F} °F.

Examples:
  habitat list
  habitat status SAUPTZ1GW-XXXXXXXXXXXX-SAUPTZ1PT868-0000000000000000
  habitat fan SAUPTZ1GW-XXXXXXXXXXXX-SAUPTZ1PT868-0000000000000000 on
  habitat fan SAUPTZ1GW-XXXXXXXXXXXX-SAUPTZ1PT868-0000000000000000 on --yes

Credentials are read from .env (HABITAT_EMAIL, HABITAT_PASSWORD).`;

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function cmdList() {
  const { credentialsProvider, identityId } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  const { own, shared } = await listDevices(ctx, identityId);

  console.log(`IdentityId: ${identityId}\n`);
  console.log(`Own gateways (${own.length}):\n`);

  for (const gw of own) {
    // Fetch gateway info, child thing list, and PTAC status concurrently
    const [info, things] = await Promise.all([
      getGatewayInfo(ctx, gw).catch(() => null),
      listThingsInGroup(ctx, gw).catch(() => [] as string[]),
    ]);

    const ptacThing = things.find((t) => t.includes("SAUPTZ1PT868"));
    const zcThing = things.find((t) => t.includes("SAUPTZ1ZC"));
    const status = ptacThing
      ? await getStatus(ctx, ptacThing).catch(() => null)
      : null;

    const friendlyName = info?.deviceName?.trim() || "(unnamed)";
    const connState = info?.connected ? "online" : "offline";
    console.log(`  ▸ "${friendlyName}"  [${gw}]  — ${connState}`);

    if (info) {
      const addr = [info.address, info.city, info.state, info.zip]
        .filter(Boolean)
        .join(", ");
      if (addr) console.log(`      address:      ${addr}${info.country ? `, ${info.country}` : ""}`);
      if (info.manufacturer) console.log(`      HVAC mfr:     ${info.manufacturer}`);
      if (info.wifiIp || info.wifiMac)
        console.log(
          `      network:      ${info.wifiIp || "?"}  (mac ${info.wifiMac || "?"})  RSSI ${info.wifiRssi || "?"} dBm`,
        );
      if (info.gatewayFwVersion)
        console.log(`      firmware:     ${info.gatewayFwVersion} (hw v${info.gatewayHwVersion || "?"})`);
      if (info.timeZone) console.log(`      timezone:     ${info.timeZone}`);
    }

    if (status) {
      const sp =
        status.systemModeRaw === 0
          ? "—"
          : status.systemModeRaw === 4 || status.systemModeRaw === 5
          ? `→ ${status.heatSetpointF} °F`
          : `→ ${status.coolSetpointF} °F`;
      console.log(
        `      thermostat:   ${status.roomTempF} °F room, mode ${status.systemMode} ${sp}, fan ${status.fanMode}` +
          (status.scheduleEnabled ? ", schedule on" : ""),
      );
    }

    if (things.length > 0) {
      console.log(`      things:`);
      for (const t of things) {
        let label = "";
        if (t === gw) label = "  ← Wi-Fi gateway";
        else if (t === ptacThing) label = "  ← PTAC thermostat (use this for fan/mode/temp/schedule)";
        else if (t === zcThing) label = "  ← Zigbee coordinator";
        console.log(`        ${t}${label}`);
      }
    }
    console.log();
  }

  if (shared.length > 0) {
    console.log(`Shared with you (${shared.length}):`);
    for (const gw of shared) console.log(`  - ${gw}`);
  }
}

async function cmdGet(thingName: string) {
  const { credentialsProvider } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  console.log(JSON.stringify(await getShadow(ctx, thingName), null, 2));
}

async function cmdStatus(thingName: string) {
  const { credentialsProvider } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  const s = await getStatus(ctx, thingName);
  console.log(`Thing:       ${thingName}`);
  console.log(`Connected:   ${s.connected}`);
  console.log(`Room temp:   ${s.roomTempF} °F`);
  console.log(`Cool setpoint: ${s.coolSetpointF} °F`);
  console.log(`Heat setpoint: ${s.heatSetpointF} °F`);
  console.log(`System mode: ${s.systemMode} (raw ${s.systemModeRaw})`);
  console.log(`Fan mode:    ${s.fanMode} (raw ${s.fanModeRaw})`);
  console.log(`Hold type:   ${s.holdType}`);
  console.log(`Schedule:    ${s.scheduleEnabled ? "enabled" : "disabled"}`);
  console.log(`Filter:      ran ${s.filterRunDays}/${s.filterDays} days`);
}

async function cmdSchedule(thingName: string, flags: Flags) {
  const { credentialsProvider } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  const sched = await getSchedule(ctx, thingName);
  console.log(`Thing: ${thingName}\n`);
  for (const day of sched) {
    const active = day.transitions.filter((t) => t.time !== "(empty)");
    if (active.length === 0) {
      console.log(`${day.day}:  (no transitions — single setpoint ${day.transitions[0]?.setpointF}°F)`);
    } else {
      const summary = active
        .map((t) => `${t.time} → ${t.setpointF}°F`)
        .join("  |  ");
      console.log(`${day.day}:  ${summary}`);
    }
    if (flags.raw) console.log(`     raw: ${day.rawHex}`);
  }
}

async function applyAndReport(
  thingName: string,
  props: Record<string, unknown>,
  flags: Flags,
): Promise<void> {
  const payload = buildDesiredPayload(props);
  console.log(`Thing: ${thingName}`);
  console.log("Payload to publish:");
  console.log(JSON.stringify(payload, null, 2));
  if (!flags.yes) {
    console.log("\n[dry run] Re-run with --yes to actually send.");
    return;
  }
  const { credentialsProvider } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 30_000;
  console.log(`\nOpening MQTT, publishing, and waiting up to ${timeoutMs / 1000}s for device to confirm...`);
  const start = Date.now();
  const { confirmedVia, message } = await setPtacPropertiesLive(
    ctx,
    credentialsProvider,
    thingName,
    props,
    { timeoutMs },
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const label =
    confirmedVia === "mqtt"
      ? "device confirmed (MQTT subscription)"
      : confirmedVia === "rest-reported"
      ? "device confirmed (REST fallback)"
      : "publish accepted by cloud; device's reported state not (yet) updated for this property";
  console.log(`\n${label} after ${elapsed}s.`);
  // Pull just the relevant reported keys from the MQTT confirmation message
  if (message) {
    const reported = (message as {
      state?: { reported?: Record<string, { properties?: Record<string, unknown> }> };
    })?.state?.reported;
    if (reported) {
      for (const [subId, sub] of Object.entries(reported)) {
        const matching = Object.entries(sub.properties ?? {}).filter(([k]) =>
          Object.keys(props).some((set) => k.includes(set.replace(/:Set/g, ":"))),
        );
        if (matching.length > 0) {
          console.log(`  reported on sub-device ${subId}:`);
          for (const [k, v] of matching) console.log(`    ${k} = ${v}`);
        }
      }
    }
  }
}

async function cmdFan(thingName: string, modeArg: string, flags: Flags) {
  const mode = modeArg.toLowerCase() as FanModeName;
  if (!(mode in FAN_MODE)) {
    throw new Error(`Bad fan mode "${modeArg}". Allowed: ${Object.keys(FAN_MODE).join(", ")}`);
  }
  const props = { "ep0:sPTAC868:SetFanMode": FAN_MODE[mode] };
  await applyAndReport(thingName, props, flags);
}

async function cmdMode(thingName: string, modeArg: string, flags: Flags) {
  const mode = modeArg.toLowerCase() as SystemModeName;
  if (!(mode in SYSTEM_MODE)) {
    throw new Error(
      `Bad system mode "${modeArg}". Allowed: ${Object.keys(SYSTEM_MODE).join(", ")}`,
    );
  }
  const props = { "ep0:sPTAC868:SetSystemMode": SYSTEM_MODE[mode] };
  await applyAndReport(thingName, props, flags);
}

function parseTransitionArg(s: string): SetTransition {
  // Format: "HH:MM=TempF" e.g. "09:30=70"
  const m = s.match(/^(\d{1,2}):(\d{2})=(-?\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`Bad transition "${s}". Expected HH:MM=TempF, e.g. 09:30=70`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const tempF = Number(m[3]);
  if (hour < 0 || hour > 23) throw new Error(`Bad hour in "${s}"`);
  if (minute < 0 || minute > 59) throw new Error(`Bad minute in "${s}"`);
  return { hour, minute, setpointF: tempF };
}

async function cmdScheduleSet(
  thingName: string,
  day: string,
  transitionArgs: string[],
  flags: Flags,
) {
  const dayIdx = DAY_NAMES.findIndex((d) => d.toLowerCase() === day.toLowerCase());
  if (dayIdx < 0) throw new Error(`Bad day "${day}". One of: ${DAY_NAMES.join(", ")}`);

  const transitions = transitionArgs.map(parseTransitionArg);
  const hex = encodeDaySchedule(transitions);

  console.log(`Thing:  ${thingName}`);
  console.log(`Day:    ${DAY_NAMES[dayIdx]} (Schedule${dayIdx + 1})`);
  console.log(
    `New transitions (${transitions.length}): ${
      transitions
        .map((t) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}→${t.setpointF}°F`)
        .join(", ") || "(none — schedule will be empty for this day)"
    }`,
  );
  console.log(`Encoded blob (${hex.length / 2} bytes): ${hex}`);

  if (!flags.yes) {
    console.log("\n[dry run] Re-run with --yes to actually send.");
    return;
  }

  const { credentialsProvider } = await loginFromEnv();
  const ctx = buildIoT(credentialsProvider);
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 30_000;
  console.log(`\nPublishing via MQTT and waiting up to ${timeoutMs / 1000}s for device to confirm...`);
  const start = Date.now();
  const { confirmedVia } = await setDaySchedule(
    ctx,
    credentialsProvider,
    thingName,
    day,
    transitions,
    { timeoutMs },
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const via = confirmedVia === "mqtt" ? "MQTT subscription" : "REST fallback poll";
  console.log(`\nDevice confirmed schedule update after ${elapsed}s (via ${via}).`);
}

// -------- generic single-property write commands --------

function parseOnOff(s: string): boolean {
  const v = s.toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  throw new Error(`Expected on|off, got "${s}"`);
}

async function cmdHold(thingName: string, arg: string, flags: Flags) {
  await applyAndReport(thingName, buildHoldPayload(parseOnOff(arg)), flags);
}
async function cmdScheduleEnable(thingName: string, arg: string, flags: Flags) {
  await applyAndReport(thingName, buildScheduleEnablePayload(parseOnOff(arg)), flags);
}
async function cmdSetback(thingName: string, arg: string, flags: Flags) {
  await applyAndReport(thingName, buildSetbackEnablePayload(parseOnOff(arg)), flags);
}
async function cmdSetbackTemp(thingName: string, flags: Flags) {
  const props: Record<string, unknown> = {};
  if (flags.heat !== undefined) Object.assign(props, buildHeatSetbackPayload(Number(flags.heat)));
  if (flags.cool !== undefined) Object.assign(props, buildCoolSetbackPayload(Number(flags.cool)));
  if (Object.keys(props).length === 0) throw new Error("Pass --heat F and/or --cool F");
  await applyAndReport(thingName, props, flags);
}
async function cmdLimits(thingName: string, flags: Flags) {
  const props: Record<string, unknown> = {};
  if (flags["max-cool"] !== undefined) Object.assign(props, buildMaxCoolPayload(Number(flags["max-cool"])));
  if (flags["min-cool"] !== undefined) Object.assign(props, buildMinCoolPayload(Number(flags["min-cool"])));
  if (flags["max-heat"] !== undefined) Object.assign(props, buildMaxHeatPayload(Number(flags["max-heat"])));
  if (flags["min-heat"] !== undefined) Object.assign(props, buildMinHeatPayload(Number(flags["min-heat"])));
  if (Object.keys(props).length === 0)
    throw new Error("Pass at least one of --max-cool / --min-cool / --max-heat / --min-heat");
  await applyAndReport(thingName, props, flags);
}
async function cmdLock(thingName: string, arg: string, flags: Flags) {
  const props: Record<string, unknown> = { ...buildLockEnablePayload(parseOnOff(arg)) };
  if (flags.pin !== undefined) {
    const pin = Number(flags.pin);
    Object.assign(props, buildLockKeyPayload(pin));
  }
  await applyAndReport(thingName, props, flags);
}
async function cmdDisplay(thingName: string, flags: Flags) {
  const props: Record<string, unknown> = {};
  if (typeof flags.units === "string") {
    const u = flags.units.toLowerCase();
    if (u !== "f" && u !== "c") throw new Error(`--units must be f or c`);
    Object.assign(props, buildDisplayUnitsPayload(u));
  }
  if (typeof flags.sound === "string") {
    Object.assign(props, buildSoundPayload(parseOnOff(flags.sound)));
  }
  if (Object.keys(props).length === 0) throw new Error("Pass --units f|c and/or --sound on|off");
  await applyAndReport(thingName, props, flags);
}
async function cmdResetAlert(thingName: string, kind: string, flags: Flags) {
  const k = kind.toLowerCase();
  let props: Record<string, unknown>;
  if (k === "cooling") props = buildResetCoolAlertPayload();
  else if (k === "heating") props = buildResetHeatAlertPayload();
  else if (k === "alarm") props = buildResetAlarmPayload();
  else throw new Error(`Unknown alert kind "${kind}". Use cooling|heating|alarm.`);
  await applyAndReport(thingName, props, flags);
}
async function cmdFilter(thingName: string, arg: string, flags: Flags) {
  await applyAndReport(thingName, buildFilterEnablePayload(parseOnOff(arg)), flags);
}

// -------- REST endpoint commands --------

async function cmdShareCheck(email: string) {
  const { session } = await loginFromEnv();
  const r = await shareCheckRegistered(session, email);
  console.log(JSON.stringify(r, null, 2));
}
async function cmdShareAdd(gateway: string, email: string, flags: Flags) {
  console.log(`Inviting ${email} to share gateway ${gateway}.`);
  if (!flags.yes) {
    console.log("\n[dry run] Re-run with --yes to actually send.");
    return;
  }
  const { session, identityId } = await loginFromEnv();
  const r = await shareInvite(session, {
    recipientEmail: email,
    identityId,
    gatewayId: gateway,
  });
  console.log(JSON.stringify(r, null, 2));
}
async function cmdShareRemove(gateway: string, email: string, flags: Flags) {
  console.log(`Removing share of ${gateway} with ${email}.`);
  if (!flags.yes) {
    console.log("\n[dry run] Re-run with --yes to actually send.");
    return;
  }
  const { session, identityId } = await loginFromEnv();
  const r = await shareDelete(session, {
    sharerEmail: email,
    identityId,
    gatewayId: gateway,
  });
  console.log(JSON.stringify(r, null, 2));
}
async function cmdShareList(_gateway: string) {
  // No discovered API for "list current shares". The official app reads its
  // own shareDeviceList from DynamoDB UserToDeviceList (Sharer column).
  // Cleanest: print the user's `shareDeviceList`.
  const { session: _s } = await loginFromEnv();
  console.log(
    "share list: not implemented as a single REST call.\n" +
      "Use `habitat list` — the 'Shared with you' block lists gateways shared with you.\n" +
      "For 'who is YOUR gateway shared with', the app appears to track this client-side; " +
      "no dedicated REST endpoint was found in the iOS bundle.",
  );
}
async function cmdAlerts(gateway: string) {
  const { session, identityId } = await loginFromEnv();
  const r = await getCurrentAlerts(session, { gatewayId: gateway, identityId });
  console.log(JSON.stringify(r, null, 2));
}
async function cmdAlertLog(gateway: string) {
  const { session, identityId } = await loginFromEnv();
  const r = await getAlertLog(session, { gatewayId: gateway, identityId });
  console.log(JSON.stringify(r, null, 2));
}
async function cmdGeofence(flags: Flags) {
  const lat = Number(flags.lat);
  const lng = Number(flags.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    throw new Error("Pass --lat F --lng F");
  const uuid =
    typeof flags.uuid === "string"
      ? flags.uuid
      : `habitat-cli-${Math.random().toString(36).slice(2, 10)}`;
  console.log(`Geofence update: lat=${lat} lng=${lng} uuid=${uuid}`);
  if (!flags.yes) {
    console.log("\n[dry run] Re-run with --yes to actually send.");
    return;
  }
  const { session, identityId } = await loginFromEnv();
  const r = await updateLocation(session, { lat, lng, userId: identityId, uuid });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdTemp(thingName: string, flags: Flags) {
  const props: Record<string, unknown> = {};
  if (flags.cool !== undefined) {
    const f = Number(flags.cool);
    if (!Number.isFinite(f) || f < SETPOINT_MIN_F || f > SETPOINT_MAX_F) {
      throw new Error(`--cool ${flags.cool} out of safety range ${SETPOINT_MIN_F}-${SETPOINT_MAX_F} °F`);
    }
    props["ep0:sPTAC868:SetCoolingSetpoint_x100"] = fahrenheitToShadow(f);
  }
  if (flags.heat !== undefined) {
    const f = Number(flags.heat);
    if (!Number.isFinite(f) || f < SETPOINT_MIN_F || f > SETPOINT_MAX_F) {
      throw new Error(`--heat ${flags.heat} out of safety range ${SETPOINT_MIN_F}-${SETPOINT_MAX_F} °F`);
    }
    props["ep0:sPTAC868:SetHeatingSetpoint_x100"] = fahrenheitToShadow(f);
  }
  if (Object.keys(props).length === 0) {
    throw new Error("Nothing to set. Pass --cool <F> and/or --heat <F>.");
  }
  await applyAndReport(thingName, props, flags);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  try {
    switch (cmd) {
      case "list":
        await cmdList();
        break;
      case "get": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat get <thingName>");
        await cmdGet(t);
        break;
      }
      case "status": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat status <ptacThingName>");
        await cmdStatus(t);
        break;
      }
      case "schedule": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat schedule <ptacThingName> [--raw]");
        await cmdSchedule(t, flags);
        break;
      }
      case "fan": {
        const [t, m] = positional;
        if (!t || !m) throw new Error("Usage: habitat fan <ptacThingName> <mode>");
        await cmdFan(t, m, flags);
        break;
      }
      case "mode": {
        const [t, m] = positional;
        if (!t || !m) throw new Error("Usage: habitat mode <ptacThingName> <mode>");
        await cmdMode(t, m, flags);
        break;
      }
      case "temp": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat temp <ptacThingName> [--cool N] [--heat N]");
        await cmdTemp(t, flags);
        break;
      }
      case "schedule-set": {
        const [t, day, ...transitions] = positional;
        if (!t || !day) {
          throw new Error(
            "Usage: habitat schedule-set <ptacThingName> <Day> [HH:MM=TempF ...]",
          );
        }
        await cmdScheduleSet(t, day, transitions, flags);
        break;
      }
      case "schedule-enable": {
        const [t, v] = positional;
        if (!t || !v) throw new Error("Usage: habitat schedule-enable <ptacThingName> <on|off>");
        await cmdScheduleEnable(t, v, flags);
        break;
      }
      case "hold": {
        const [t, v] = positional;
        if (!t || !v) throw new Error("Usage: habitat hold <ptacThingName> <on|off>");
        await cmdHold(t, v, flags);
        break;
      }
      case "setback": {
        const [t, v] = positional;
        if (!t || !v) throw new Error("Usage: habitat setback <ptacThingName> <on|off>");
        await cmdSetback(t, v, flags);
        break;
      }
      case "setback-temp": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat setback-temp <ptacThingName> [--heat F] [--cool F]");
        await cmdSetbackTemp(t, flags);
        break;
      }
      case "limits": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat limits <ptacThingName> [--max-cool F] [--min-cool F] [--max-heat F] [--min-heat F]");
        await cmdLimits(t, flags);
        break;
      }
      case "lock": {
        const [t, v] = positional;
        if (!t || !v) throw new Error("Usage: habitat lock <ptacThingName> <on|off> [--pin NNNN]");
        await cmdLock(t, v, flags);
        break;
      }
      case "display": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat display <ptacThingName> [--units f|c] [--sound on|off]");
        await cmdDisplay(t, flags);
        break;
      }
      case "reset-alert": {
        const [t, kind] = positional;
        if (!t || !kind) throw new Error("Usage: habitat reset-alert <ptacThingName> <cooling|heating|alarm>");
        await cmdResetAlert(t, kind, flags);
        break;
      }
      case "filter": {
        const [t, v] = positional;
        if (!t || !v) throw new Error("Usage: habitat filter <ptacThingName> <on|off>");
        await cmdFilter(t, v, flags);
        break;
      }
      case "share": {
        const sub = positional[0];
        if (sub === "check") {
          const email = positional[1];
          if (!email) throw new Error("Usage: habitat share check <email>");
          await cmdShareCheck(email);
        } else if (sub === "add") {
          const [, gw, email] = positional;
          if (!gw || !email) throw new Error("Usage: habitat share add <gatewayThingName> <email>");
          await cmdShareAdd(gw, email, flags);
        } else if (sub === "remove") {
          const [, gw, email] = positional;
          if (!gw || !email) throw new Error("Usage: habitat share remove <gatewayThingName> <email>");
          await cmdShareRemove(gw, email, flags);
        } else if (sub === "list") {
          const gw = positional[1];
          if (!gw) throw new Error("Usage: habitat share list <gatewayThingName>");
          await cmdShareList(gw);
        } else {
          throw new Error("Usage: habitat share <check|list|add|remove> ...");
        }
        break;
      }
      case "alerts": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat alerts <gatewayThingName>");
        await cmdAlerts(t);
        break;
      }
      case "alert-log": {
        const t = positional[0];
        if (!t) throw new Error("Usage: habitat alert-log <gatewayThingName>");
        await cmdAlertLog(t);
        break;
      }
      case "geofence": {
        await cmdGeofence(flags);
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

main();
