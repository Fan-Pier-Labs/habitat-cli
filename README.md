# habitati-cli

CLI for the Habitat HomeLink thermostat system — reverse-engineered from the official iOS app.

Talks to the same AWS cloud (Cognito → AWS IoT Device Shadow) the official app uses. There is no local-control path; the HTZ-01 module exposes no LAN ports.

See [`docs/cloud-api-reverse-engineering.md`](docs/cloud-api-reverse-engineering.md) for how this was discovered.

## Setup

```
bun install
cp .env.example .env
# edit .env with your Habitat HomeLink app email + password
```

## Usage

```
bun start                                                # show help

bun start list                                           # list your thing groups + thing names
bun start get <thingName>                                # dump the device's current shadow
bun start set <thingName> --temp 72                      # DRY RUN: prints payload that would be sent
bun start set <thingName> --temp 72 --mode cool --yes    # actually send
```

## Safety

- `set` is **dry-run by default**. You must pass `--yes` for the request to actually hit AWS IoT.
- `--temp` is bounded to `SETPOINT_MIN_F`..`SETPOINT_MAX_F` (defined in `src/config.ts`, currently 50–90 °F) as a typo guard.
- This is controlling a real HVAC unit — it can cool/heat your apartment for real.

## How it works (high level)

1. Cognito User Pool SRP sign-in → JWT.
2. JWT exchanged via Cognito Identity Pool → temporary AWS IAM credentials.
3. `iot:DescribeEndpoint` to find the per-account data-plane host.
4. `iot:ListThingGroups` + `iot:ListThingsInThingGroup` to enumerate devices.
5. `iotdata:GetThingShadow` / `UpdateThingShadow` to read/write desired state.

The same flow the official mobile app uses, just done from this Mac.

## License

BSD 4-Clause — see [`LICENSE`](LICENSE).

The license covers this project's own code only. It does **not** cover the
`reference/` directory, which is third-party material extracted from the
official Habitat HomeLink iOS app and remains © its respective copyright holders
(Habitat Technologies / Ice Air / Computime Limited). See [`reference/NOTICE.md`](reference/NOTICE.md).

---

Developed by Ryan Hughes with Claude Code 🤖
