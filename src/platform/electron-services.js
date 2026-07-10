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
