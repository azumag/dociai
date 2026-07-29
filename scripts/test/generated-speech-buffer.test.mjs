import assert from "node:assert/strict";
import test from "node:test";
import { BufferedReader, GeneratedSpeechBuffer } from "../../src/readers/generated-speech-buffer.js";

function makeReader(buffer, generated) {
  return {
    enabled: true,
    busy: false,
    calls: 0,
    async run(context) {
      this.calls++;
      assert.equal(context.maxItems, 1);
      const item = generated.shift();
      if (item) buffer.enqueue(item);
    },
    status: () => ({ enabled: true, busy: false }),
    retryNow: () => false,
    skip: () => false,
    restore: () => false,
  };
}

test("Generate buffers one generated item, and Play consumes it before starting one replenishment", async () => {
  const played = [];
  const state = { items: [] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { played.push(item); return { state: "waiting" }; } }, state });
  const reader = makeReader(buffer, [{ text: "first", source: "news" }, { text: "next", source: "news" }]);
  const buffered = new BufferedReader({ reader, buffer });

  await buffered.generate();
  assert.equal(buffered.status().bufferedCount, 1);
  assert.equal(reader.calls, 1);
  await buffered.run();
  await Promise.resolve();
  assert.deepEqual(played.map((item) => item.text), ["first"]);
  assert.equal(buffered.status().bufferedCount, 1, "Play starts a bounded replenishment after consuming the prepared item");
  assert.equal(reader.calls, 2);
});

test("Play generates then immediately consumes an empty buffer, whose state survives a runtime reload", async () => {
  const played = [];
  const state = { items: [] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { played.push(item); return { state: "waiting" }; } }, state });
  const reader = makeReader(buffer, [{ text: "generated-now", source: "topics" }]);
  await new BufferedReader({ reader, buffer }).run();
  assert.deepEqual(played.map((item) => item.text), ["generated-now"]);

  state.items.push({ text: "kept-across-reload", source: "topics" });
  const reloaded = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { played.push(item); return { state: "waiting" }; } }, state });
  assert.equal(reloaded.play().text, "kept-across-reload");
});

test("enqueue() drops a caller-supplied onDelivered closure and keeps only the plain deliveryPayload", () => {
  let calledAtEnqueueTime = 0;
  const state = { items: [] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: () => ({ state: "waiting" }) }, state });

  buffer.enqueue({ text: "held", source: "news", onDelivered: () => calledAtEnqueueTime++, deliveryPayload: { text: "held" } });
  assert.equal(calledAtEnqueueTime, 0, "buffering an item must not broadcast onRead/complete external side effects yet");
  assert.equal(state.items[0].onDelivered, undefined, "a caller's onDelivered closure must never be stored — see the buffer's own onDelivered below");
  assert.deepEqual(state.items[0].deliveryPayload, { text: "held" });
});

test("play() fires the BUFFER's own onDelivered (never the enqueue-time closure) with the item's deliveryPayload", () => {
  const delivered = [];
  const state = { items: [] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { item.onDelivered?.(); return { state: "waiting" }; } }, state, onDelivered: (payload) => delivered.push(payload) });

  buffer.enqueue({ text: "held", source: "news", onDelivered: () => { throw new Error("must never be called"); }, deliveryPayload: { text: "held" } });
  buffer.play();
  assert.deepEqual(delivered, [{ text: "held" }], "play() must fire the buffer's CURRENT onDelivered, not a closure captured at enqueue time");
});

// This is the actual bug fix: config reload persists state.items (see runtime-factory.js's
// generatedBufferStates) into a FRESH GeneratedSpeechBuffer instance, but the old generation's
// onDelivered would otherwise still be sitting on the stale instance. Reassigning
// buffer.onDelivered (as runtime-factory.js does right after constructing the new generation's
// readers) must reach an item enqueued under the OLD onDelivered.
test("reassigning buffer.onDelivered (simulating a config-reload rebind) reaches an item enqueued under the OLD handler", () => {
  const seenBy = [];
  const state = { items: [] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { item.onDelivered?.(); return { state: "waiting" }; } }, state, onDelivered: (payload) => seenBy.push({ gen: "old", payload }) });

  buffer.enqueue({ text: "survives-reload", source: "news", deliveryPayload: { text: "survives-reload" } });
  buffer.onDelivered = (payload) => seenBy.push({ gen: "new", payload });
  buffer.play();
  assert.deepEqual(seenBy, [{ gen: "new", payload: { text: "survives-reload" } }], "play() must use whichever onDelivered is CURRENTLY assigned, not the one active at enqueue time");
});

test("play() never fires onDelivered when the real speechQueue drops the item", () => {
  let delivered = 0;
  const state = { items: [{ text: "will-drop", source: "news", deliveryPayload: { text: "will-drop" } }] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: () => ({ state: "dropped" }) }, state, log: () => {}, onDelivered: () => delivered++ });

  const item = buffer.play();
  assert.equal(item.text, "will-drop", "play() still returns the dequeued item so the caller knows what was lost");
  assert.equal(delivered, 0, "a dropped real-queue enqueue must never fire onDelivered (never spoken)");
});

test("play() puts the item BACK instead of losing it when the real speechQueue.enqueue() throws", () => {
  const warnings = [];
  const state = { items: [{ text: "will-throw", source: "news", deliveryPayload: { text: "will-throw" } }] };
  // Unlike a drop (an explicit, handled outcome), a throw (e.g. SpeechQueue's strict-ordering/
  // voice-mix validation) means the item never actually reached the real queue — nothing was
  // lost yet, so it must not be discarded the way a genuine drop is.
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: () => { throw new Error("mixed voice engines"); } }, state, log: (message, level) => warnings.push({ message, level }) });

  const result = buffer.play();
  assert.equal(result, null, "play() must report nothing was delivered");
  assert.equal(buffer.size, 1, "the item must be put back into the buffer, not lost");
  assert.equal(state.items[0].text, "will-throw");
  assert.ok(warnings.some((w) => w.level === "warn" && w.message.includes("mixed voice engines")), "the failure must be logged");
});
