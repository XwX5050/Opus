# Releasing

How to build, sign, notarize, and verify an Opus release for macOS.
Releases are Developer ID signed with the Hardened Runtime, notarized by
Apple, and distributed as a DMG — **without the App Sandbox** (design spec
§5.4; see `src-tauri/entitlements.plist`, which must stay free of
`com.apple.security.app-sandbox`).

## Prerequisites

- Apple Developer Program membership and a **Developer ID Application**
  certificate (with its private key) in the release machine's keychain:
  `security find-identity -v -p codesigning` should list
  `Developer ID Application: <Name> (<TeamID>)`.
- Xcode Command Line Tools (`xcode-select --install`) for `codesign`,
  `notarytool`, `stapler`, and `spctl`.
- Rust stable + Node 22, then `npm ci`.

## Environment variables

Tauri's bundler picks up signing configuration from the environment:

| Variable | Purpose |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full identity name, e.g. `Developer ID Application: Your Name (TEAMID)`. With this set, `tauri build` signs every executable in the bundle (app binary + embedded helpers) with this identity and the Hardened Runtime. |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Alternative: base64-encoded `.p12` certificate and its password (CI-style setup without a keychain import). |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID + app-specific password + team ID, used by Tauri for notarization. |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` | Alternative: App Store Connect API key credentials for notarization. |

For interactive notarization the recommended setup is a stored
`notarytool` credentials profile instead of environment variables:

```sh
xcrun notarytool store-credentials "markdown-edit-notary" \
  --apple-id "you@example.com" --team-id "TEAMID"
# prompts for the app-specific password and stores it in the keychain
```

## Build, sign, notarize, staple

```sh
# 1. Build the .app and .dmg (signs with APPLE_SIGNING_IDENTITY when set;
#    Hardened Runtime + entitlements come from tauri.conf.json).
npm run tauri build -- --bundles app,dmg

APP="src-tauri/target/release/bundle/macos/Opus.app"
DMG_CANDIDATES=(src-tauri/target/release/bundle/dmg/Opus_*.dmg)
if [ "${#DMG_CANDIDATES[@]}" -ne 1 ] || [ ! -f "${DMG_CANDIDATES[0]}" ]; then
  echo "Expected exactly one Opus DMG; remove stale Opus builds and retry." >&2
  exit 1
fi
DMG="${DMG_CANDIDATES[0]}"

# 2. Local signature check (also done by scripts/verify-macos-bundle.sh).
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements :- "$APP"   # must NOT contain app-sandbox

# 3. Submit the DMG to Apple notarization and wait for acceptance.
xcrun notarytool submit "$DMG" --keychain-profile "markdown-edit-notary" --wait

# 4. Staple the notarization ticket to the app and the DMG.
xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"

# 5. Final verification: signature, entitlements, Gatekeeper assessment.
./scripts/verify-macos-bundle.sh "$APP"
spctl --assess --type execute --verbose "$APP"   # expect: accepted
```

Publish the stapled DMG to GitHub Releases. Never distribute unsigned or
ad-hoc-signed builds to users; they are for local development only and the
verification script labels them **non-release**.

## Release candidate gate

Run from a clean checkout on the Apple Silicon release machine:

```sh
npm ci
npm run check            # vitest + tsc/vite build + cargo test
npm run test:e2e         # browser-shell E2E (headless Chromium)
npm run perf             # performance budgets (quit running instances first)
npm run tauri build -- --bundles app,dmg
./scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/Opus.app"
```

Expected: all automated tests and budgets PASS; the `.app` and `.dmg` exist;
the verification script reports a valid Developer ID signature and passes
Gatekeeper assessment (with credentials configured). Ad-hoc local builds are
labeled `NON-RELEASE` and skip Gatekeeper assessment — everything else is
still verified. Then run the manual acceptance checklist in
`docs/testing.md`.

**Local ad-hoc note:** without `APPLE_SIGNING_IDENTITY`, Tauri skips
re-signing and the bundle keeps the linker's ad-hoc signature, which current
macOS `codesign --verify` rejects ("code has no resources but signature
indicates they must be present"). Re-sign ad-hoc before local verification:

```sh
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist \
  "src-tauri/target/release/bundle/macos/Opus.app"
```

## Automatic updates channel

Opus updates itself through `tauri-plugin-updater`. Every release publishes
a signed manifest to
`https://github.com/XwX5050/Opus/releases/latest/download/latest.json`; the
app checks that URL silently on startup and offers to download and install
a newer version.

### Update signing key

Update packages are signed with a minisign key pair. Generate one with the
Tauri CLI (this project uses a password-less key — leave the password
prompts empty):

```sh
npm run tauri signer generate -- -w ~/.tauri/opus-updater.key
```

The secret key is written to `~/.tauri/opus-updater.key`; the printed
public key is pinned in the `updater.pubkey` field of
`src-tauri/tauri.conf.json`.

**Never commit the secret key and back it up somewhere safe. Losing it
breaks the update chain permanently**: clients verify every `latest.json`
signature against the pinned public key, and a key cannot be rotated
retroactively — a new key would only work for installs of a future build.

### GitHub Secrets

The release workflow (`.github/workflows/release.yml`, triggered by `v*`
tags) reads two groups of secrets:

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/opus-updater.key` (the whole minisign secret key file). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty for the password-less key; the secret must still be defined so the workflow passes it through. |
| `APPLE_SIGNING_IDENTITY` | Developer ID identity name; with it, tauri-action signs the bundle. |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID, app-specific password, and team ID for notarization. |

When the `APPLE_*` secrets are missing, the workflow still runs but
produces unsigned local builds (fine for internal testing, not for
distribution). When they are configured, artifacts are Developer ID signed
and notarized automatically.

### Publishing a release

Push a `v*` tag. The workflow runs the release gate (`npm run check`), then
`tauri-action` builds the `app,dmg` bundles and creates a GitHub Release
for the tag. Because `createUpdaterArtifacts` is enabled in
`tauri.conf.json`, the release also carries the updater artifacts:
`Opus.app.tar.gz`, its `.sig` signature, and a fresh `latest.json`.

```sh
git tag v0.2.0
git push origin v0.2.0
```

`latest.json` is served from the release's `latest/download` URL, so the
most recent tagged release automatically becomes the update target for all
existing installs.
