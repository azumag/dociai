export class ElectronIpcTransport {
  constructor(api = globalThis.dociai?.obs) { this.api = api; this.unsubscribe = null; this.listener = null; }
  start(listener) { if (!this.api || this.unsubscribe) return false; this.listener = listener; this.unsubscribe = this.api.subscribe((message) => this.listener?.(message)); return true; }
  send(message) { return this.api?.send(message) === true; }
  stop() { if (!this.unsubscribe) return false; this.unsubscribe(); this.unsubscribe = null; this.listener = null; return true; }
  status() { return { connected: Boolean(this.unsubscribe), kind: "electron-ipc" }; }
}
