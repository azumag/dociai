import assert from "node:assert/strict";
import test from "node:test";
import {
  OBS_PROTOCOL_VERSION,
  createEnvelope,
  evaluateSequence,
  validateEnvelope,
} from "../../src/obs/obs-protocol.js";
import { ObsClientRegistry } from "../../src/obs/obs-client-registry.js";
import { ObsSnapshotStore } from "../../src/obs/obs-snapshot-store.js";
import { commentStateEvent, replyStateEvent, speechStateEvent } from "../../src/obs/obs-state-events.js";

test("OBS protocol validates envelopes and rejects unsafe payloads", () => {
  const envelope = createEnvelope("state", { kind: "comment", author: "viewer", text: "hello" }, { serverInstanceId: "server-a", generation: 2, sequence: 3 });
  assert.equal(envelope.protocolVersion, OBS_PROTOCOL_VERSION);
  assert.equal(validateEnvelope(envelope).ok, true);
  assert.equal(validateEnvelope({ ...envelope, payload: { token: "secret" } }).ok, false);
  assert.equal(validateEnvelope({ ...envelope, payload: { text: "x".repeat(8_001) } }).ok, false);
});

test("sequence handling distinguishes duplicates, gaps, old generation, and server restarts", () => {
  const current = { serverInstanceId: "server-a", generation: 2, sequence: 4 };
  assert.equal(evaluateSequence(current, { ...current, sequence: 4 }), "duplicate");
  assert.equal(evaluateSequence(current, { ...current, sequence: 3 }), "out-of-order");
  assert.equal(evaluateSequence(current, { ...current, sequence: 6 }), "gap");
  assert.equal(evaluateSequence(current, { ...current, generation: 1, sequence: 9 }), "stale-generation");
  assert.equal(evaluateSequence(current, { ...current, generation: 3, sequence: 0 }), "new-generation");
  assert.equal(evaluateSequence(current, { ...current, serverInstanceId: "server-b", sequence: 0 }), "server-changed");
});

test("snapshot store is immutable, bounded, and resets sequence on generation changes", () => {
  const store = new ObsSnapshotStore({ serverInstanceId: "server-a", maxTextLength: 12 });
  const first = store.apply({ kind: "comment", author: "viewer", text: "a long comment that is clipped" }, 1);
  assert.equal(first.sequence, 1);
  assert.equal(first.comment.text, "a long comm…");
  assert.ok(Object.isFrozen(first));
  const reply = store.apply({ kind: "reply", personaName: "P", text: "answer", color: "#ff00aa" }, 1);
  assert.equal(reply.sequence, 2);
  assert.equal(reply.reply.personaName, "P");
  const next = store.apply({ kind: "speech", state: "speaking", personaName: "P" }, 2);
  assert.equal(next.generation, 2);
  assert.equal(next.sequence, 1);
  assert.equal(next.comment, null);
});

test("snapshot store tracks news-attribution the same way as comment/reply/speech, clips text, and clears it on a generation change (issue #193)", () => {
  const store = new ObsSnapshotStore({ serverInstanceId: "server-a", maxTextLength: 12 });
  const withAttribution = store.apply({
    kind: "news-attribution",
    title: "a very long headline that should be clipped",
    time: 500,
    attribution: [{ sourceName: "a very long source name", url: "https://example.com/x", licenseName: "CC BY 4.0", attributionRequired: true }],
  }, 1);
  assert.ok(Object.isFrozen(withAttribution.attribution));
  assert.ok(Object.isFrozen(withAttribution.attribution.attribution));
  assert.equal(withAttribution.attribution.title, "a very long…");
  assert.equal(withAttribution.attribution.attribution[0].sourceName, "a very long…");
  assert.equal(withAttribution.attribution.attribution[0].attributionRequired, true);

  const afterComment = store.apply({ kind: "comment", author: "viewer", text: "hi" }, 1);
  assert.ok(afterComment.attribution, "an unrelated kind on the same generation must not clear attribution");

  const afterGenerationChange = store.apply({ kind: "speech", state: "idle" }, 2);
  assert.equal(afterGenerationChange.attribution, null, "a generation change must clear attribution just like the other 3 fields");
});

test("client registry bounds clients and expires leases", () => {
  let now = 0;
  const clients = new ObsClientRegistry({ maxClients: 2, leaseMs: 10, clock: () => now });
  clients.hello("a"); clients.hello("b"); clients.hello("c");
  assert.deepEqual(clients.list().map((entry) => entry.id), ["b", "c"]);
  now = 11;
  assert.equal(clients.sweep(), 2);
  assert.equal(clients.list().length, 0);
});

test("state-event adapters expose only safe display fields", () => {
  assert.deepEqual(commentStateEvent({ author: "viewer", text: "hello", raw: { token: "secret" } }), { kind: "comment", author: "viewer", text: "hello", time: 0 });
  assert.deepEqual(replyStateEvent({ persona: { name: "P", apiKey: "secret" }, text: "answer", color: "#abcdef" }), { kind: "reply", personaName: "P", text: "answer", color: "#abcdef" });
  assert.deepEqual(speechStateEvent({ current: { personaName: "P" } }), { kind: "speech", state: "speaking", personaName: "P" });
});
