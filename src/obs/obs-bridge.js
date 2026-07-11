export class ObsBridge {
  constructor({ transport, getGeneration = () => 0, onError = () => {} }) { this.transport = transport; this.getGeneration = getGeneration; this.onError = onError; this.disposed = false; }
  publish(type, payload) {
    if (this.disposed) return false;
    try { this.transport.postMessage({ type, payload: { ...payload, generation: this.getGeneration() } }); return true; }
    catch (error) { this.onError(error); return false; }
  }
  dispose() { if (this.disposed) return false; this.disposed = true; this.transport.close?.(); return true; }
}
