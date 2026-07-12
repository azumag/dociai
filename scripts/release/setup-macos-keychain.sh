#!/usr/bin/env bash
# setup-macos-keychain.sh (#73)
#
# Creates (or tears down) a CI-local, throwaway macOS keychain that holds the Developer ID
# Application certificate used to sign dociai's mac artifacts. electron-builder finds the
# identity itself via `CSC_IDENTITY_AUTO_DISCOVERY` (default on) once the keychain is on the
# user's keychain search list, so no CSC_LINK/CSC_KEY_PASSWORD env vars are needed for macOS —
# see docs/signing.md for why this differs from the Windows path (scripts/release/verify-windows
# -signing.ps1 / electron-builder.yml `win`), which has no OS-level keychain equivalent.
#
# Usage:
#   setup-macos-keychain.sh setup     # create keychain, import cert, add to search list
#   setup-macos-keychain.sh cleanup   # remove the keychain, restore the prior search list
#
# `setup` requires MACOS_CERTIFICATE_P12_BASE64 and MACOS_CERTIFICATE_PASSWORD. When either is
# unset (fork PR builds never receive repo secrets), `setup` prints a clear "SKIP" line and exits
# 0 — the caller proceeds to an unsigned electron-builder build rather than failing.
# `cleanup` is always safe to call even if `setup` was skipped or never ran: it no-ops.
#
# State is tracked in a small state file (default under $TMPDIR, override with
# DOCIAI_KEYCHAIN_STATE_FILE) so `cleanup` knows exactly what `setup` created/changed, without
# guessing from global keychain state.
set -euo pipefail

log() { printf '%s\n' "$1"; }

STATE_FILE="${DOCIAI_KEYCHAIN_STATE_FILE:-${TMPDIR:-/tmp}/dociai-macos-keychain-state}"
SEARCHLIST_FILE="${STATE_FILE}.searchlist"

usage() {
  echo "Usage: $0 {setup|cleanup}" >&2
  exit 2
}

current_search_list() {
  # `security list-keychains -d user` prints each entry quoted and indented, e.g.
  # `    "/Users/ci/Library/Keychains/login.keychain-db"`.
  security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"[[:space:]]*$/\1/'
}

cmd_setup() {
  if [ -f "$STATE_FILE" ]; then
    log "FAIL | setup-macos-keychain | state file already exists at $STATE_FILE; run cleanup first"
    exit 1
  fi

  if [ -z "${MACOS_CERTIFICATE_P12_BASE64:-}" ] || [ -z "${MACOS_CERTIFICATE_PASSWORD:-}" ]; then
    log "SKIP | setup-macos-keychain | MACOS_CERTIFICATE_P12_BASE64/MACOS_CERTIFICATE_PASSWORD not set (unsigned build fallback)"
    exit 0
  fi

  local keychain_dir keychain_path keychain_password cert_file
  keychain_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  keychain_path="${keychain_dir%/}/dociai-signing-$$.keychain-db"
  keychain_password="${MACOS_KEYCHAIN_PASSWORD:-$(openssl rand -base64 32)}"
  cert_file="$(mktemp "${TMPDIR:-/tmp}/dociai-cert-XXXXXX.p12")"

  # Decode the certificate to disk only for the moment `security import` needs it, then remove it
  # immediately — it must never survive past this function, workflow cache, or any artifact.
  if ! printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 -D -o "$cert_file" 2>/dev/null; then
    printf '%s' "$MACOS_CERTIFICATE_P12_BASE64" | base64 --decode -o "$cert_file"
  fi

  local cleanup_cert_file_on_error=1
  trap 'if [ "$cleanup_cert_file_on_error" = "1" ]; then rm -f "$cert_file"; fi' EXIT

  security create-keychain -p "$keychain_password" "$keychain_path"
  security set-keychain-settings -lut 21600 "$keychain_path"
  security unlock-keychain -p "$keychain_password" "$keychain_path"

  if ! security import "$cert_file" -k "$keychain_path" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -A; then
    rm -f "$cert_file"
    security delete-keychain "$keychain_path" 2>/dev/null || true
    log "FAIL | setup-macos-keychain | certificate import failed (see security's stderr above; no secret values were printed by this script)"
    exit 1
  fi
  rm -f "$cert_file"
  cleanup_cert_file_on_error=0
  trap - EXIT

  # Sierra+ requires this or codesign prompts interactively (which hangs CI) for the private key.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain_path" >/dev/null

  # Prepend our keychain to the search list so CSC_IDENTITY_AUTO_DISCOVERY finds it, and record the
  # prior list so cleanup can restore it exactly.
  current_search_list > "$SEARCHLIST_FILE"
  local existing=()
  while IFS= read -r line; do
    [ -n "$line" ] && existing+=("$line")
  done < "$SEARCHLIST_FILE"
  security list-keychains -d user -s "$keychain_path" "${existing[@]}"

  printf '%s\n' "$keychain_path" > "$STATE_FILE"

  local identity_count
  identity_count="$(security find-identity -v -p codesigning "$keychain_path" | grep -c 'Developer ID Application' || true)"
  log "PASS | setup-macos-keychain | temporary keychain created at $(basename "$keychain_path"), ${identity_count} 'Developer ID Application' identity(ies) imported"
}

cmd_cleanup() {
  if [ ! -f "$STATE_FILE" ]; then
    log "SKIP | setup-macos-keychain | no state file at $STATE_FILE (setup was skipped or never ran)"
    exit 0
  fi

  local keychain_path
  keychain_path="$(cat "$STATE_FILE")"

  if [ -f "$SEARCHLIST_FILE" ]; then
    local original=()
    while IFS= read -r line; do
      [ -n "$line" ] && original+=("$line")
    done < "$SEARCHLIST_FILE"
    if [ "${#original[@]}" -gt 0 ]; then
      security list-keychains -d user -s "${original[@]}"
    fi
  fi

  security delete-keychain "$keychain_path" 2>/dev/null || true
  rm -f "$STATE_FILE" "$SEARCHLIST_FILE"

  if [ -f "$keychain_path" ]; then
    log "FAIL | setup-macos-keychain | $keychain_path still exists after delete-keychain"
    exit 1
  fi
  if current_search_list | grep -qF "$keychain_path"; then
    log "FAIL | setup-macos-keychain | $keychain_path still on the keychain search list after cleanup"
    exit 1
  fi

  log "PASS | setup-macos-keychain | temporary keychain removed and search list restored"
}

case "${1:-}" in
  setup) cmd_setup ;;
  cleanup) cmd_cleanup ;;
  *) usage ;;
esac
