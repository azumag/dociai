// Electronではpreloadが公開した最小IPC APIだけを使う。Browser版は従来のconnectorを使う。
export function hasElectronAiService() {
  return typeof globalThis.dociai?.ai?.chat === "function";
}

export async function chatThroughElectron(input) {
  return globalThis.dociai.ai.chat(input);
}

export async function searchThroughElectron(input) {
  return globalThis.dociai.ai.search(input);
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

// issue #188: 記事本文取得はElectron Main process限定 (SSRF対策済みSafeHttpClient経由)。
// Browser版はこのcapability判定でarticle fetchをcapability-gateし、feed summaryへdegradeする。
export function hasElectronNewsArticleService() {
  return typeof globalThis.dociai?.newsArticles?.fetch === "function";
}

export async function fetchNewsArticleThroughElectron(input) {
  return globalThis.dociai.newsArticles.fetch(input);
}

export async function cancelElectronNewsArticleRequest(requestId) {
  return globalThis.dociai.newsArticles.cancel(requestId);
}

// issue #190: news検索(Google News RSS)とWikipedia調査もElectron Main限定 (fixed hostだけを
// SafeHttpClientで叩く)。
export function hasElectronNewsSearchService() {
  return typeof globalThis.dociai?.newsSearch?.query === "function";
}

export async function queryNewsSearchThroughElectron(input) {
  return globalThis.dociai.newsSearch.query(input);
}

export async function cancelElectronNewsSearchRequest(requestId) {
  return globalThis.dociai.newsSearch.cancel(requestId);
}

export function hasElectronWikipediaService() {
  return typeof globalThis.dociai?.wikipedia?.search === "function";
}

export async function searchWikipediaThroughElectron(input) {
  return globalThis.dociai.wikipedia.search(input);
}

export async function cancelElectronWikipediaRequest(requestId) {
  return globalThis.dociai.wikipedia.cancel(requestId);
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

// Auto-update (macOS-only for now — electron/main/services/update/update-service.ts). `dociai.update`
// always exists in Electron (it's part of DociaiApi), but is only ever functionally wired up (i.e.
// backed by a real electron-updater instance rather than an idle no-op) on a packaged macOS build —
// see UpdateService's own `enabled` guard. hasElectronUpdateService() only tells the renderer
// "the IPC surface exists" (Electron vs Browser); the UI itself must still handle every response
// staying at `{ phase: "idle" }` forever on platforms/builds where it's disabled.
export function hasElectronUpdateService() { return typeof globalThis.dociai?.update?.check === "function"; }
export async function checkForUpdateThroughElectron() { return globalThis.dociai.update.check(); }
export async function downloadUpdateThroughElectron() { return globalThis.dociai.update.download(); }
export async function quitAndInstallUpdateThroughElectron() { return globalThis.dociai.update.quitAndInstall(); }
// "update:status" is the same literal electron/shared/services/update-ipc-contract.ts's
// UPDATE_APP_EVENT_TYPE duplicates — see hasElectronStreamEventsService's own comment above for why
// this repo duplicates the string per call site instead of sharing a constant across the
// Renderer/Main boundary.
export function subscribeUpdateStatusThroughElectron(listener) { return globalThis.dociai.events.subscribe("update:status", listener); }

// Electron設定ストア (config.json in Main, safeStorage経由のsecrets) — hasElectronUpdateService()
// と同じ「IPC面の存在確認」+「そのまま呼ぶだけ」の流儀。ok/errorの分岐は呼び出し側 (boot.js) で行う。
export function hasElectronConfigService() { return typeof globalThis.dociai?.config?.get === "function"; }
export async function getConfigThroughElectron() { return globalThis.dociai.config.get(); }
export async function saveConfigThroughElectron(config, expectedRevision) {
  return globalThis.dociai.config.save({ config, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
}
export async function setSecretThroughElectron(key, value) { return globalThis.dociai.secrets.set({ key, value }); }

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
