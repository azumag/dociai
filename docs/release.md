# Release process (#74)

Parent: #44. Depends on #72 (electron-builder packaging), #73 (macOS/Windows code signing +
notarization). This documents `.github/workflows/release.yml`, the three
`scripts/release/{validate-version-tag,generate-release-notes,publish-manifest}.mjs` scripts it
runs, and the tag/rollback/redistribution procedure — plus, like `docs/signing.md`, exactly what
has and has not been exercised against a real GitHub Actions run in this repository's development
sandbox (see "What is verified, and how" at the bottom before trusting any claim about an actual
tag push or `gh release create` having run).

## Overview

```
git push origin vX.Y.Z
  -> .github/workflows/release.yml
       validate-tag   (ubuntu-latest, cheap, fails fast)
         - scripts/release/validate-version-tag.mjs: tag vX.Y.Z must equal package.json's
           "version" field exactly, or the run fails before anything else happens.
         - classifies the release channel (stable vs beta) from the tag itself.
         - requires MACOS_CERTIFICATE_P12_BASE64 and WINDOWS_CERTIFICATE_PFX_BASE64 to both be
           set as repository secrets, or the run fails here — a release must never publish an
           unsigned artifact (contrast package.yml's PR path, which is *designed* to build
           unsigned when secrets are absent).
       package        (workflow_call into .github/workflows/package.yml, unchanged job bodies)
         - the exact same package-macos/package-windows jobs #72/#73 already run on every PR,
           reused via `uses: ./.github/workflows/package.yml` so this file never duplicates their
           steps. Called with `channel: stable|beta` (embedded into BuildInfo) and
           `upload_packages: true` (uploads the real .zip artifacts, which ordinary PR/push runs
           skip to save storage).
       publish        (ubuntu-latest)
         - downloads every package-*-manifest-*/package-*-artifacts-* artifact from this same
           workflow run.
         - scripts/release/publish-manifest.mjs: merges the per-platform release-manifest.json
           files, confirms mac-arm64 + mac-x64 + win-x64 are all present with matching real-file
           checksums, and only then writes publish-manifest.json + SHA256SUMS. Any missing target
           or checksum mismatch stops here with nothing written and nothing published.
         - scripts/release/generate-release-notes.mjs: Markdown release notes from the real commit
           log since the previous tag (or full history, for a first release), plus a "## Manual
           notes" heading left for a human to fill in before/after publishing.
         - `gh release create` uploads publish-manifest.json, SHA256SUMS, and every verified
           platform artifact, marking the release `--prerelease` when the channel is beta.
```

`workflow_dispatch` is also supported, taking a required `tag` input (rather than relying on
whichever branch the manual run happens to be dispatched from) so a release can be re-run for an
already-pushed tag without pushing anything new.

## Channel determination (stable vs beta)

Implemented in `scripts/release/validate-version-tag.mjs`'s `classifyChannel()`:

| Tag | package.json version | Channel |
| --- | --- | --- |
| `v1.2.3` | `1.2.3` | `stable` |
| `v1.2.3-beta.1` | `1.2.3-beta.1` | `beta` |
| `v1.2.3-rc.1` | `1.2.3-rc.1` | `beta` (there is currently one prerelease channel; splitting `rc` into its own channel is straightforward future work if the release process ever needs it) |

A tag with **no** prerelease suffix is `stable`; a tag with **any** prerelease suffix is `beta`.
The tag's version (after stripping the required `v` prefix) must match `package.json`'s
`"version"` field **exactly** — a `v1.2.3-beta.1` tag against a `package.json` that still says
`"1.2.3"` fails validation, and so does the reverse. This forces the version bump to happen in the
same commit/PR that will be tagged, rather than drifting.

The resolved channel is embedded into every packaged artifact's `build-info.json` via
`DOCIAI_RELEASE_CHANNEL` (see `scripts/release/build-info.mjs`'s `resolveChannel()`) — the running
app can tell a stable build from a beta build. It also controls whether `gh release create` passes
`--prerelease`.

## Manifest integrity ("release upload前に全targetのmanifest整合を検証")

`scripts/release/publish-manifest.mjs` requires exactly these three targets before it will write
anything:

- `mac/arm64`
- `mac/x64`
- `win/x64`

For each, it locates the artifact file and its `.sha256` sidecar anywhere under the downloaded
artifacts root, and independently recomputes the file's real SHA-256 — which must match **both**
the value recorded in `release-manifest.json` (from #72's `generate-checksums.mjs`, produced
per-platform during packaging) **and** the sidecar file's own content. A single missing file,
missing checksum, or any mismatch between "what the manifest says", "what the sidecar says", and
"what the file actually hashes to" fails the whole `publish-manifest.mjs` run with a non-zero exit
code and writes **nothing** — no stale or partial `publish-manifest.json`/`SHA256SUMS` is ever left
behind for a subsequent step to accidentally upload. This is the concrete implementation of "失敗
releaseが部分的なstable配布を残さない": the `gh release create` step never runs at all unless this
check passed for every required target in the same run.

The resulting `publish-manifest.json` also records `signed: true/false` per target. As of this
issue, reaching the `publish` job already guarantees signing occurred (see "Overview" above), so
today's release.yml always writes `true` there — the field exists so a manifest is
self-documenting on its own, without cross-referencing which workflow run produced it, satisfying
this issue's "version、commit SHA、checksum、署名状態をmanifestで確認できる" acceptance criterion.

## Release notes

`scripts/release/generate-release-notes.mjs <version> <toRef> <repoSlug>` shells out to `git
describe`/`git log` to find the previous release tag (or falls back to "first release, no previous
tag" when none exists yet) and lists every commit subject in the range plus every `#NNN` number it
finds in those subjects (this repo's squash-merge convention writes both `feat: ... (#150)` and
`Merge pull request #154 from ...`, and a single regex over the commit subject catches both). The
generated Markdown always ends with a `## Manual notes` heading and placeholder text — release.yml
does not require anyone to fill it in before publishing (the GitHub Release is created with the
auto-generated notes as-is), but it is the designated place to hand-edit highlights, breaking
changes, or upgrade guidance after the fact via `gh release edit <tag> --notes-file <file>` or the
GitHub UI, without losing the auto-generated commit list.

## Failure diagnostics

If the `publish` job's `gh release create` step fails partway, its captured stdout/stderr is
scrubbed with `scripts/release/redact-log.mjs` (reusing `signing-credentials.mjs`'s
`redactSecrets()` from #73, rather than a new scrubbing implementation) before being uploaded as a
`release-publish-diagnostics-<run-id>` artifact (14-day retention, same pattern as
`ci.yml`/`package.yml`'s own failure-diagnostics uploads).

## Interrupted release, re-run, and existing tag/artifact handling

- **Re-running the workflow for a tag that already has a GitHub Release** (workflow re-run, or a
  fresh run because the same tag was deleted and re-pushed): the `publish` job checks `gh release
  view <tag>` first. If a release already exists, it is deleted (`gh release delete <tag> --yes
  --cleanup-tag=false`, which leaves the git tag itself untouched) and recreated from scratch using
  only the artifacts this run just verified. This guarantees at most one GitHub Release per tag,
  and that release always reflects the most recent successfully-verified run — never a mix of an
  old run's assets and a new run's notes, or vice versa.
- **A run that fails before `publish`** (e.g. `validate-tag` rejects the tag, or a
  `package-macos`/`package-windows` job fails) never reaches `gh release create` at all — no
  partial GitHub Release is created. `actions/upload-artifact`'s `overwrite: true` (set on every
  manifest/artifact upload in `package.yml`) means re-running the same workflow run's failed jobs
  does not itself fail on "artifact already exists".
- **`concurrency`** is scoped per-tag (`dociai-release-${{ github.workflow }}-<tag or ref>`) with
  `cancel-in-progress: false` — a second run for the *same* tag queues behind the first rather than
  racing it or cancelling it mid-publish; two different tags never contend with each other.
- **A tag pushed with the wrong version** never gets past `validate-tag` (see "Channel
  determination" above) — no package/publish work happens for it at all.

## Auto-update (macOS)

The macOS build auto-updates via `electron-updater`, reusing this same tag-triggered release
pipeline as its update feed — no separate infrastructure. See
`electron/main/services/update/update-service.ts`'s header comment for the in-app mechanics
(check/download/install gating, broadcast-safety UX) and `electron-builder.yml`'s `publish:` block
for why `package.yml`'s build step never itself talks to GitHub (`--publish never` — only this
workflow's own `gh release create` step, below, ever uploads anything).

- **Windows has no auto-update yet.** `win.target` is `zip` only (no NSIS installer), so no
  `latest.yml` is ever produced for it; a Windows install stays a manual re-download until a
  follow-up adds the NSIS target (see that change's own PR for why this was deliberately deferred —
  in short, no Windows signing certificate exists yet either, and NSIS needs
  `publish-manifest.mjs`'s `REQUIRED_TARGETS` check reworked to handle more than one artifact per
  platform/arch first).
- **Dormant until signing exists.** `validate-tag`'s "Require signing credentials for release" gate
  (above) already refuses to publish any release at all without both signing secrets configured, so
  an unsigned build can never reach the update feed in the first place — no separate feature-flag
  is needed to keep auto-update off until signing lands. Once it does, treat the GitHub repo/Actions
  pipeline itself as part of the trust boundary: anyone who can push a `v*` tag or forge a release
  asset can ship code that auto-installs onto every user's machine. macOS code signing +
  notarization (`docs/signing.md`) is what lets Gatekeeper/Squirrel.Mac refuse a tampered update
  after the fact; there is no equivalent check today if the release pipeline's own credentials were
  compromised upstream of signing.
- **Manual end-to-end verification** (not CI-automatable — it needs two real, consecutively
  published GitHub Releases): once signing secrets are configured, publish `v0.0.x-beta.1`, install
  it locally, then publish `v0.0.x-beta.2` and confirm the running `beta.1` app detects, downloads,
  and (after an explicit "restart and install" click) installs `beta.2`. The beta channel exists
  exactly for this — it never affects `stable`-channel users, so this is safe to do against this
  repo's real release feed rather than only in an isolated fixture.

## Rollback and redistribution of a previous version

Auto-update clients never downgrade — they only ever offer/install a version newer than the one
currently running. So on a build with auto-update wired (macOS, once signing exists — see above),
"rollback" for an already-installed app means publishing a *new*, higher version that reverts the
regression, not un-publishing the bad one. Un-publishing (below) still matters for stopping *new*
installs/manual downloads of the bad version, and for Windows (no auto-update yet, so
republishing-as-the-recommended-download, below, is still how a fresh install gets the good
version).

1. **The previous version's GitHub Release still exists** (this workflow never deletes a release
   for a *different* tag): point users back at it directly — its assets, `publish-manifest.json`,
   and `SHA256SUMS` are exactly what shipped for that version, unchanged.
2. **The previous version's release was deleted or needs to be reproduced**: re-run this workflow
   against the previous tag via `workflow_dispatch` with that tag as the `tag` input (or, if the
   tag itself was also deleted, re-create the tag at the same commit — `git tag vX.Y.Z
   <old-commit-sha> && git push origin vX.Y.Z` — before dispatching). `validate-version-tag.mjs`
   only checks that the tag matches `package.json`'s version *at the commit the tag points to*, so
   this reproduces a byte-for-byte equivalent build (same source, same `gitSha` in the resulting
   manifest) rather than an approximation.
3. **A bad release needs to be pulled down entirely** (e.g. it shipped a broken build): `gh
   release delete vX.Y.Z --yes --cleanup-tag=false` removes the GitHub Release while leaving the
   tag itself in place (so `git tag -l` / the commit history stays intact, and the same tag can be
   re-released later once fixed) — do this manually rather than through this workflow, since
   release.yml only ever deletes a release it is about to *replace* for the same tag, never as a
   standalone "unpublish" operation.
4. If the break is a certificate/credential problem (wrong Team ID, revoked cert, etc.) rather than
   application code, see `docs/signing.md`'s own "Certificate rotation, revocation, and rollback"
   section — that document owns the signing-credential side of rollback, this document owns the
   release-artifact side.

## Testing this workflow

- **`workflow_dispatch` package**: `.github/workflows/package.yml`'s own `workflow_dispatch`
  trigger (unrelated to release.yml) already lets a maintainer manually run a package build on
  `main` without a tag; this issue does not change that trigger's behavior.
- **beta tag / stable tag**: exercised locally against `scripts/release/validate-version-tag.mjs`
  directly — see the PR description for real command output: `v0.1.0` against this repo's actual
  `package.json` (`ok: true, channel: "stable"`), and `v0.1.0-beta.1` against a fixture
  `package.json` whose version is itself `0.1.0-beta.1` (`ok: true, channel: "beta"` — a tag's
  prerelease suffix must match `package.json`'s exactly, not just its numeric core).
- **version不一致時に公開前失敗**: `validateVersionTag()`/`validateVersionTagForRepo()` are
  unit-tested with a tag version that does not match `package.json`, and the CLI is live-invoked
  with a real mismatched tag (`v9.9.9` against this repo's real `0.1.0`), producing a `FAIL` line
  and exit code 1.
- **target欠落時にrelease作成しない**: `scripts/release/publish-manifest.mjs` is unit-tested
  against fixture directory trees with a target's manifest entry missing, its artifact file
  missing, and its checksum sidecar corrupted — every case leaves `publish-manifest.json`/
  `SHA256SUMS` unwritten and returns a non-zero exit.
- **checksum/manifestと実file一致**: the same fixture tests recompute the real file's SHA-256 and
  assert it against both the manifest's recorded value and the sidecar file's own content.
- **release artifactからclean install smoke**: satisfied by reuse, not new code — `package.yml`'s
  `package-macos` job already runs `scripts/release/smoke-packaged.mjs` (#72) against the freshly
  packaged (and, when secrets are present, signed) app on every call to that workflow, including
  the one `release.yml` makes.

## What is verified, and how

This sandbox has no way to push a real git tag that triggers a real `.github/workflows/release.yml`
run against the real GitHub Actions/API, and — as established in `docs/signing.md` — no real
Apple/Windows signing credentials either. The distinction below is load-bearing.

**Live-verified in this environment** (see the PR description for the actual command output):

- `scripts/release/validate-version-tag.mjs` against real fixture tags: a tag matching this repo's
  actual `package.json` version (`v0.1.0`, exit 0), a version mismatch (`v9.9.9`, exit 1), a
  malformed tag (`not-a-tag`, exit 1), and beta/prerelease tags (`v0.1.0-beta.1`, classified
  `beta`) — both as unit tests and as direct CLI invocations with real process exit codes.
- `scripts/release/generate-release-notes.mjs` run against this actual repository's real `git
  log`: with no previous tag (this repo's real, current state — it has never cut a release),
  producing real Markdown listing 80+ real commits and 40+ real referenced issue/PR numbers pulled
  out of this repo's actual commit subjects; and, in a throwaway fixture git repository created and
  tagged for the test, correctly narrowing the commit range to only the commits after a real `git
  tag`.
- `scripts/release/publish-manifest.mjs` against fixture directory trees built to mirror exactly
  what `actions/download-artifact` produces from `package.yml`'s uploads: a complete tree (all
  three required targets present, checksums correct) publishes successfully with a correct
  `publish-manifest.json` and `SHA256SUMS`; a tree missing the Windows target, a tree missing only
  the Windows artifact *file* (manifest entry present, binary absent), and a tree with a corrupted
  checksum sidecar each fail cleanly and write nothing.
- `scripts/release/redact-log.mjs` against a fixture log file containing a repeated secret-like
  string, confirming every occurrence is replaced and the file is otherwise untouched when no
  configured secret is actually present.
- An end-to-end **local** dry run chaining `publish-manifest.mjs` (against a realistic fixture tree
  including two package-macos-style and one package-windows-style downloaded-artifact directories)
  → `generate-release-notes.mjs` (against this repo's real git history) → the same `find`/array
  shell logic `release.yml`'s `gh release create` step uses to collect assets — producing a
  correct, complete asset list, without ever invoking `gh` itself.
- `.github/workflows/package.yml` and `.github/workflows/release.yml` both parse as valid YAML
  (`js-yaml`), and every multi-line `run:` shell block in `release.yml` was extracted and checked
  with `bash -n`.

**Implemented to spec, but not exercisable in this sandbox** (no network path to the real GitHub
Actions/API, no macOS/Windows signing credentials, and pushing a real tag against this actual
repository is explicitly out of scope for this change — see the task description):

- An actual `git tag vX.Y.Z && git push --tags` triggering a real `release.yml` run on GitHub's
  infrastructure.
- The `package` job's `workflow_call` reuse of `package.yml` actually executing on
  `macos-latest`/`windows-latest` runners, including real signing/notarization succeeding and the
  new `upload_packages: true` / `channel` / `ref` inputs taking effect exactly as written.
- `actions/download-artifact` actually retrieving artifacts uploaded by a called reusable
  workflow's jobs within the same run (this is documented, standard `workflow_call` behavior, but
  has not been observed running here).
- An actual `gh release create`/`gh release delete` call against the real repository, including the
  "existing release for this tag gets deleted and recreated" re-run behavior.
- The `--prerelease` flag actually marking a real GitHub Release as a prerelease for a beta tag.
