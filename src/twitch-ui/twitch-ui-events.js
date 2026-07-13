// Renderer-side mirror of electron/shared/twitch/overview-contract.ts's event-type string
// constants. `src/*` is plain, un-bundled browser JS (loaded directly via <script type="module">;
// see index.html) and never imports the Electron-main-only `electron/shared/*.ts` sources, so these
// 4 literal strings are intentionally duplicated on both sides of the IPC boundary — the same
// pattern this repo already uses for every other `dociai.events.subscribe(type, ...)` call (e.g.
// "ai:token", "local-llm:download:progress"). Keep these in sync with overview-contract.ts.
export const TWITCH_AUTH_EVENT_TYPE = "twitch:auth:event";
export const TWITCH_CONNECTION_EVENT_TYPE = "twitch:connection:event";
export const TWITCH_SUBSCRIPTIONS_EVENT_TYPE = "twitch:subscriptions:event";
export const TWITCH_RECONNECT_DIAGNOSTIC_EVENT_TYPE = "twitch:reconnect:diagnostic";

// Issue #96: mirrors electron/shared/services/stream-event-ipc-contract.ts's own
// `STREAM_EVENT_APP_EVENT_TYPE` (#89) — the `type` discriminant every published StreamEvent (a
// real production event, forwarded from the Main-process StreamEventBus) is delivered under via
// the SAME generic `dociai.events.subscribe(type, cb)` mechanism the 4 constants above already use.
export const STREAM_EVENT_TYPE = "stream-event";
