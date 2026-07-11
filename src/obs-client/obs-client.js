import { createEnvelope, validateEnvelope } from "../obs/obs-protocol.js";
import { reduceObsMessage } from "./obs-reducer.js";
import { connectionState } from "./obs-connection-state.js";

export class ObsClient {
  constructor({ transport, clientId = crypto.randomUUID(), clock = () => Date.now(), handshakeTimeoutMs = 5_000, onState = () => {}, onSnapshot = () => {} } = {}) {
    this.transport = transport; this.clientId = clientId; this.clock = clock; this.handshakeTimeoutMs = handshakeTimeoutMs; this.onState = onState; this.onSnapshot = onSnapshot;
    this.status = "waiting"; this.snapshot = { serverInstanceId: null, generation: 0, sequence: 0, comment: null, reply: null, speech: null }; this.deadline = 0;
  }
  start() { this.transport.start((message) => this.receive(message)); this.requestSnapshot(); return true; }
  stop() { return this.transport.stop(); }
  requestSnapshot() { this.deadline = this.clock() + this.handshakeTimeoutMs; this.transport.send(createEnvelope("hello", { clientId: this.clientId }, { serverInstanceId: "client", targetClientId: null })); this.transport.send(createEnvelope("snapshot-request", { clientId: this.clientId }, { serverInstanceId: "client", targetClientId: null })); }
  receive(message) {
    const valid = validateEnvelope(message);
    if (!valid.ok) { this.setStatus(valid.reason === "protocol-version" ? "incompatible" : "error"); return; }
    if (message.targetClientId && message.targetClientId !== this.clientId) return;
    const reduced = reduceObsMessage(this.snapshot, message);
    if (["gap", "server-changed", "new-generation"].includes(reduced.verdict)) { this.requestSnapshot(); return; }
    if (reduced.verdict === "snapshot" || reduced.verdict === "next") { this.snapshot = reduced.state; this.deadline = this.clock() + this.handshakeTimeoutMs; this.setStatus("connected"); this.onSnapshot(this.snapshot); }
  }
  tick() { if (this.deadline && this.clock() > this.deadline) this.setStatus(connectionState(this.status, "timeout")); }
  setStatus(status) { if (this.status === status) return; this.status = status; this.onState(status); }
}
