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

test("enqueue() never fires onDelivered — play() only forwards it to the real speechQueue, which decides when to fire it", () => {
  let delivered = 0;
  const state = { items: [] };
  // Mimics SpeechQueue.enqueue()'s real contract (src/speech-queue.js): fire onDelivered once
  // the item genuinely reaches the real queue. GeneratedSpeechBuffer itself never touches
  // onDelivered — it only forwards the item, onDelivered included, at play() time.
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: (item) => { item.onDelivered?.(); return { state: "waiting" }; } }, state });

  buffer.enqueue({ text: "held", source: "news", onDelivered: () => delivered++ });
  assert.equal(delivered, 0, "buffering an item must not broadcast onRead/complete external side effects yet");

  buffer.play();
  assert.equal(delivered, 1, "play() must forward the item (onDelivered included) to the real queue");
});

test("play() never fires onDelivered when the real speechQueue drops the item", () => {
  let delivered = 0;
  const state = { items: [{ text: "will-drop", source: "news", onDelivered: () => delivered++ }] };
  const buffer = new GeneratedSpeechBuffer({ speechQueue: { enqueue: () => ({ state: "dropped" }) }, state, log: () => {} });

  const item = buffer.play();
  assert.equal(item.text, "will-drop", "play() still returns the dequeued item so the caller knows what was lost");
  assert.equal(delivered, 0, "a dropped real-queue enqueue must never fire onDelivered (never spoken)");
});
