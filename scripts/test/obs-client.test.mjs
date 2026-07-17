import assert from "node:assert/strict";
import test from "node:test";
import { ObsClient } from "../../src/obs-client/obs-client.js";
import { createEnvelope } from "../../src/obs/obs-protocol.js";
import { connectionState } from "../../src/obs-client/obs-connection-state.js";

class FakeTransport { start(listener) { this.listener = listener; return true; } send(value) { (this.sent ??= []).push(value); return true; } stop() { return true; } }

test("OBS client handshakes, applies snapshot, and requests again after a gap", () => {
  const transport = new FakeTransport(); let now = 0; const statuses = [];
  const client = new ObsClient({ transport, clientId: "client-a", clock: () => now, onState: (value) => statuses.push(value) });
  client.start(); assert.equal(transport.sent.length, 2);
  transport.listener(createEnvelope("snapshot", { comment: { text: "latest" }, reply: null, speech: null }, { serverInstanceId: "server", generation: 1, sequence: 3, targetClientId: "client-a" }));
  assert.equal(client.snapshot.comment.text, "latest"); assert.deepEqual(statuses, ["connected"]);
  transport.listener(createEnvelope("state", { kind: "comment", text: "gap" }, { serverInstanceId: "server", generation: 1, sequence: 5 }));
  assert.equal(transport.sent.length, 4);
  client.heartbeat(); assert.equal(transport.sent.at(-1).type, "heartbeat");
  now = 6_000; client.tick(); assert.equal(client.status, "stale");
  client.tick(); assert.equal(client.status, "disconnected");
});

test("connection state preserves prior content during disconnect", () => {
  assert.equal(connectionState("connected", "timeout"), "stale");
  assert.equal(connectionState("waiting", "timeout"), "disconnected");
});

test("OBS client tracks a news-attribution state message the same way it tracks comment/reply/speech (issue #193)", () => {
  const transport = new FakeTransport();
  const client = new ObsClient({ transport, clientId: "client-b" });
  client.start();
  transport.listener(createEnvelope("snapshot", { comment: null, reply: null, speech: null, attribution: null }, { serverInstanceId: "server", generation: 1, sequence: 1, targetClientId: "client-b" }));
  assert.equal(client.snapshot.attribution, null);
  transport.listener(createEnvelope("state", { kind: "news-attribution", title: "見出し", attribution: [{ sourceName: "Example" }], time: 123 }, { serverInstanceId: "server", generation: 1, sequence: 2 }));
  assert.equal(client.snapshot.attribution.title, "見出し");
  assert.equal(client.snapshot.attribution.attribution[0].sourceName, "Example");
});
