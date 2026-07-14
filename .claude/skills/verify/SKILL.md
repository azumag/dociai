---
name: verify
description: How to build, launch, and drive dociai's Electron app headlessly for end-to-end verification
---

# dociai Electron verification recipe

## Build

```
npm run electron:build
```

Produces `dist/electron/main.cjs` (+ preload, resources including `config.local.example.json`).

## Launch headless + drive with Puppeteer

Follow the pattern in `scripts/electron/smoke.mjs`. Key points:

- **`ELECTRON_SMOKE_NO_SANDBOX=1` env var is required in this environment**, or Electron fails
  to even start the renderer (`Cannot destructure property 'preloadScripts' of
  'binding.startupData' as it is null`). CI already sets this (see `.github/workflows/ci.yml`).
  Pass `--no-sandbox --disable-setuid-sandbox` to the electron args when this env var is `"1"`.
- Spawn `require("electron")` binary with args: `--remote-debugging-port=<port>`, `--headless`,
  `--user-data-dir=<dir>`, `dist/electron/main.cjs`.
- Connect via `puppeteer.connect({ browserURL: "http://127.0.0.1:<port>" })`, then find the page
  whose `.url()` includes `/index.html` (the console window; `obs.html` is the separate OBS window).
- Use a **fresh, unique `--user-data-dir`** per run unless you deliberately want to test restart
  persistence — reuse the same dir across two separate launches (kill the first, relaunch with the
  same dir) to verify state survives a real app restart, which is a real failure mode this app has
  had before (config that only loaded from a one-time seed file, not the persisted store).

## Waiting for boot to finish

The console window auto-loads config on boot (`src/app/boot.js`'s `boot()`). Poll
`#config-status` (`document.querySelector("#config-status").textContent`) until it no longer says
"未読込" — that's when `window.dociai`-backed IPC calls and the Settings UI (`#btn-settings`) are
usable. `getCurrent()` in `SettingsUI.open()` requires this to have already resolved.

## Driving the Settings UI

- Open: click `#btn-settings` (native `<dialog>`, opens via `showModal()`).
- Add a connector: click `.list-header .btn-add` on the (default-active) "connectors" tab. Only
  one tab's DOM exists at a time (`_body.replaceChildren()` on every tab switch), so this selector
  is unambiguous as long as the connectors tab is active.
- Fields use `data-config-path` as their DOM id/selector directly on the `<input>`, e.g.
  `[data-config-path="connectors.new_connector_1.apiKey"]`.
- **Gotcha**: right after adding a connector (which triggers a synchronous `#render()`), a bare
  `page.waitForSelector(...)` can resolve just before the element is actually stable/visible,
  and a subsequent `page.type()` can then fail with "No element found for selector" as flaky. Pass
  `{ visible: true }` to `waitForSelector` immediately before each `page.type()`/`page.click()` on
  a freshly-rendered field, don't just wait once up front.
- Apply/save button has no stable id — find it by text: `Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("保存して適用"))`.
- After a successful save the `<dialog>` closes (`dlg.open === false`) and no `.settings-error`
  elements remain; a failed save keeps the dialog open with `.settings-error` divs populated.
- The event/activity log is `#event-log` — useful for asserting on log text (e.g. absence of
  "405"/"Method not allowed", presence of "設定を読み込みました") without depending on exact DOM
  structure elsewhere.

## Inspecting Electron-side state directly

`window.dociai.config.get()` / `window.dociai.secrets.status([key])` can be called directly via
`page.evaluate()` to inspect the actual persisted state (`config.json` / `secrets.enc.json` under
the `--user-data-dir`) without going through the UI — useful to confirm what the UI flow actually
persisted, in addition to (not instead of) driving the real UI.

## Cleanup

Kill the spawned Electron child process (`child.kill()`, escalate to `SIGKILL` if it doesn't exit
within a few seconds) and `browser.close()`/`.disconnect()` in a `finally` block. Temp
`--user-data-dir` directories are safe to `rm -rf` once you're done (unless testing restart
persistence, in which case keep it between the two launches you're comparing).
