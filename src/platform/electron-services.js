// Electronではpreloadが公開した最小IPC APIだけを使う。Browser版は従来のconnectorを使う。
export function hasElectronAiService() {
  return typeof globalThis.dociai?.ai?.chat === "function";
}

export async function chatThroughElectron(input) {
  return globalThis.dociai.ai.chat(input);
}

export async function cancelElectronAiRequest(requestId) {
  return globalThis.dociai.ai.cancel(requestId);
}

export function hasElectronFeedService() {
  return typeof globalThis.dociai?.feeds?.fetch === "function";
}

export async function fetchFeedThroughElectron(input) {
  return globalThis.dociai.feeds.fetch(input);
}

export async function cancelElectronFeedRequest(requestId) {
  return globalThis.dociai.feeds.cancel(requestId);
}

export function hasElectronTopicService() {
  return typeof globalThis.dociai?.topics?.fetch === "function";
}

export async function fetchTopicsThroughElectron(input) {
  return globalThis.dociai.topics.fetch(input);
}

export async function completeTopicThroughElectron(input) {
  return globalThis.dociai.topics.complete(input);
}

export async function cancelElectronTopicRequest(requestId) {
  return globalThis.dociai.topics.cancel(requestId);
}

export function hasElectronVoiceVoxService() { return typeof globalThis.dociai?.speech?.voicevox?.synthesize === "function"; }
export async function synthesizeThroughElectron(input) { return globalThis.dociai.speech.voicevox.synthesize(input); }
export async function speakersThroughElectron(input) { return globalThis.dociai.speech.voicevox.speakers(input); }
export async function cancelElectronSpeechRequest(requestId) { return globalThis.dociai.speech.cancel(requestId); }
export function hasElectronTwitchService() { return typeof globalThis.dociai?.twitch?.start === "function"; }

// Issue #177: the Renderer-side capability check + live-push subscription for the Main-process
// StreamEventBus (#89) — reused by src/app/runtime-factory.js's `selectPlatformAdapter()` so the
// eventTriggerRunner component can react to REAL production StreamEvents the exact same way
// src/twitch-ui/history/event-history.js's own `EventHistoryView.connect()` already does (see that
// file's header comment for the identical "fetch snapshot once, then live-push" idiom this mirrors
// for triggering rather than display). `"stream-event"` is the SAME literal
// electron/shared/services/stream-event-ipc-contract.ts's `STREAM_EVENT_APP_EVENT_TYPE` and
// src/twitch-ui/twitch-ui-events.js's `STREAM_EVENT_TYPE` already duplicate — this repo's own
// established "duplicate the string per dociai.events.subscribe(type, ...) call site" convention
// (see twitch-ui-events.js's own header comment), not a new pattern.
export function hasElectronStreamEventsService() { return typeof globalThis.dociai?.streamEvents?.list === "function"; }
export function subscribeStreamEventsThroughElectron(listener) { return globalThis.dociai.events.subscribe("stream-event", listener); }

export class ElectronTwitchSource {
  id = "twitch"; label = "Twitch";
  constructor(config = {}, { onStatus = () => {} } = {}) { this.config = config; this.onStatus = onStatus; this.unsubComment = null; this.unsubStatus = null; this.status = { state: "idle", channels: [] }; }
  start(onComment) {
    this.unsubComment = globalThis.dociai.events.subscribe("twitch:comment", (comment) => onComment(comment));
    this.unsubStatus = globalThis.dociai.events.subscribe("twitch:status", (status) => { this.status = status; this.onStatus(status); });
    void globalThis.dociai.twitch.start(this.config).then((result) => { if (result?.ok) { this.status = result.value; this.onStatus(this.status); } });
  }
  stop() { this.unsubComment?.(); this.unsubStatus?.(); this.unsubComment = null; this.unsubStatus = null; return globalThis.dociai.twitch.stop(); }
  reconnectNow() { return globalThis.dociai.twitch.reconnect(); }
  snapshot() { return { ...this.status }; }
}
