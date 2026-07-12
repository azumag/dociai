#!/usr/bin/env bash
# verify-macos-signing.sh (#73)
#
# Verifies a packaged .app bundle's code signature end to end:
#   1. `codesign --verify --deep --strict` on the bundle itself (catches any file added/changed
#      after signing — see docs/signing.md "package後にfileを書き換えない工程順").
#   2. Every Mach-O binary under Contents/ is individually signed (native modules under
#      Contents/Resources/native, #50/#73, are the ones most likely to be missed by accident).
#   3. The entitlements actually embedded in the signed binary match build/entitlements.mac.plist.
#   4. Gatekeeper assessment (`spctl --assess`) — only *required* to pass for a real Developer ID
#      signature; an ad-hoc signature (identity "-", used for local/dev verification and PR
#      smoke checks that have no certificate) is expected to fail spctl and is reported as
#      informational only, not a failure.
#
# Usage: verify-macos-signing.sh <path-to-app-bundle>
set -euo pipefail

log() { printf '%s\n' "$1"; }
fail() { printf 'FAIL | verify-macos-signing | %s\n' "$1" >&2; exit 1; }

APP_PATH="${1:-}"
[ -n "$APP_PATH" ] || { echo "Usage: $0 <path-to-app-bundle>" >&2; exit 2; }
[ -d "$APP_PATH" ] || fail "not a directory: $APP_PATH"

EXPECTED_ENTITLEMENTS="${DOCIAI_ENTITLEMENTS_FILE:-$(cd "$(dirname "$0")/../.." && pwd)/build/entitlements.mac.plist}"

log "INFO | verify-macos-signing | codesign --verify --deep --strict on $APP_PATH"
if ! codesign --verify --deep --strict --verbose=2 "$APP_PATH"; then
  fail "codesign --verify --deep --strict rejected $APP_PATH (see codesign's stderr above — a common cause is a file being added/changed after signing; see docs/signing.md 'package後にfileを書き換えない工程順')"
fi

log "INFO | verify-macos-signing | enumerating Mach-O binaries under Contents/"
UNSIGNED=()
while IFS= read -r -d '' binary; do
  if ! codesign --verify "$binary" >/dev/null 2>&1; then
    UNSIGNED+=("$binary")
  fi
done < <(find "$APP_PATH/Contents" -type f -perm -u+x -print0 2>/dev/null)

# find -perm -u+x also matches shell scripts/shebang files that are never Mach-O and were never
# meant to be codesigned; only fail on files `file` actually identifies as Mach-O.
REAL_UNSIGNED=()
for binary in "${UNSIGNED[@]-}"; do
  [ -n "$binary" ] || continue
  if file -b "$binary" | grep -q "Mach-O"; then
    REAL_UNSIGNED+=("$binary")
  fi
done

if [ "${#REAL_UNSIGNED[@]}" -gt 0 ]; then
  log "FAIL | verify-macos-signing | unsigned Mach-O binaries found:"
  for binary in "${REAL_UNSIGNED[@]}"; do
    log "  - $binary"
  done
  exit 1
fi
log "PASS | verify-macos-signing | all Mach-O binaries under Contents/ are individually signed"

log "INFO | verify-macos-signing | comparing embedded entitlements to $EXPECTED_ENTITLEMENTS"
ACTUAL_ENTITLEMENTS="$(mktemp)"
trap 'rm -f "$ACTUAL_ENTITLEMENTS"' EXIT
codesign -d --entitlements :"$ACTUAL_ENTITLEMENTS" "$APP_PATH" 2>/dev/null || true
if [ -f "$EXPECTED_ENTITLEMENTS" ] && [ -s "$ACTUAL_ENTITLEMENTS" ]; then
  MISSING_KEYS=0
  while IFS= read -r key; do
    # Plain substring match on the raw plist XML rather than `plutil -extract <key>`: entitlement
    # keys are always dotted (com.apple.security.*) and plutil's -extract keypath syntax treats
    # "." as a nesting separator, not a literal character, so it needs per-dot escaping to match a
    # real flat key — grepping the literal `<key>...</key>` tag sidesteps that entirely.
    if ! grep -qF "<key>${key}</key>" "$ACTUAL_ENTITLEMENTS"; then
      log "FAIL | verify-macos-signing | expected entitlement missing from signed binary: $key"
      MISSING_KEYS=1
    fi
  done < <(grep -o '<key>[^<]*</key>' "$EXPECTED_ENTITLEMENTS" | sed -E 's/<key>(.*)<\/key>/\1/')
  [ "$MISSING_KEYS" -eq 0 ] || exit 1
  log "PASS | verify-macos-signing | signed binary carries every entitlement key from $EXPECTED_ENTITLEMENTS"
else
  log "INFO | verify-macos-signing | no entitlements embedded (unsigned/no-identity build) — skipping entitlement comparison"
fi

IDENTITY_LINE="$(codesign -dv "$APP_PATH" 2>&1 | grep '^Authority=' | head -n1 || true)"
if [ -z "$IDENTITY_LINE" ]; then
  log "INFO | verify-macos-signing | ad-hoc signature (no Authority=) — Gatekeeper/spctl assessment is expected to reject this and is skipped"
elif echo "$IDENTITY_LINE" | grep -q "Developer ID Application"; then
  log "INFO | verify-macos-signing | Developer ID signature detected ($IDENTITY_LINE); running spctl assessment"
  if spctl --assess --type execute --verbose=4 "$APP_PATH"; then
    log "PASS | verify-macos-signing | spctl assessment passed (signature is notarized/stapled and trusted by Gatekeeper)"
  else
    fail "spctl assessment rejected a Developer ID-signed app; notarization/staple is likely missing or failed"
  fi
else
  log "INFO | verify-macos-signing | signed with a non-Developer-ID identity ($IDENTITY_LINE) — spctl assessment skipped"
fi

log "PASS | verify-macos-signing | $APP_PATH"
