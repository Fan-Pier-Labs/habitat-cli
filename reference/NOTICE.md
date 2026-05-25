# Notice — third-party material

The files in this directory are extracted from the official **Habitat HomeLink**
iOS application (App Store ID `1533194934`, publisher Computime Limited), which
was installed locally on macOS from the Mac App Store. Apple Silicon Mac App
Store installs of iPad apps are stored decrypted on disk; this is the unwrapped
bundle content from
`/Applications/Habitat.app/Wrapper/Habitat.app/`.

These files are kept here as **reference material** for the static analysis that
informed the CLI in this repository. They are **not** authored by this project's
maintainer and are © Habitat Technologies / Ice Air / Computime Limited.

The project's own license (`LICENSE`, BSD-4-Clause) does **not** cover anything
in this `reference/` directory — those files remain the property of their
respective copyright holders.

> Note: the Google Maps API keys that shipped in the original bundle
> (`config.xml`, `www/main.*.js`) have been **redacted** from this copy.

## Why it's kept

It's useful to have the original JS handy when:
- Debugging surprises in the cloud API (search for the actual call site).
- Discovering new shadow state keys or REST endpoints.
- Sanity-checking the auth flow if Cognito returns unexpected errors.

## What's in here

| Path | Notes |
|---|---|
| `config.xml` | Cordova app config — lists allowed cloud hosts (computime, salusconnect, AWS API Gateways). |
| `Info.plist` / `Info.plist.xml` | iOS bundle metadata; plist xml is the readable version. |
| `pgm_Localizable_*.json` | UI string tables for each language. |
| `www/main.*.js` | The main webpack bundle. ~7 MB minified. Where all the API logic lives. |
| `www/*.js` | Lazy-loaded webpack chunks. |
| `www/index.html` | Cordova entry point. |
