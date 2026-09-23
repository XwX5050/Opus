# Releasing

How to build, sign, and verify an Opus release. macOS releases ship
**unsigned** (ad-hoc signature) by default — the project does not carry a
paid Apple Developer Program membership, so Gatekeeper blocks the first
launch and the release notes carry an install note telling users how to
bypass it (System Settings → Privacy & Security → "Open Anyway", or
`xattr -cr /Applications/Opus.app`). If Developer ID credentials are ever
configured, the same pipeline signs with the Hardened Runtime, notarizes,
and staples instead — **without the App Sandbox** either way (design spec
§5.4; see `src-tauri/entitlements.plist`, which must stay free of
`com.apple.security.app-sandbox`). Windows releases are NSIS installers
(see §Windows builds below).

## Prerequisites

- Rust stable + Node 22, then `npm ci`.
- Optional, only for a signed macOS release: Apple Developer Program
  membership and a **Developer ID Application** certificate (with its
  private key) in the release machine's keychain:
  `security find-identity -v -p codesigning` should list
  `Developer ID Application: <Name> (<TeamID>)`, plus Xcode Command Line
  Tools (`xcode-select --install`) for `codesign`, `notarytool`, `stapler`,
  and `spctl`.

## Environment variables

Tauri's bundler picks up signing configuration from the environment:

| Variable | Purpose |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | Full identity name, e.g. `Developer ID Application: Your Name (TEAMID)`. With this set, `tauri build` signs every executable in the bundle (app binary + embedded helpers) with this identity and the Hardened Runtime. |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Base64-encoded Developer ID `.p12` certificate and its export password for CI. Tauri imports it and can infer the signing identity. |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID + app-specific password + team ID, used by Tauri for notarization. |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` | Alternative: App Store Connect API key credentials for notarization. |

For interactive notarization the recommended setup is a stored
`notarytool` credentials profile instead of environment variables:

```sh
xcrun notarytool store-credentials "markdown-edit-notary" \
  --apple-id "you@example.com" --team-id "TEAMID"
# prompts for the app-specific password and stores it in the keychain
```

## Build, sign, notarize, staple (signed releases only)

This section applies only when a Developer ID identity is available. For
the default unsigned release, `npm run tauri build -- --bundles app,dmg`
is the whole build step — skip straight to publishing.

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

Publish the DMG to GitHub Releases. Unsigned (ad-hoc) builds are the
project's default macOS release form: distribute them with the install
note from `.github/workflows/release.yml` (Gatekeeper bypass on first
launch). The verification script labels them **UNSIGNED** and skips the
Gatekeeper assessment, which only a notarized Developer ID build can
pass.

## Windows builds

Build the NSIS installer locally:

```sh
npm run tauri build -- --bundles nsis
```

The installer (`Opus_*_x64-setup.exe`) lands in
`src-tauri/target/release/bundle/nsis/` and registers the `.md`/`.markdown`
file associations on install. Windows keeps the standard window decorations
(the overlay `titleBarStyle` in `tauri.conf.json` is macOS-only), and a
second launch while the app is running forwards its paths to the existing
instance via `tauri-plugin-single-instance` instead of starting a new
process.

Code signing is optional. Set `TAURI_SIGNING_CERTIFICATE` (path to a `.pfx`)
and `TAURI_SIGNING_CERTIFICATE_PASSWORD` and `tauri build` signs the
installer during the build; alternatively sign the finished installer with
`signtool` and a code-signing certificate. Unsigned installers are fine for
internal testing, but Windows SmartScreen shows a "Windows protected your
PC" prompt on first run — expected, not a defect (a signing certificate
trusted on the target machine suppresses it). The updater artifacts are
unaffected by code signing: they use the same minisign `latest.json` scheme
as macOS and Linux.

`release-windows` in `.github/workflows/release.yml` builds the NSIS
installer on `windows-latest` for the same `v*` tag. tauri-action merges the
`windows-x86_64` updater artifacts (the setup executable and its `.sig`)
into the same `latest.json` as the macOS and Linux jobs, so Windows clients
update through the existing `tauri-plugin-updater` channel with no updater
changes. The job does not configure a code-signing certificate, so CI
installers are unsigned.

## Release candidate gate

Run from a clean checkout on the release machine for the platform being
released. macOS (Apple Silicon release machine):

```sh
npm ci
npm run check            # vitest + tsc/vite build + cargo test
npm run test:e2e         # browser-shell E2E (headless Chromium)
npm run perf             # performance budgets (quit running instances first)
npm run tauri build -- --bundles app,dmg
./scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/Opus.app"
```

Expected (macOS): all automated tests and budgets PASS; the `.app` and
`.dmg` exist; with Developer ID credentials configured the verification
script reports a valid signature and passes Gatekeeper assessment, and
without them it labels the ad-hoc build `UNSIGNED` and skips Gatekeeper —
everything else is still verified. Then run the manual macOS
acceptance checklist in `docs/testing.md`.

Windows: the same gate with `npm run tauri build -- --bundles nsis` and no
bundle-verification script; the installer must exist in
`src-tauri/target/release/bundle/nsis/`, and an unsigned build's SmartScreen
warning on first run is expected. Then run the manual Windows acceptance
checklist in `docs/testing.md`.

**Local ad-hoc note:** without `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE`, Tauri skips
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
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/opus-updater.key` (the whole minisign secret key file). Required — without it the updater channel breaks. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty for the password-less key; the workflow passes through an empty value when this secret is unset. |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Optional. Base64-encoded Developer ID `.p12` certificate and its export password. Only needed for a signed macOS release from GitHub's hosted macOS runner. |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Optional. Apple ID, app-specific password, and team ID for notarization. |

Export a **Developer ID Application** certificate together with its private
key from Keychain Access as a password-protected `.p12`, then base64-encode it
for `APPLE_CERTIFICATE` (`openssl base64 -A -in certificate.p12`). Add the five
Apple values as repository Actions secrets, never as committed files or chat
messages. See the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/)
for certificate export and notarization setup.

The release workflow requires only the updater key. Its first macOS step
counts the Apple secrets: with all five configured it exports them to
`$GITHUB_ENV` and the build is Developer ID signed and notarized; with none
it ships unsigned and the job appends the unsigned-build install note to the
release notes; a partially configured set fails the job before building,
because a signed-but-unnotarized app is still blocked by Gatekeeper. The
variables must be **absent**, not empty, in unsigned mode — an
empty-but-present `APPLE_CERTIFICATE` makes the bundler attempt a keychain
import (`security import`) and fail. A hosted runner does not have the
release machine's keychain certificate, so an identity name alone cannot
sign its app — Tauri infers the identity from the supplied certificate.

### Publishing a release

Push a `v*` tag. Five jobs run in a fixed order, and only the last one makes
the release public:

1. `prepare-release` creates the tag's release **once**, as a draft, with
   auto-generated release notes. It is the only writer of the release object
   itself, which is what keeps the platform jobs from racing each other (see
   the tag-push checklist below).
2. `release` (macOS), `release-linux` and `release-windows` then build in
   parallel, each starting only after step 1, and upload their artifacts into
   that draft: the Darwin `app,dmg` bundles after `npm run check`, the Linux
   AppImage (with `NO_STRIP=1`), the Windows NSIS installer. Because
   `createUpdaterArtifacts` is enabled in `tauri.conf.json`, they also upload
   the updater artifacts (`Opus_aarch64.app.tar.gz`, `Opus_*_amd64.AppImage`,
   `Opus_*_x64-setup.exe`, each with its `.sig` signature) and merge their
   platform entries into `latest.json`.
3. `publish-release` runs only after all three platform jobs succeeded, and
   publishes the draft.

Until step 3 finishes, `/releases/latest` still resolves to the previous
release, so the Releases page never shows an empty or half-uploaded release
and the updater never polls a `latest.json` that is missing a platform.

```sh
git tag v0.2.0
git push origin v0.2.0
```

`latest.json` is served from the release's `latest/download` URL, so the
most recent tagged release automatically becomes the update target for all
existing installs.

## Tag-push checklist (learned from past CI failures)

A failed release run no longer means deleting and re-pushing the tag:
`prepare-release` creates the release as a draft, so re-running the failed
jobs (`gh run rerun <id> --failed`) resumes into that same draft — re-tag
only when `prepare-release` itself failed (nothing was built yet). Still,
verify these **before** pushing any `v*` tag — every item below is a failure
that has actually happened:

- **Run the exact CI gate, not pieces of it**: `npm run check` (vitest +
  `tsc -b` + vite build + cargo test). Vitest uses esbuild and never
  type-checks, so a type error in a `*.test.ts` file passes `npm test`
  locally and fails CI (v0.1.7 first attempt). After editing any test file,
  `npx tsc -b` is mandatory.
- **No focus- or timing-dependent test assertions**: `user.keyboard(...)`
  and anything reading `document.activeElement` depends on global focus and
  flakes under CI parallel load even when it passes locally every time
  (v0.1.9 first attempt). Assert through the element itself
  (`fireEvent.keyDown(el, ...)`, `fireEvent.blur(el)`) instead. When a test
  involving focus/timing was added or changed, repeat-run the touched spec
  (`for i in ...; npx vitest run <spec>`) before tagging.
- **Watch the run to completion**: `gh run list --workflow=release.yml`
  then poll until `completed`; on failure read
  `gh run view <id> --log-failed` before retrying — never re-push a tag
  blind. A re-tag moves the tag: `git tag -d vX && git push origin
  :refs/tags/vX && git tag vX && git push origin vX` (check first with
  `gh release view vX`, which finds drafts too, whether a release was
  already created; a rerun reuses an existing release and overwrites its
  assets, so a leftover draft needs no cleanup unless you want it gone —
  `gh release delete vX`).
- **Never let two jobs create the release** (v0.1.16, run 34672533046):
  `tauri-action` resolves the release as "look the release up by `tagName`,
  create one when the lookup 404s", and that pair is not atomic. Two
  platform jobs that both observe "no release yet" cost the loser its whole
  job with
  `##[error]Validation Failed: {"resource":"Release","code":"already_exists","field":"tag_name"}` —
  in that run the macOS job's lookup came back empty at 04:24:33.18, the
  release was created in the same second by another platform job, and the
  macOS job's create collided 0.6 s later;
  `gh run rerun 34672533046 --failed` was the only way out. The workflow now
  creates the release once in `prepare-release`, before any build starts, and
  every `tauri-action` step runs with `releaseDraft: true`, because with
  `releaseDraft: false` the action looks the release up with
  `GET /repos/{owner}/{repo}/releases/tags/{tag}`, which only ever returns
  *published* releases (drafts come back from the release list, which is what
  the action scans in draft mode). Keep that pairing when you add another
  platform job: `needs: prepare-release` plus `releaseDraft: true`.
- **A failed platform job leaves the release a draft** — by design, so that
  the updater keeps serving the previous, complete release. Fix the failure
  and re-run; if `gh run rerun <run-id> --failed` does not bring
  `publish-release` back (skipped jobs are not always part of a partial
  re-run), either re-run all jobs or publish by hand once every platform's
  assets are there: check with `gh release view vX --json assets`, then
  `gh release edit vX --draft=false`. Publishing makes the release the
  updater's `latest` target, and the publish step warns if it does not, so
  never publish before the macOS, Linux and Windows assets have all landed.
- **GitHub API hiccups are not build failures**: an `EOF`/5xx from
  `gh run watch` means the network call broke, not the build — re-check the
  run status before assuming anything.
