// Issue #89: coverage for the Main-process bounded event bus (electron/main/services/stream-events/
// {stream-event-bus,stream-event-history,event-id-dedupe}.ts), built on top of the pure-JS
// contract/schemas covered separately by scripts/test/stream-events-schema.test.mjs. Follows the
// exact esbuild-bundle-then-node--test convention #75/#76/#83-#88 established (see e.g.
// scripts/test/capture-service.test.mjs / scripts/test/twitch-eventsub-reconnect.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

async function loadModules() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({
    stdin: {
      contents: [
        `export { StreamEventBus } from "./electron/main/services/stream-events/stream-event-bus.ts";`,
        `export { StreamEventHistory, DEFAULT_HISTORY_MAX_ENTRIES, DEFAULT_HISTORY_MAX_TOTAL_CHARS } from "./electron/main/services/stream-events/stream-event-history.ts";`,
        `export { EventIdDedupe, DEFAULT_EVENT_DEDUPE_TTL_MS, DEFAULT_EVENT_DEDUPE_MAX_ENTRIES } from "./electron/main/services/stream-events/event-id-dedupe.ts";`,
      ].join("\n"),
      resolveDir: root,
      sourcefile: "stream-event-bus-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-stream-event-bus-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

let sequence = 0;
function cheerEvent(overrides = {}) {
  sequence += 1;
  return {
    schemaVersion: 1,
    id: overrides.id ?? `evt-${sequence}`,
    kind: "cheer",
    timestamp: "2026-07-12T10:00:00.000Z",
    actor: { id: "user-1", displayName: "Alice", isAnonymous: false },
    channel: { id: "channel-1", displayName: "AliceChannel" },
    sourceMetadata: {},
    data: { bits: 100 },
    ...overrides,
  };
}

async function withModules(fn) {
  const { modules, directory } = await loadModules();
  try {
    await fn(modules);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("StreamEventBus publishes a valid event and delivers it to every subscriber", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus();
  const receivedByConsole = [];
  const receivedByObs = [];
  bus.subscribe((published) => receivedByConsole.push(published));
  bus.subscribe((published) => receivedByObs.push(published));

  const result = bus.publish(cheerEvent({ id: "evt-a" }));
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(receivedByConsole.length, 1);
  assert.equal(receivedByObs.length, 1);
  assert.equal(receivedByConsole[0].event.id, "evt-a");
  assert.equal(receivedByConsole[0].context, "production");
  assert.equal(typeof receivedByConsole[0].publishedAtMs, "number");
}));

test("StreamEventBus rejects an invalid event and never notifies subscribers", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus();
  const received = [];
  bus.subscribe((published) => received.push(published));

  const result = bus.publish({ schemaVersion: 1, id: "bad", kind: "cheer", timestamp: "not-a-date" });
  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
  assert.equal(received.length, 0);
  assert.equal(bus.stats.totalRejected, 1);
}));

test("StreamEventBus rejects (and never delivers) an event carrying a raw-payload-shaped field", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus();
  const received = [];
  bus.subscribe((published) => received.push(published));

  const smuggled = cheerEvent({ sourceMetadata: { rawPayload: { metadata: { subscription_type: "channel.cheer" }, payload: { bits: 500 } } } });
  const result = bus.publish(smuggled);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "forbidden.rawPayload"));
  assert.equal(received.length, 0, "a raw-payload-shaped event must never reach a subscriber");
}));

test("StreamEventBus publishes a duplicate event ID exactly once within the dedupe TTL window", () => withModules(async ({ StreamEventBus }) => {
  let now = 1_000;
  const bus = new StreamEventBus({ clock: () => now, dedupeTtlMs: 5_000 });
  const received = [];
  bus.subscribe((published) => received.push(published));

  const first = bus.publish(cheerEvent({ id: "evt-dup" }));
  assert.equal(first.ok, true);
  assert.equal(first.delivered, true);

  now += 1_000; // still within the 5s TTL window
  const second = bus.publish(cheerEvent({ id: "evt-dup" }));
  assert.equal(second.ok, true);
  assert.equal(second.delivered, false);
  assert.equal(second.duplicate, true);
  assert.equal(received.length, 1, "the duplicate must not be delivered to subscribers a second time");
  assert.equal(bus.stats.totalDuplicates, 1);

  now += 10_000; // past the TTL — the same id is a fresh delivery again
  const third = bus.publish(cheerEvent({ id: "evt-dup" }));
  assert.equal(third.delivered, true);
  assert.equal(received.length, 2);
}));

test("StreamEventBus listener exception isolation: one throwing listener does not block the others or crash publish", () => withModules(async ({ StreamEventBus }) => {
  const errors = [];
  const bus = new StreamEventBus({ onListenerError: (error, published) => errors.push({ error, eventId: published.event.id }) });
  const receivedA = [];
  const receivedC = [];
  bus.subscribe(() => receivedA.push(1));
  bus.subscribe(() => { throw new Error("listener B blew up"); });
  bus.subscribe((published) => receivedC.push(published));

  let result;
  assert.doesNotThrow(() => { result = bus.publish(cheerEvent({ id: "evt-isolation" })); });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(receivedA.length, 1, "listener A (subscribed before the throwing one) must still receive the event");
  assert.equal(receivedC.length, 1, "listener C (subscribed after the throwing one) must still receive the event");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.message, "listener B blew up");
  assert.equal(errors[0].eventId, "evt-isolation");
}));

test("StreamEventBus subscribe() returns an unsubscribe function that actually stops delivery", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus();
  const received = [];
  const unsubscribe = bus.subscribe((published) => received.push(published));

  bus.publish(cheerEvent({ id: "evt-before-unsub" }));
  assert.equal(received.length, 1);
  assert.equal(bus.listenerCount, 1);

  unsubscribe();
  assert.equal(bus.listenerCount, 0);
  bus.publish(cheerEvent({ id: "evt-after-unsub" }));
  assert.equal(received.length, 1, "no further events should be delivered after unsubscribe");

  // Idempotent: calling it again must not throw or affect other subscribers.
  assert.doesNotThrow(() => unsubscribe());
}));

test("StreamEventBus snapshot list() returns bounded, most-recent-last history", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus({ historyMaxEntries: 3 });
  for (let index = 0; index < 5; index += 1) bus.publish(cheerEvent({ id: `evt-${index}` }));
  const snapshot = bus.list();
  assert.equal(snapshot.length, 3);
  assert.deepEqual(snapshot.map((entry) => entry.event.id), ["evt-2", "evt-3", "evt-4"]);
}));

test("StreamEventBus tags simulation-context publishes distinctly from production, outside the StreamEvent payload", () => withModules(async ({ StreamEventBus }) => {
  const bus = new StreamEventBus();
  const received = [];
  bus.subscribe((published) => received.push(published));
  bus.publish(cheerEvent({ id: "evt-sim" }), "simulation");
  assert.equal(received[0].context, "simulation");
  assert.ok(!("context" in received[0].event), "context must never appear inside the StreamEvent payload itself");
}));

// -------------------------------------------------------------------------------------------
// StreamEventHistory — bounded by count AND by total character size independently.
// -------------------------------------------------------------------------------------------

test("StreamEventHistory trims by entry count once the limit is exceeded", () => withModules(async ({ StreamEventHistory }) => {
  const history = new StreamEventHistory({ maxEntries: 3, maxTotalChars: 1_000_000 });
  for (let index = 0; index < 10; index += 1) history.record(cheerEvent({ id: `evt-${index}` }), "production", 1_000 + index);
  assert.equal(history.size, 3);
  assert.deepEqual(history.list().map((entry) => entry.event.id), ["evt-7", "evt-8", "evt-9"]);
  assert.ok(history.stats.trimmedByCount >= 7);
}));

test("StreamEventHistory trims by total character size even when the entry-count limit is not reached", () => withModules(async ({ StreamEventHistory }) => {
  // Each recorded event's approximate JSON size is ~313 chars (fixed fields + a 50-char message);
  // a 1000-char budget comfortably fits 3 but not 4, so this proves the char-size bound trims
  // independently of maxEntries (which is set far higher and never binds here).
  const history = new StreamEventHistory({ maxEntries: 1_000, maxTotalChars: 1_000 });
  const message = "x".repeat(50);
  for (let index = 0; index < 10; index += 1) {
    history.record(cheerEvent({ id: `evt-${index}`, data: { bits: 100, message } }), "production", 1_000 + index);
  }
  assert.ok(history.size < 10, `expected trimming to have happened, but size was ${history.size}`);
  assert.ok(history.size >= 1, "the most recent entry must always survive");
  assert.ok(history.totalChars <= 1_000, `expected totalChars <= 1000, was ${history.totalChars}`);
  assert.ok(history.stats.trimmedByChars > 0);
  // The most recent entry must always survive.
  assert.equal(history.list().at(-1).event.id, "evt-9");
}));

test("StreamEventHistory never fully empties itself even when a single entry alone exceeds maxTotalChars", () => withModules(async ({ StreamEventHistory }) => {
  const history = new StreamEventHistory({ maxEntries: 1_000, maxTotalChars: 50 });
  history.record(cheerEvent({ id: "evt-huge", data: { bits: 100, message: "x".repeat(500) } }), "production", 1_000);
  assert.equal(history.size, 1, "a single oversized entry must still be retained, not evicted down to zero");
  history.record(cheerEvent({ id: "evt-huge-2", data: { bits: 100, message: "x".repeat(500) } }), "production", 1_001);
  assert.equal(history.size, 1, "the new oversized entry replaces the old one, never accumulating past 1");
  assert.equal(history.list()[0].event.id, "evt-huge-2");
}));

// -------------------------------------------------------------------------------------------
// EventIdDedupe — TTL/LRU bounded membership cache, independent of the bus.
// -------------------------------------------------------------------------------------------

test("EventIdDedupe.shouldDeliver is true only the first time within the TTL window", () => withModules(async ({ EventIdDedupe }) => {
  let now = 0;
  const dedupe = new EventIdDedupe({ clock: () => now, ttlMs: 1_000 });
  assert.equal(dedupe.shouldDeliver("evt-a"), true);
  assert.equal(dedupe.shouldDeliver("evt-a"), false);
  now += 1_001;
  assert.equal(dedupe.shouldDeliver("evt-a"), true, "after TTL expiry the same id is a fresh delivery again");
  assert.equal(dedupe.stats.duplicates, 1);
}));

test("EventIdDedupe is bounded by maxEntries via LRU eviction", () => withModules(async ({ EventIdDedupe }) => {
  const dedupe = new EventIdDedupe({ maxEntries: 2, ttlMs: 1_000_000 });
  assert.equal(dedupe.shouldDeliver("evt-1", 0), true);
  assert.equal(dedupe.shouldDeliver("evt-2", 1), true);
  assert.equal(dedupe.shouldDeliver("evt-3", 2), true); // evicts evt-1 (oldest lruSeq)
  assert.ok(dedupe.stats.size <= 2);
  assert.equal(dedupe.shouldDeliver("evt-1", 3), true, "evt-1 was evicted, so it is treated as new again");
  assert.ok(dedupe.stats.evictedByLimit > 0);
}));
