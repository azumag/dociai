// Issue #89: "Main bus→RendererのIPC境界（event配送channel名・snapshot API）は本issueで確定する".
//
// Decision: event DELIVERY reuses the already-established generic `app:event` fan-out
// (electron/shared/ipc-channels.ts's CHANNELS.APP_EVENT, `{ type, event }`, the same mechanism
// ai:token / shortcut:status / local-llm:download:progress already use via
// controller.emitToConsole/emitToObs — see electron/main/windows.ts) rather than a bespoke push
// channel. `STREAM_EVENT_APP_EVENT_TYPE` below is the `type` discriminant every published
// StreamEvent is forwarded under; `renderer.events.subscribe(STREAM_EVENT_APP_EVENT_TYPE, cb)`
// (electron/preload/index.ts's existing generic `events.subscribe`) receives every one of them
// with zero preload changes needed.
//
// SNAPSHOT is a real new invoke channel (CHANNELS.STREAM_EVENTS_LIST in ipc-channels.ts) — a
// freshly-opened console/OBS window calls it once to replay bounded history instead of only ever
// seeing events published from that moment on.
import type { StreamEvent } from "../../../src/stream-events/contract.js";

/** The `type` field every StreamEvent publish is forwarded to Renderer under, via the shared
 * `app:event` channel. */
export const STREAM_EVENT_APP_EVENT_TYPE = "stream-event";

export type StreamEventContext = "production" | "simulation";

/** Exactly what a Renderer receives per delivered event, both over the `app:event` push and inside
 * `streamEvents.list()`'s snapshot — the wrapper metadata (context/publishedAtMs) stays outside
 * the StreamEvent payload itself, per the issue's "production/simulation contextをwrapper
 * metadataで区別" requirement. */
export type PublishedStreamEvent = { context: StreamEventContext; publishedAtMs: number; event: StreamEvent };

export type StreamEventListInput = { limit?: number };

export type StreamEventBusSnapshotStats = {
  totalPublished: number;
  totalRejected: number;
  totalDuplicates: number;
  listenerCount: number;
};

export type StreamEventListResult = { events: PublishedStreamEvent[]; stats: StreamEventBusSnapshotStats };
