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
