#!/usr/bin/env bash
# Verifies a packaged Opus macOS bundle without ever launching it.
#
#   scripts/verify-macos-bundle.sh path/to/Opus.app
#
# Checks:
#   1. the path ends in .app and is a real bundle;
#   2. codesign --verify --deep --strict passes;
#   3. entitlements are printed, and com.apple.security.app-sandbox is not
#      true (releases ship without the App Sandbox — docs/releasing.md);
#   4. release builds (Developer ID Application authority) pass Gatekeeper
#      assessment (spctl --assess --type execute), which also proves
#      notarization; ad-hoc/local signatures are labeled NON-RELEASE and
#      skip Gatekeeper; any other signing authority fails the check.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

APP_PATH="${1:-}"
[ -n "$APP_PATH" ] || fail "usage: $0 APP_PATH"

case "$APP_PATH" in
  *.app) ;;
  *) fail "path must end in .app: $APP_PATH" ;;
esac
[ -d "$APP_PATH" ] || fail "no such app bundle: $APP_PATH"
[ -d "$APP_PATH/Contents/MacOS" ] || fail "not a valid .app bundle (missing Contents/MacOS): $APP_PATH"

echo "==> codesign --verify --deep --strict --verbose=2"
codesign --verify --deep --strict --verbose=2 "$APP_PATH" \
  || fail "code signature verification failed"

ENTITLEMENTS="$(mktemp -t markdown-edit-entitlements)"
trap 'rm -f "$ENTITLEMENTS"' EXIT

echo "==> entitlements"
# NOTE: the `:-` (write to stdout) syntax is deprecated on recent macOS but
# remains the only form whose output PlistBuddy can read back below.
if codesign -d --entitlements :- "$APP_PATH" >"$ENTITLEMENTS" 2>/dev/null \
  && [ -s "$ENTITLEMENTS" ]; then
  cat "$ENTITLEMENTS"
  sandbox="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$ENTITLEMENTS" 2>/dev/null || true)"
  [ "$sandbox" = "true" ] \
    && fail "com.apple.security.app-sandbox is true; release builds must not enable the App Sandbox"
else
  echo "(no entitlements)"
fi

SIGNATURE_INFO="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 || true)"
if printf '%s\n' "$SIGNATURE_INFO" | grep -q '^Authority=Developer ID Application:'; then
  echo "==> Gatekeeper assessment (Developer ID signature detected)"
  spctl --assess --type execute --verbose=4 "$APP_PATH" \
    || fail "Gatekeeper assessment failed — notarize and staple the build first (docs/releasing.md)"
  echo "RELEASE: valid Developer ID signature; Gatekeeper assessment accepted (notarized)."
elif printf '%s\n' "$SIGNATURE_INFO" | grep -q '^Signature=adhoc'; then
  echo "NON-RELEASE: ad-hoc (local unsigned) build."
  echo "NON-RELEASE: skipping Gatekeeper assessment; do not distribute this build."
else
  # A signed-but-mis-signed bundle (self-signed, Apple Development, …) must
  # never slip through as NON-RELEASE — that path is only for ad-hoc builds.
  fail "signature is neither Developer ID Application nor ad-hoc; cannot classify this build"
fi

echo "OK: $APP_PATH"
