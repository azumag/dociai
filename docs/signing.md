# Code signing & notarization (#73)

Parent: #44. Depends on #72 (electron-builder packaging, `docs/adr/electron-packager.md`).

This documents the macOS Developer ID signing/notarization and Windows Authenticode signing
pipeline layered on top of the #72 packager, plus what has and has not actually been exercised in
this repository's development sandbox (no real Apple Developer ID certificate, no Apple notary
service credentials, and no Windows code-signing certificate exist here — see
"What is verified, and how" at the bottom before trusting any claim in this document).

## macOS

### Hardened runtime & entitlements

`electron-builder.yml` sets `mac.hardenedRuntime: true` and points at two files under `build/`:

- `build/entitlements.mac.plist` — the main `dociai.app` bundle.
- `build/entitlements.mac.inherit.plist` — the Electron helper processes under
  `Contents/Frameworks` (Renderer/GPU/Plugin helpers), signed automatically with this file
  whenever a main entitlements file is present.

Both are kept minimal — every entitlement key widens what a compromised renderer/process can do,
so a key is only present because a real runtime path in this repo needs it:

| Key | Where | Why |
| --- | --- | --- |
| `com.apple.security.cs.allow-jit` | main + inherit | Electron/V8 crashes on launch under the hardened runtime without it. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | main + inherit | Same as above. |
| `com.apple.security.cs.disable-library-validation` | main + inherit | Native modules under `build/native` (#50, e.g. `node-llama-cpp`'s `.node`/`.dylib`) are codesigned by this pipeline but not Apple-notarized as libraries themselves; without this the hardened runtime refuses to `dlopen` them. |
| `com.apple.security.network.client` | main only | Outbound network access for the AI connectors, feeds, Twitch chat, OBS WebSocket, and speech backends (`electron/main/services/*`). |
| `com.apple.security.device.audio-input` | main only | `src/mic-monitor.js` calls `navigator.mediaDevices.getUserMedia({ audio: true })` for speech-triggered volume monitoring. Without this, packaged (non-dev) builds fail to acquire the microphone even with the Info.plist string below and the renderer-side permission policy (`electron/main/security/permissions.ts`) allowing it. |

Device/network entitlements are deliberately **not** duplicated onto the inherit file: TCC prompts
and hardened-runtime network checks are keyed to the top-level app's bundle identifier and code
signature, not to individual helper processes.

`electron-builder.yml`'s `mac.extendInfo` adds the matching Info.plist usage-description strings:

- `NSMicrophoneUsageDescription` — required alongside the audio-input entitlement above, or macOS
  simply kills the process instead of showing a permission prompt.
- `NSScreenCaptureUsageDescription` — added now as a forward-compatible hook only. Issue #117
  (desktopCapturer-based screen source selection) is not merged into `main` as of this issue; this
  Info.plist string is inert until something actually requests screen-recording access. Wiring the
  first-run "画面収録" permission guidance UI itself is left as a #117 follow-up once that
  renderer code lands — see the TODO comment beside it in `electron-builder.yml`.

### Signed-target inventory ("native helper/moduleを含む署名対象一覧を固定")

electron-builder (`@electron/osx-sign` under the hood) recursively codesigns every Mach-O binary
it finds under `Contents/` — the main executable, the three Electron helper `.app` bundles under
`Contents/Frameworks`, and everything under `Contents/Resources`, which includes
`extraResources` (`electron-builder.yml`'s `build/native` → `<resources>/native/`, #50/#73).
Nothing here is copied into the app bundle *after* signing (see "Build ordering" below), so there
is no separate "sign the native module too" step to remember — `scripts/release/verify-macos
-signing.sh` exists specifically to catch the case where that invariant is ever violated (a new
native binary lands in a path electron-builder doesn't walk, or gets added by a build step that
runs after signing).

### CI signing identity: temporary keychain (`scripts/release/setup-macos-keychain.sh`)

Decision: import the Developer ID Application certificate into a **CI-local temporary keychain**
that we create/populate/destroy ourselves, and let electron-builder's default
`CSC_IDENTITY_AUTO_DISCOVERY` find the identity there — rather than the `CSC_LINK`/
`CSC_KEY_PASSWORD` env-var flow electron-builder also supports for macOS (which would have it
create its own throwaway keychain internally). This gives us:

- explicit control over the keychain's timeout (`security set-keychain-settings -lut 21600`) and
  search-list placement,
- a cleanup step that runs and is verified independently of electron-builder's own process
  lifecycle (`if: always()` in CI, not tied to whether the build step succeeded),
- one script whose "did we actually create/destroy a keychain" logic is directly unit- and
  integration-testable without any Apple credentials (`scripts/test/release-setup-macos-keychain
  .test.mjs` exercises real `security create-keychain`/`import`/`delete-keychain` end to end
  against a locally-generated throwaway self-signed certificate).

```
scripts/release/setup-macos-keychain.sh setup     # create keychain, import cert, add to search list
scripts/release/setup-macos-keychain.sh cleanup   # remove keychain, restore prior search list
```

Required env for `setup`: `MACOS_CERTIFICATE_P12_BASE64` (base64-encoded `.p12`/`.pfx`),
`MACOS_CERTIFICATE_PASSWORD`. Optional: `MACOS_KEYCHAIN_PASSWORD` (random if unset).

**Fork PR fallback**: if either required var is unset, `setup` prints `SKIP | ...` and exits `0`
— it does not fail the build. `cleanup` is always safe to call, including when `setup` was never
run or was skipped: it no-ops with a `SKIP` line if its state file doesn't exist. The decoded
`.p12` file is deleted immediately after `security import` succeeds (or fails), so a certificate
file never survives past that one command, regardless of whether `cleanup` later runs.

electron-builder itself also degrades gracefully when no identity is found: `mac.hardenedRuntime`
does not force a hard failure, `mac.forceCodeSigning` is not set, so an unsigned `.app` is produced
and packaging continues (verified in `app-builder-lib`'s `macCodeSign.js`: `sign()` calls
`reportError()`, which only `throw`s when `isMas || isForceCodeSigning`; neither applies to this
repo's `zip` target).

### Notarization (`scripts/release/notarize.mjs`)

Wired as electron-builder's top-level `afterSign` hook. electron-builder's *built-in* notarize
step (`@electron/notarize`, auto-triggered by the same Apple env vars) is explicitly disabled via
`mac.notarize: false` in `electron-builder.yml` so notarization only happens once, through this
script, using Apple's own documented `xcrun notarytool`/`xcrun stapler` CLIs directly (not the
`@electron/notarize` Node wrapper) — this keeps the "did we skip, and why" decision inside code we
control and unit-test.

Credential resolution (`scripts/release/signing-credentials.mjs`,
`resolveMacNotarizationCredentials`) supports both of Apple's documented auth modes, preferring
the App Store Connect API key (long-lived, immune to 2FA/app-specific-password rotation):

1. `APPLE_API_KEY` (path to the `.p8` private key file), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
2. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

If neither set is complete, `notarizeAndStaple()` returns `{ status: "skipped", reason: "..." }`
and logs a clear `INFO | notarize | skipped: ...` line — it never throws for missing credentials.

This credential check is not a redundant belt-and-suspenders measure — it is the *only* thing
gating notarization. It would be reasonable to assume electron-builder only invokes the top-level
`afterSign` hook when a target was actually signed (`platformPackager.js`'s `doSignAfterPack` reads
`const didSign = await this.signApp(...); if (didSign) { await this.info.emitAfterSign(...) }`),
but live-testing an unsigned `npm run electron:package:dir` build against this repo's actual
`electron-builder@26.15.3` showed `notarize.mjs`'s `INFO | notarize | skipped: ...` line printed
even though electron-builder itself logged `skipped macOS application code signing` for the same
build (no identity found) — i.e. in this electron-builder version, `MacPackager.signApp()`
(`app-builder-lib/out/macPackager.js`) unconditionally `return`s `true` once it has *attempted* the
sign phase, regardless of whether an identity was actually found, so `didSign` does not mean "was
signed" and `afterSign` fires on every macOS packaging run. Do not rely on that electron-builder
behavior as a gate for anything security-sensitive (it may well change between versions in either
direction) — `resolveMacNotarizationCredentials()`'s explicit check is what actually matters, and
is exactly why it needs to be, and is, unit-tested directly.

When credentials are present, the flow is:

1. `ditto -c -k --keepParent <App>.app <tmp>.zip` (Apple's documented notarization zip format).
2. `xcrun notarytool submit <tmp>.zip --wait --output-format json` with the resolved auth args.
3. If `status !== "Accepted"`, best-effort fetch `xcrun notarytool log <submissionId>` for
   diagnostics and throw (this **does** fail the build — an app that failed notarization must not
   ship).
4. `xcrun stapler staple <App>.app`, then `xcrun stapler validate <App>.app`.

All child-process invocations are logged with secret values redacted first
(`redactSecrets()` in `signing-credentials.mjs`, applied to both the command line shown and any
captured stdout/stderr before it's ever logged or included in a thrown `Error` message).

### Verification (`scripts/release/verify-macos-signing.sh`)

```
scripts/release/verify-macos-signing.sh <path-to-App.app>
```

1. `codesign --verify --deep --strict --verbose=2` on the bundle — fails if anything was added or
   modified after signing.
2. Walks every executable file under `Contents/`, filters to ones `file(1)` identifies as Mach-O,
   and runs `codesign --verify` on each individually — this is the "native library署名漏れをCIで
   検出できる" acceptance criterion: a native binary electron-builder somehow didn't sign (or one
   added by a rogue post-sign step) fails the whole check.
3. Diffs the entitlement **keys** embedded in the signed binary (`codesign -d --entitlements`)
   against `build/entitlements.mac.plist`'s keys.
4. Gatekeeper assessment (`spctl --assess --type execute --verbose=4`) — only required to pass for
   a real `Developer ID Application` signature. An ad-hoc signature (`identity "-"`, what this repo
   can actually produce without a real certificate) has no `Authority=` line and is expected to
   fail `spctl`; the script detects this and reports it as informational, not a failure, so this
   same script is useful both in the credentialed CI path and for local/dev sanity checks.

## Windows

### Certificate injection decision

Windows has no OS-level "temporary keychain" primitive. electron-builder's Windows signer already
reads `CSC_LINK`/`CSC_KEY_PASSWORD` (or `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`) directly
(`app-builder-lib/out/winPackager.js`), where `CSC_LINK` may be a file path or (per electron-builder's
own convention) a base64-encoded certificate. Decision: the workflow decodes the
`WINDOWS_CERTIFICATE_PFX_BASE64` secret to a **workflow-local temporary `.pfx` file** and exports
`CSC_LINK=<path>` / `CSC_KEY_PASSWORD=<WINDOWS_CERTIFICATE_PASSWORD>` for the build step only, then
deletes the temp file in an `if: always()` step. No custom script is needed for this half — unlike
macOS there is no import/search-list/cleanup sequence to own.

`electron-builder.yml`'s `win.signtoolOptions` pins the hash algorithm and timestamp server
explicitly (both already match electron-builder's own defaults today — pinning protects against
that default silently changing in a future electron-builder upgrade):

```yaml
signtoolOptions:
  signingHashAlgorithms: [sha256]
  rfc3161TimeStampServer: http://timestamp.digicert.com
```

This signs the main `dociai.exe` and any native `.dll`s electron-builder finds inside the packaged
output, with an RFC3161 timestamp, before the `zip` artifact is produced (the current `win.target`
per #72; there is no NSIS/MSI installer target yet — adding one, and signing *that* installer
artifact specifically, is straightforward future work once #72's target list grows, since
electron-builder signs the same way regardless of final archive format).

**Fork PR fallback**: when `WINDOWS_CERTIFICATE_PFX_BASE64`/`WINDOWS_CERTIFICATE_PASSWORD` are
unset, the workflow step that decodes them is skipped (`if: env.WINDOWS_CERTIFICATE_PFX_BASE64 !=
''`), `CSC_LINK`/`CSC_KEY_PASSWORD` are never set, and electron-builder produces an unsigned
`.exe`/`.dll` without failing the build (`win.signtoolOptions.forceCodeSigning` is not set).

### Verification (`scripts/release/verify-windows-signing.ps1`)

```
pwsh scripts/release/verify-windows-signing.ps1 <path-to-exe-or-dll> [<path> ...]
```

Uses `Get-AuthenticodeSignature` (built into PowerShell — no extra install, works on every
`windows-latest` runner unconditionally) and asserts `Status -eq 'Valid'`, a `SignerCertificate` is
present, and a `TimeStamperCertificate` is present (no timestamp ⇒ the signature silently expires
the moment the signing certificate itself does). If `signtool.exe` (Windows SDK) happens to be on
`PATH`, `signtool verify /pa /v` is also run as an independent cross-check; its absence is only
logged (`INFO`), not treated as a failure, since not every runner image ships the SDK.

This script assumes its inputs were actually signed — the workflow only invokes it when the
Windows certificate secrets were present.

## Fork PR / no-credential fallback, summarized

| Layer | Behavior with no credentials |
| --- | --- |
| `scripts/release/setup-macos-keychain.sh setup` | Prints `SKIP`, exits 0. No keychain created. |
| electron-builder mac signing | No identity found ⇒ warns, produces an unsigned `.app`, does not throw. |
| `scripts/release/notarize.mjs` (`afterSign`) | Invoked regardless of whether the app was actually signed (live-verified — see above), but its own `resolveMacNotarizationCredentials()` check finds nothing and returns `{ status: "skipped", ... }` without throwing. |
| Windows `CSC_LINK`/`CSC_KEY_PASSWORD` | Never set ⇒ electron-builder produces an unsigned `.exe`/`.dll`, does not throw. |
| `scripts/release/verify-artifact.mjs`, `smoke-packaged.mjs` (#72) | Unaffected by signing status — they validate resource-tree contents and runtime behavior, not signatures, so they pass against unsigned PR builds. |

Every one of these paths is reachable purely by *absence* of GitHub Actions secrets, which is
exactly what a pull request from a fork sees (`pull_request`-triggered workflow runs never receive
repository secrets) — no separate "is this a fork" branch is required anywhere in this pipeline.

## Secret masking

`scripts/release/signing-credentials.mjs`'s `redactSecrets(text, secrets)` replaces every
occurrence of each known secret value with `***` before any command line, stdout, stderr, or
thrown `Error` message is logged from `notarize.mjs`. `scripts/release/setup-macos-keychain.sh`
never echoes `$MACOS_CERTIFICATE_P12_BASE64`, `$MACOS_CERTIFICATE_PASSWORD`, or the generated
keychain password to stdout/stderr at all (the only identity-related output is `security
find-identity`'s certificate *common name*, which is not secret — it's the same string shown in
Finder/Keychain Access). In `.github/workflows/package.yml`, every secret is also passed through
`::add-mask::` before use so GitHub's own log redaction covers it too, as defence in depth beyond
this repo's own masking.

## Build ordering ("package後にfileを書き換えない工程順を固定")

```
scripts/electron/build.mjs (dist/electron)
  → electron-builder pack
    → afterPack: scripts/release/after-pack.mjs   (rewrites build-info.json's platform/arch — #72)
    → codesign (mac) / signtool (win)              — content is now signed
    → afterSign: scripts/release/notarize.mjs      (mac only: notarize submit/wait, then staple)
  → scripts/release/generate-checksums.mjs          (sha256 + release-manifest.json over the final .zip)
```

Nothing after `codesign`/`signtool` rewrites file contents inside the signed bundle. Stapling
(step 4 above) attaches Apple's notarization ticket to the bundle but is explicitly designed by
Apple not to invalidate the code signature over it — `scripts/release/verify-macos-signing.sh`'s
`codesign --verify --deep --strict` check (run after stapling, in CI) is the enforcement point: if
any future change ever reordered a content-mutating step to run after signing, that check fails.

## Secrets reference

| Secret | Format | Used by |
| --- | --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | base64 of a Developer ID Application `.p12`/`.pfx` | `scripts/release/setup-macos-keychain.sh setup` |
| `MACOS_CERTIFICATE_PASSWORD` | plain string | `scripts/release/setup-macos-keychain.sh setup` |
| `MACOS_KEYCHAIN_PASSWORD` | plain string (optional; random if unset) | `scripts/release/setup-macos-keychain.sh setup` |
| `APPLE_API_KEY` | path/contents of an App Store Connect API `.p8` key | `scripts/release/notarize.mjs` |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | plain strings | `scripts/release/notarize.mjs` |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | plain strings (fallback auth mode) | `scripts/release/notarize.mjs` |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | base64 of a code-signing `.pfx` | `.github/workflows/package.yml` (decoded to `CSC_LINK`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | plain string | `.github/workflows/package.yml` (`CSC_KEY_PASSWORD`) |

## Certificate rotation, revocation, and rollback

**Rotation (planned, before expiry):**

1. Generate/renew the certificate through the Apple Developer or Windows code-signing CA portal.
2. Update the corresponding GitHub Actions repository secret(s) from the table above. Certificates
   are opaque blobs to this pipeline — no code change is required for a same-type rotation (e.g.
   Developer ID Application → a new Developer ID Application cert).
3. Run the `package-macos`/`package-windows` workflow once via `workflow_dispatch` on `main` before
   relying on it for a real release, and check the job logs for
   `INFO | signing-status | ...` (`scripts/release/print-signing-status.mjs`) plus a `PASS` from
   the relevant `verify-*-signing` script.
4. Notarization credentials (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` or the API key trio) rotate
   independently of the signing certificate itself and can be updated on their own schedule.

**Revocation / compromise response:**

1. Revoke the certificate immediately in the Apple Developer portal / with the Windows CA — this
   is the authoritative kill switch; nothing in this repository can un-trust an already-issued
   certificate on end-user machines faster than revocation does.
2. Delete or blank the corresponding GitHub secret(s) so the next CI run automatically falls back
   to the unsigned path documented above (no code change needed — this pipeline was built to
   degrade to "unsigned" by *absence* of secrets from day one).
3. Any already-shipped, already-installed artifact signed with the compromised certificate stays
   installed (OS revocation checking is opportunistic, not a forced uninstall) — treat this the
   same as any other credential-compromise incident: rotate, communicate, and if the update channel
   is live, ship a new signed release promptly. (This repo has no auto-update channel wired yet —
   `electron-builder.yml`'s `publish: null`, #72 — so "ship a new release" today means a fresh
   manual download.)

**Rollback (a new certificate breaks something, e.g. wrong Team ID / bad Windows Authenticode
timestamp server outage):**

1. Because signing/notarization are driven entirely by GitHub secrets and a `null` result is
   always a valid, tested outcome (the unsigned fallback), the immediate rollback is: delete/blank
   the newly-added secret(s), which reverts the very next CI run to the last-known-good behavior
   (unsigned, or whichever previous certificate's secret values you restore).
2. If the break is in this pipeline's *code* rather than the certificate (e.g. a bad
   `signtoolOptions` change), revert that commit — `electron-builder.yml`, `scripts/release
   /notarize.mjs`, and the two `verify-*-signing` scripts are the only files whose defects can
   plausibly break an otherwise-valid certificate's signing/notarization.

## What is verified, and how

This sandbox has **no real Apple Developer ID certificate, no Apple notary service credentials,
and no Windows code-signing certificate**. The distinction below is load-bearing — do not read
anything in this document as a claim that real notarization or real Windows signing has been
observed to work.

**Live-verified in this environment** (see the PR description for the actual command output):

- `build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` are well-formed plist
  XML (`plutil -lint`) and contain exactly the keys documented above.
- `codesign --sign -` (ad-hoc signing, no certificate required) applies
  `build/entitlements.mac.plist` to a real Mach-O binary without error, and `codesign --verify`
  passes against the ad-hoc-signed result.
- `scripts/release/setup-macos-keychain.sh setup`/`cleanup` against a real, locally-generated
  throwaway self-signed certificate: `security create-keychain`, `security import`, and `security
  delete-keychain` all genuinely run and are asserted (keychain file gone, search list restored).
- `scripts/release/setup-macos-keychain.sh setup` correctly prints `SKIP` and exits 0 when the
  required env vars are unset (the fork-PR path).
- `scripts/release/notarize.mjs`'s credential-detection returns a clean `{ status: "skipped" }`
  (never throws) with every combination of Apple env vars unset, and its `afterSign` default
  export no-ops immediately for `electronPlatformName !== "darwin"`.
- `scripts/release/verify-macos-signing.sh` against an ad-hoc-signed fixture bundle: passes the
  `codesign --verify --deep --strict` and per-binary Mach-O signature checks, correctly detects the
  ad-hoc signature (no `Authority=`) and skips the `spctl` assessment as informational rather than
  failing.
- An **unsigned** `electron-builder --dir` packaged build (`npm run electron:package:dir`, no
  signing secrets present at all) still passes `scripts/release/verify-artifact.mjs` and
  `scripts/release/smoke-packaged.mjs` unchanged from #72 — i.e. this issue's signing pipeline
  does not regress the credential-free PR build path.

**Implemented to the documented Apple/Microsoft CLI interfaces, but not exercisable in this
sandbox** (no credentials, no `xcrun notarytool` binary — this machine only has the Command Line
Tools, not full Xcode — and no Windows environment at all):

- A real Developer ID Application signature being trusted end-to-end.
- `xcrun notarytool submit --wait` actually submitting to Apple's notary service, and the
  subsequent `xcrun stapler staple`/`validate`.
- `spctl --assess` passing against a genuinely notarized, stapled app (only the ad-hoc/expected
  -rejection path above was observed).
- `.github/workflows/package.yml`'s `package-macos`/`package-windows` jobs actually running on
  GitHub-hosted `macos-latest`/`windows-latest` runners with real secrets configured.
- `scripts/release/verify-windows-signing.ps1` executing at all (no PowerShell available in this
  sandbox) — its `Get-AuthenticodeSignature`/`signtool` usage follows Microsoft's documented
  cmdlet/CLI interfaces but has only been checked for balanced syntax, not run.
- Real Windows Authenticode signing via `signtool.exe`/electron-builder's Windows signer.
