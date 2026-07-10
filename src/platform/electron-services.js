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
