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
