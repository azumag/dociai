import { ObsSnapshotStore } from "./obs-snapshot-store.js";
import { ObsClientRegistry } from "./obs-client-registry.js";
import { createEnvelope, validateEnvelope } from "./obs-protocol.js";

export class ObsBridge {
  constructor({ transport, getGeneration = () => 0, onError = () => {}, snapshotStore = new ObsSnapshotStore(), clients = new ObsClientRegistry() }) {
    this.transport = transport;
    this.getGeneration = getGeneration;
    this.onError = onError;
    this.snapshotStore = snapshotStore;
    this.clients = clients;
    this.disposed = false;
    if (this.transport) this.transport.onmessage = ({ data }) => this.receive(data);
  }
  publish(type, payload) {
    if (this.disposed) return false;
    try {
      const generation = this.getGeneration();
      this.snapshotStore.apply({ kind: type, ...payload }, generation);
      const snapshot = this.snapshot();
      // #106で protocol envelope/handshake transportへ置換するまで、既存OBS Browser Sourceとのwire互換を維持する。
      this.transport.postMessage({ type, payload: { ...payload, generation } });
      this.transport.postMessage(createEnvelope("state", { kind: type, ...payload }, snapshot));
      return true;
    }
    catch (error) { this.onError(error); return false; }
  }
  snapshot() { return this.snapshotStore.getSnapshot(); }
  receive(message) {
    if (this.disposed) return false;
    const valid = validateEnvelope(message);
    if (!valid.ok || !["hello", "snapshot-request", "heartbeat"].includes(message.type)) return false;
    const clientId = message.payload.clientId;
    if (typeof clientId !== "string" || !clientId) return false;
    this.clients.hello(clientId);
    if (message.type === "snapshot-request" || message.type === "hello") this.transport.postMessage(createEnvelope("snapshot", this.snapshot(), { ...this.snapshot(), targetClientId: clientId }));
    if (message.type === "heartbeat") this.transport.postMessage(createEnvelope("heartbeat", { clientId }, { ...this.snapshot(), targetClientId: clientId }));
    return true;
  }
  diagnostics() { return { clients: this.clients.list().length, snapshot: this.snapshot() }; }
  dispose() { if (this.disposed) return false; this.disposed = true; if (this.transport) this.transport.onmessage = null; this.transport.close?.(); return true; }
}
