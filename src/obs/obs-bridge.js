import { ObsSnapshotStore } from "./obs-snapshot-store.js";

export class ObsBridge {
  constructor({ transport, getGeneration = () => 0, onError = () => {}, snapshotStore = new ObsSnapshotStore() }) {
    this.transport = transport;
    this.getGeneration = getGeneration;
    this.onError = onError;
    this.snapshotStore = snapshotStore;
    this.disposed = false;
  }
  publish(type, payload) {
    if (this.disposed) return false;
    try {
      const generation = this.getGeneration();
      this.snapshotStore.apply({ kind: type, ...payload }, generation);
      // #106で protocol envelope/handshake transportへ置換するまで、既存OBS Browser Sourceとのwire互換を維持する。
      this.transport.postMessage({ type, payload: { ...payload, generation } });
      return true;
    }
    catch (error) { this.onError(error); return false; }
  }
  snapshot() { return this.snapshotStore.getSnapshot(); }
  dispose() { if (this.disposed) return false; this.disposed = true; this.transport.close?.(); return true; }
}
