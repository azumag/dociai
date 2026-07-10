# CI contract

`.github/workflows/ci.yml` is the repository's credential-free required-check candidate. It runs on pull requests, pushes to `main`, and manual dispatches.

The jobs are intentionally independent so a Browser or Electron failure still produces its own diagnostics:

- `quality`: JavaScript syntax lint, Electron TypeScript check, unit tests, and scenario contract tests
- `browser-e2e`: managed Chromium with the isolated temporary workspace runner
- `electron-smoke`: unpacked Electron build, Console/Preload/OBS/security smoke, and shutdown cleanup

Only failure paths create `test-results` uploads. Logs are written through the shared redaction helper, screenshots are captured only for a failed Electron page, and artifact retention is 14 days.

After a short stabilization period, `quality`, `browser-e2e`, and `electron-smoke` are the required-check candidates. A maintainer should mark them required after 7–14 days of green pull-request runs and review any platform-specific flake before enabling branch protection.
