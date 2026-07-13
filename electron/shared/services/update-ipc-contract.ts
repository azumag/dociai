// Auto-update (macOS-only for now — see electron/main/services/update/update-service.ts's own
// header comment for why). Event DELIVERY reuses the generic `app:event` fan-out, same as
// STREAM_EVENT_APP_EVENT_TYPE/ai:token/shortcut:status — see stream-event-ipc-contract.ts's
// comment for the rationale. `renderer.events.subscribe(UPDATE_APP_EVENT_TYPE, cb)` receives every
// state transition below with zero preload changes needed.
export const UPDATE_APP_EVENT_TYPE = "update:status";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "not-available" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "downloaded"; version: string }
  | { phase: "error"; message: string };
