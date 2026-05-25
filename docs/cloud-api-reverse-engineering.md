# Habitat HomeLink Cloud API — Reverse-Engineered

Discovered entirely by static analysis of the Habitat HomeLink iOS app, downloaded from the Mac App Store and unwrapped at `/Applications/Habitat.app/Wrapper/Habitat.app/`. Mac App Store builds of iPad apps are decrypted at install on Apple Silicon, so the whole bundle (a Cordova hybrid app with all logic in `www/*.js`) was directly readable. The www/ directory is mirrored under `app-extract/www/` here.

A working CLI based on these findings lives in this repo (TypeScript / Bun, pushed to `github.com/Fan-Pier-Labs/habitat-cli`).

## Headline

**Habitat HomeLink is a white-label rebrand of [Computime](https://www.computime.com)'s IoT platform**, hosted on **Salus Connect**'s AWS infrastructure. The whole stack is **standard AWS Amplify**: Cognito auth, AWS IoT Core MQTT/REST, plus a few API Gateway REST endpoints and direct DynamoDB queries from the client.

The HTZ-01 module is an AWS IoT "thing" whose state lives in a [Device Shadow](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-mqtt.html). Each gateway also has two child things (Zigbee coordinator + PTAC thermostat) under a per-user thing group named `Gateway-<MAC>`.

The Cordova `<author>` tag literally says:
```xml
<author email="computime.com" href="https://www.computime.com/">Computime Limited</author>
```

## Cloud architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│ App                                                                       │
│  │                                                                        │
│  ├── Cognito SRP sign-in (User Pool) ───────────────► idToken + access    │
│  │                                                     +refreshToken      │
│  ├── Cognito Identity Pool exchange (idToken) ─────► temporary IAM creds  │
│  │                                                                        │
│  ├── DynamoDB DocumentClient (IAM-signed)                                 │
│  │    └─ Query UserToDeviceList where userid = <IdentityId>               │
│  │       Returns this user's `Own` + `Sharer` device lists                │
│  │                                                                        │
│  ├── AWS IoT control-plane (REST, IAM-signed)                             │
│  │    ├─ ListThingsInThingGroup("Gateway-<MAC>")                          │
│  │    └─ (most other iot:* actions are DENIED by the user's IAM role)     │
│  │                                                                        │
│  ├── AWS IoT data-plane (REST, IAM-signed)                                │
│  │    https://<accountId>-ats.iot.us-west-2.amazonaws.com                 │
│  │    ├─ GetThingShadow / UpdateThingShadow                               │
│  │    └─ Note: the custom domain prod.iot-app-v1.salusconnect.io is       │
│  │       mutual-TLS only (device firmware), refuses SigV4 clients.        │
│  │                                                                        │
│  ├── AWS IoT data-plane (MQTT over WSS, SigV4-signed)                     │
│  │    wss://<accountId>-ats.iot.us-west-2.amazonaws.com/mqtt              │
│  │    └─ Subscribe to $aws/things/<thing>/shadow/update                   │
│  │       Publish to $aws/things/<thing>/shadow/update                     │
│  │                                                                        │
│  └── REST API Gateways (Cognito-auth via Bearer ACCESS token)             │
│       *.execute-api.us-west-2.amazonaws.com/...                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## AWS Amplify config (extracted from `www/main.*.js`)

```js
{
  aws_project_region:               "us-west-2",
  aws_user_pools_id:                "us-west-2_UqKk6Qvs1",
  aws_user_pools_web_client_id:     "ji4tv7q81n7rbbmv1bkmkeb8i",
  aws_cognito_identity_pool_id:     "us-west-2:ba429fe0-7865-4c71-8715-287b89ec7b5f",
  aws_pubsub_endpoint:              "wss://prod.iot-app-v1.salusconnect.io/mqtt",
  aws_pubsub_region:                "us-west-2",
}
```

**Two endpoints, two different purposes** — figured out the hard way:

| Endpoint | Auth | Used for | Notes |
|---|---|---|---|
| `prod.iot-app-v1.salusconnect.io` (custom domain) | **mTLS only** | **Device firmware** (HTZ-01) opens persistent MQTT here | TLS handshake hangs up immediately if no client cert is presented. SigV4 clients cannot use this host. |
| `<accountId>-ats.iot.us-west-2.amazonaws.com` (standard ATS) | mTLS **or** SigV4 | App + CLI use this for REST shadow ops AND MQTT-over-WSS | Found hardcoded in the JS as `asyh9zqgbddbc-ats.iot.us-west-2.amazonaws.com`. We can't discover it via `iot:DescribeEndpoint` (the Cognito role doesn't grant that action). |

## REST API endpoints (AWS API Gateway, all in `us-west-2`)

All use Cognito ACCESS token as `Authorization: Bearer <token>`. **Not the id token** — that returns 401. (The app's JS literally has `token: t.accessToken.jwtToken`.)

| Purpose | Method | URL |
|---|---|---|
| Device provisioning / RPC (multiplexed by `Command:N`) | POST | `https://5sioez1ny8.execute-api.us-west-2.amazonaws.com/V1/deviceprovision` |
| Share — check if email is registered | POST | `https://lk295wiw9k.execute-api.us-west-2.amazonaws.com/V1/share-users/check-registered-status` |
| Share — invite recipient | POST | `https://lk295wiw9k.execute-api.us-west-2.amazonaws.com/V1/share-users/invite-recipient` |
| Share — delete | POST | `https://lk295wiw9k.execute-api.us-west-2.amazonaws.com/V1/share-users/delete` |
| Device alerts (current) | GET | `https://oi8bbws0zl.execute-api.us-west-2.amazonaws.com/v1/devicesalerts?user_id=…&username=…&gateway_id=…` |
| Device alerts (log) | GET | `https://oi8bbws0zl.execute-api.us-west-2.amazonaws.com/v1/devicealertslogs?user_id=…&username=…&gateway_id=…` |
| Email alerts admin | POST | `https://pnv57a1l4g.execute-api.us-west-2.amazonaws.com/SendEmail/admin-settings` |
| Geofence / location | POST | `https://vpb9jtlx72.execute-api.us-west-2.amazonaws.com/V1/location` |

### The `/V1/deviceprovision` RPC

`Command` values discovered in the JS:

| Command | Body fields | Purpose |
|---|---|---|
| 0 | `UserID`, `Username` | (not used by the CLI — DDB query is faster) |
| 1 | `UserID`, `Username`, `BluetoothID` | Provision a new device during setup |
| 2 | `UserID`, `Username`, `DeviceID` | Get device info (returns substring of body) |
| 4 | `UserID`, `Username`, `DeviceID` | Likely "remove device" (has 408 timeout handling) |
| 10 | `UserID`, `Username` | (no DeviceID) — unconfirmed |

## Device discovery via DynamoDB (not REST)

The app *doesn't* use any REST endpoint to list a user's devices. It queries DynamoDB directly using the Cognito-vended IAM creds:

```js
new i.DynamoDB.DocumentClient({region: REGION}).query({
  TableName: "UserToDeviceList",
  KeyConditionExpression: "userid = :uid",
  ExpressionAttributeValues: { ":uid": identityId },
}, ...);
```

The returned row has two columns:
- `Own` — JSON string `{"list": ["SAUPTZ1GW-<MAC1>", "SAUPTZ1GW-<MAC2>", ...]}`
- `Sharer` — same shape, devices shared *with* this user

So the user's IAM role must allow `dynamodb:Query` on `UserToDeviceList`. The CLI mirrors this with `@aws-sdk/lib-dynamodb`.

The app then filters for items starting with `SAUPTZ1GW` (the gateway product SKU prefix) before iterating.

## MQTT (real-time control)

### Why MQTT (not just REST)
Bookkeeping shadow updates via REST works — but the device only periodically syncs from the cloud (~30-90 min between sync attempts). When *any* MQTT subscriber is connected to its shadow update topic, the device picks up deltas within seconds. The official app keeps a persistent MQTT WebSocket open the whole time it's running.

### Topic conventions (stock AWS IoT Device Shadow)

```js
getUpdateTopic = function(e) { return "$aws/things/" + e + "/shadow/update" }
```

| Topic | Direction | Purpose |
|---|---|---|
| `$aws/things/<thing>/shadow/update` | publish | Send `desired` (commands) |
| `$aws/things/<thing>/shadow/update/accepted` | subscribe | Confirms publish |
| `$aws/things/<thing>/shadow/update/documents` | subscribe | Receives full updated shadow |
| `$aws/things/<thing>/shadow/update/rejected` | subscribe | Errors |

The app subscribes to update topics for the **gateway + zone-coordinator + thermostat** things (three subscriptions per gateway).

### ClientId pattern

```js
clientId = `${gatewayThingName}-${rand16}-${rand16}-${rand16}-${rand16}`;
```

Per-session, includes the gateway name as prefix. The CLI matches this.

### SigV4 signing for WebSocket

Service name `iotdevicegateway`. URL is presigned (`X-Amz-Algorithm` + friends in query string), session token appended *after* signing as `X-Amz-Security-Token`.

## Thing & sub-device topology

Each PTAC unit is **three AWS IoT things** in the same thing group `Gateway-<MAC>`:

| Thing-name pattern | Role | Sub-device id (in shadow) |
|---|---|---|
| `SAUPTZ1GW-<MAC>` | Wi-Fi gateway (HTZ-01's Wi-Fi side) | `000000000001` |
| `SAUPTZ1GW-<MAC>-SAUPTZ1ZC-<deviceId>` | Zigbee coordinator (HTZ-01's Zigbee radio) | `000000000002` |
| `SAUPTZ1GW-<MAC>-SAUPTZ1PT868-0000000000000000` | PTAC over 868 MHz (the actual HVAC controller — talks 915 MHz RF to the HTE-01 wall thermostat through the HTM-01 base module) | `000000000003` |

The thing-group name is derived inside the app as:
```js
thingGroupName: "Gateway-" + e.split("-")[1]
```
where `e` is the gateway thing name (e.g. `SAUPTZ1GW-<MAC>` → group `Gateway-<MAC>`).

## Shadow schema — properties found in the JS

All under `state.reported[<subDeviceId>].properties.<key>`. Keys use Zigbee-style `ep<N>:s<Module>:<Property>` namespacing.

### Gateway (sub-device `000000000001` on the GW thing)

```
ep0:sBasicS:HardwareVersion
ep0:sCoord:Channel_d
ep0:sCoord:ErrorCoordUART
ep0:sCoord:PermitJoinState_d
ep0:sCoord:SetPermitJoinPeriod
ep0:sGateway:DeviceName / SetDeviceName
ep0:sGateway:GatewayHardwareVersion
ep0:sGateway:GatewaySoftwareVersion
ep0:sGateway:ModelIdentifier
ep0:sGateway:NetworkSSID         ← present in cleartext on the wire (encrypted-looking but stored fully)
ep0:sGateway:NetworkWiFiIP
ep0:sGateway:NetworkWiFiMAC
ep0:sGateway:PairingFlag / SetPairingFlag
ep0:sGateway:SetFactoryReset_d
ep0:sGateway:SetNetworkReset_d
ep0:sGateway:SetReadWiFiRSSI
ep0:sGateway:SetRefresh
ep0:sGateway:TimeZone / SetTimeZone
ep0:sGateway:WiFiRSSI
ep0:sGateway:OccupanyDetectionTimeout
ep0:sGateway:deviceFullList       ← array of sub-device IDs known to gateway
ep0:sOTA:SetOTAFirmwareURL_d
ep0:sOTA:OTAStatus_d
ep0:sAwsiot:SetRegistration / Registration
ep0:sIdentiS:SetIndicator
ep0:sZigbeeLogic:SetEnable
ep0:sZDO:FirmwareVersion
ep0:sZDO:MACAddress
app:DeviceName                    ← user-facing friendly name ("Two ?")
app:Manufacturer                  ← HVAC manufacturer (Daikin, AAON, etc.)
app:Model / Address / City / State / Country / Zip / Contractor
```

### PTAC thermostat (sub-device `000000000003` on the PT868 thing)

```
ep0:sPTAC868:LocalTemperature_x100      ← current room temp, °C × 100
ep0:sPTAC868:CoolingSetpoint_x100 / _a / Set*
ep0:sPTAC868:HeatingSetpoint_x100 / _a / Set*
ep0:sPTAC868:CoolSetbackSetpoint_x100 / Set*
ep0:sPTAC868:HeatSetbackSetpoint_x100 / Set*
ep0:sPTAC868:FrostSetpoint_x100   / Set*
ep0:sPTAC868:MaxCoolingSetpoint_x100 / SetMin*/SetMax*
ep0:sPTAC868:MaxHeatingSetpoint_x100 / SetMin*/SetMax*
ep0:sPTAC868:SystemMode / _a / SetSystemMode   ← 0=off, 1=auto, 3=cool, 4=heat, 5=emergencyHeat,
                                                  6=precooling, 7=fanOnly, 8=dry, 9=sleep
ep0:sPTAC868:RunningMode / RunningState
ep0:sPTAC868:FanMode / _a / SetFanMode         ← 0=off, 1=low, 2=med, 3=high, 4=on, 5=auto, 6=smart
ep0:sPTAC868:HoldType / _a / SetHoldType       ← 0=schedule, 1=temporary hold (override)
ep0:sPTAC868:SetbackEnable / SetSetbackEnable
ep0:sPTAC868:LockEnable / LockKey / _a / SetLockEnable / SetLockKey
ep0:sPTAC868:TemperatureDisplayMode / Set*     ← 0=Celsius, 1=Fahrenheit
ep0:sPTAC868:TimeFormat24Hour
ep0:sPTAC868:EMERHeatSelection
ep0:sPTAC868:AudibleSound / SetAudibleSound
ep0:sPTAC868:AutoChangeoverEnable
ep0:sPTAC868:CompressorOffDelayEnable / CompressorCountdownTimer
ep0:sPTAC868:Deadband_x10                       ← cool/heat differential, °C × 10
ep0:sPTAC868:TempCalibration_x100
ep0:sPTAC868:ScheduleSelection / Set* / ScheduleMode / Set*
ep0:sPTAC868:CoolingAlert / SetResetCoolingAlert / SetCoolingAlert
ep0:sPTAC868:HeatingAlert / SetResetHeatingAlert / SetHeatingAlert
ep0:sPTAC868:SetAlarmReset
ep0:sPTAC868:HighTempAlert_x100
ep0:sPTAC868:FilterDays / FilterRunDays / FilterEnable / SetFilterEnable / FilterAlarm
ep0:sPTAC868:BatteryVoltage_x10
ep0:sPTAC868:LCDDriverVersion / FirmwareVersion / HardwareVersion
ep0:sPTAC868:BaseModuleStatus / BaseModuleFirmwareVersion / BaseModuleHardwareVersion
ep0:sPTAC868:BaseModuleReceivedRSSI / BaseModuleReceivedLQI
ep0:sPTAC868:BaseModuleSentRSSI / BaseModuleSentLQI
ep0:sPTAC868:ThermostatEUI                  ← MAC of paired HTE-01 wall thermostat
ep0:sPTAC868:BaseModuleInfo                 ← concatenated MACs (HTE-01 + HTM-01)
ep0:sPTAC868:BaseModulePairStatus / BaseModuleLostLinkStatus
ep0:sPTAC868:NonProgExtTempSensorEUIDEP / CurrentExtTempSensorEUIDEP / ExtTempSensorEnable
ep0:sPTAC868:TextLine1..5                   ← 5×6-byte custom display strings
ep0:sPTAC868:Display / OccupiedStatus / SetBackStatus
ep0:sPTAC868:PTACSystemType / PowerStatus / PTACErrorCode
ep0:sPTAC868:CheckBaseModulePeriod / ResetReason / OperAlert
ep0:sPTAC868:PTAC_d                         ← opaque telemetry blob
ep0:sPTAC868:ErrorUART

ep0:sTimeHold:Schedule1..7 / SetSchedule1..7    ← per-day weekly schedule (82-byte blob)
ep0:sTimeHold:ScheduleStatus                     ← READ key for schedule enable
ep0:sTimeHold:SetScheduleEnable                  ← WRITE key for schedule enable (irregular alias!)
```

### Zone-coordinator (sub-device `000000000002` on the ZC thing)

Mostly Zigbee maintenance: `sZDO:FirmwareVersion`, `sZDO:MACAddress`, `sCoord:PANID_d`, `sCoord:Channel_d`, `sCoord:ReceiveZigbeeCommand_d`, `sBasicS:ModelIdentifier=SAUPTZ1ZC`, etc.

### Temperature encoding

All `_x100` properties are **Celsius × 100**. To convert from user-input Fahrenheit:
```
cValue = Math.round((f - 32) * 5/9 * 100)
```
e.g. 70 °F → 2111 → `21.11 °C`.

### Schedule blob format

Each day's schedule is an 82-byte blob (hex-encoded as a 164-char string in the shadow):

```
Offset  Bytes  Field
 0      4      Header: `20 ff ff ff`
 4     13      Slot 0  (transition record)
17     13      Slot 1
30     13      Slot 2
43     13      Slot 3
56     13      Slot 4
69     13      Slot 5
```

Each 13-byte slot:

```
 0      1      hour BCD       (0xff = empty slot)
 1      1      minute BCD
 2      1      temp °C integer part BCD
 3      1      temp °C decimal part BCD
 4-12   9      padding (active: zeros; inactive: 0xff)
```

Example: `09 30 21 11 00 00 00 00 00 00 00 00 00` → at 09:30, setpoint becomes 21.11 °C (70 °F).

**Quirk the device introduces on write-back:** when you publish a schedule with N<6 active transitions, the device rewrites the first inactive slot's temp field to "carry forward" the last active setpoint, not the default 2111. So you can't byte-compare what you sent to what the device reports — decode both sides and compare active transitions.

## Auth flow (final, working)

1. **Cognito User Pool SRP sign-in** (`amazon-cognito-identity-js`) with email + password. Returns `idToken`, `accessToken`, `refreshToken`.
2. **Cognito Identity Pool exchange** — POST `idToken` to `cognito-identity.us-west-2.amazonaws.com` via `fromCognitoIdentityPool(...)`. Returns short-lived AWS IAM credentials (access key + secret + session token), refreshed automatically.
3. The same `idToken` is also used to fetch the user's **IdentityId** (the DynamoDB partition key).
4. For **shadow ops / DynamoDB / MQTT** → use the IAM credentials (SigV4-signed).
5. For **API Gateway endpoints** → use the **`accessToken`** as `Authorization: Bearer <jwt>`. The id token returns 401.

## Per-user IAM role — what's allowed

The role `Cognito_PoolAuth_Role` (in account `008070384769`) is locked down. Confirmed by trial:

| Action | Allowed | Notes |
|---|---|---|
| `iot:DescribeEndpoint` | ❌ | Use hardcoded ATS endpoint from the app. |
| `iot:ListThings` | ❌ | |
| `iot:ListThingGroups` | ❌ | |
| `iot:ListThingsInThingGroup` | ✅ | Scoped to the user's own group (must know group name first). |
| `iotdata:GetThingShadow` / `UpdateThingShadow` | ✅ | On user's own things. |
| `iot:Connect` / `Publish` / `Subscribe` / `Receive` | ✅ | For MQTT over WSS+SigV4. |
| `dynamodb:Query` on `UserToDeviceList` | ✅ | Keyed on user's IdentityId. |
| `execute-api:Invoke` on the API Gateway endpoints | ✅ | Via Cognito ACCESS token Bearer auth. |

## Surprises / gotchas

1. **Custom-domain endpoint is device-only.** `prod.iot-app-v1.salusconnect.io` (the `aws_pubsub_endpoint` value) is configured for mutual TLS authentication — only the HTZ-01 firmware can connect. SigV4 clients have to use the standard ATS endpoint (hardcoded as `asyh9zqgbddbc-ats.iot.us-west-2.amazonaws.com` in the app).
2. **`iot:DescribeEndpoint` is denied.** Must read the data-plane endpoint string out of the app's JS.
3. **REST uses access token, not id token.** Cognito User Pool authorizers accept both, but this one is configured for access only.
4. **Device list lives in DynamoDB, not a REST API.** The CLI queries `UserToDeviceList` directly with the Cognito-vended IAM creds.
5. **The `Set<X>` → `<X>` naming pattern has exceptions.** `SetScheduleEnable` reports back as `ScheduleStatus`, not `ScheduleEnable`. Alert-reset writes (`SetResetCoolingAlert` etc.) are pure triggers with no reported counterpart. Build an explicit alias table.
6. **Devices only sync deltas reliably when an MQTT subscriber is attached.** Without a subscription, the same publish can take 30-90 minutes (or never) to apply. With one, ~2-30 seconds.
7. **Schedule writes are slower than scalar writes** (~22-47 s vs 2-3 s). Use a longer timeout for `SetSchedule*`.
8. **The device subtly rewrites your schedule blob on read-back.** Always compare decoded transitions, not raw hex.
9. **The Habitat HomeLink iOS app uses no Bluetooth.** No Cordova BLE plugin in the bundle, no GATT UUIDs, no `BluetoothLE` calls. The `BluetoothID` parameter in `Command:1` is just an identifier (probably from a QR code on the box), not active BLE comms. Initial Wi-Fi handoff is probably SoftAP.

## Working CLI (TypeScript / Bun)

Pushed to `git@github.com:Fan-Pier-Labs/habitat-cli.git` (private).

Implements:

```
list                                                # gateways + things + per-unit dashboard
get  <thing>                                        # raw shadow JSON
status <ptac-thing>                                 # decoded thermostat state
schedule <ptac-thing> [--raw]                       # decoded weekly schedule
share check <email>                                 # is email a registered Habitat user?
alerts <gw-thing>                                   # current alerts
alert-log <gw-thing>                                # alert history

fan <ptac> <off|low|med|high|on|auto|smart>           --yes
mode <ptac> <off|auto|cool|heat|...>                  --yes
temp <ptac> [--cool F] [--heat F]                     --yes
schedule-set <ptac> <Day> [HH:MM=TempF ...]           --yes
schedule-enable <ptac> <on|off>                       --yes
hold <ptac> <on|off>                                  --yes
setback <ptac> <on|off>                               --yes
setback-temp <ptac> [--heat F] [--cool F]             --yes
limits <ptac> [--max-cool F] [--min-cool F] [--max-heat F] [--min-heat F]  --yes
lock <ptac> <on|off> [--pin NNNN]                     --yes
display <ptac> [--units f|c] [--sound on|off]         --yes
reset-alert <ptac> <cooling|heating|alarm>            --yes
filter <ptac> <on|off>                                --yes
share add <gw> <email>                                --yes
share remove <gw> <email>                             --yes
geofence --lat F --lng F [--uuid X]                   --yes
```

All write commands default to dry-run; `--yes` actually sends. Each write opens an MQTT subscription, publishes desired state, and waits for the device to echo the new state back. If MQTT confirmation misses, falls back to a REST `GetThingShadow` poll.

## What's still unimplemented in the CLI

- Factory reset / network reset (`SetFactoryReset_d`, `SetNetworkReset_d`) — destructive, on purpose
- `SetTimeZone`, `SetDeviceName` (gateway-level rename) — easy if needed
- OTA push (`SetOTAFirmwareURL_d`) — risky, easy if needed
- BLE provisioning (`Command:1`) — would need a brand-new unit + physical BLE proximity, and the app didn't actually use BLE so the initial-setup mechanism is probably SoftAP (not confirmed)
- The `Command:2`, `Command:4`, `Command:10` variants of `/V1/deviceprovision`

## References

- [AWS IoT Device Shadow MQTT topics](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-mqtt.html)
- [AWS Amplify Auth (web) reference](https://docs.amplify.aws/lib/auth/start/q/platform/js/)
- [Computime corporate site](https://www.computime.com)
- [Salus Connect](https://salusconnect.io/)
- Existing reverse-eng of similar Salus stack: github search `salusfy`, `pyit600`, `python-salus`
- FCC IDs of the hardware: [HTE-01 `2AUYL-HTE01`](https://fccid.io/2AUYL-HTE01) · [HTM-01 `2AUYL-HTM01`](https://fccid.io/2AUYL-HTM01) · [HTZ-01 `2AUYL-HTZ01`](https://fccid.io/2AUYL-HTZ01)
