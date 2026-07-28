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
