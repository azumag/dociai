import assert from "node:assert/strict";
import test from "node:test";
import { CommentSpeechPipeline, COMMENT_READER_ID, UNAVAILABLE_TRANSLATION_ADAPTER } from "../../src/comment-speech-pipeline.js";
import { commentReaderDefaults } from "../../src/config/config-defaults.js";

function fakeSpeechQueue() {
  return { items: [], enqueue(item) { this.items.push(item); return item; } };
}

function baseConfig(translationOverrides = {}, crOverrides = {}) {
  const commentReader = commentReaderDefaults({ enabled: true, includeAuthor: true, ...crOverrides });
  commentReader.translation = { ...commentReader.translation, enabled: true, ...translationOverrides };
  return { commentReader };
}

function delayedAdapter(byText) {
  return {
    async translate({ text }) {
      const entry = byText[text];
      if (!entry) throw Object.assign(new Error(`unexpected translate() call: ${text}`), { code: "TRANSLATION_FAILED" });
      if (entry.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
      if (entry.error) throw entry.error;
      return { text: entry.translated };
    },
  };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor() timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("translation.enabled: false stays fully synchronous — byte-identical to the pre-pipeline readCommentAloud()", () => {
  const config = { commentReader: commentReaderDefaults({ enabled: true, includeAuthor: false }) };
  const speechQueue = fakeSpeechQueue();
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true });
  pipeline.submit({ id: "c1", author: "Viewer", text: "hello" });
  assert.equal(speechQueue.items.length, 1, "enqueue must happen synchronously inside submit(), with no microtask delay");
  assert.equal(speechQueue.items[0].text, "hello");
  assert.equal(speechQueue.items[0].personaId, COMMENT_READER_ID);
});

test("a Japanese comment with translation enabled also stays on the synchronous fast path", () => {
  const config = baseConfig({}, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true });
  pipeline.submit({ id: "c1", author: "Viewer", text: "配信ありがとうございます!" });
  assert.equal(speechQueue.items.length, 1);
  assert.equal(speechQueue.items[0].text, "配信ありがとうございます!");
});

test("includeAuthor prefixing is applied to the translated text, after translation resolves", async () => {
  const config = baseConfig({ outputMode: "translated", onFailure: "skip" }, { includeAuthor: true });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { translated: "配信ありがとう!" } });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  assert.equal(speechQueue.items.length, 0, "a comment needing translation must not be enqueued synchronously");
  await waitFor(() => speechQueue.items.length === 1);
  assert.equal(speechQueue.items[0].text, "Viewer: 配信ありがとう!");
});

test("outputMode: originalThenTranslated enqueues both texts, in order, with the author prefix on each", async () => {
  const config = baseConfig({ outputMode: "originalThenTranslated", onFailure: "skip" }, { includeAuthor: true });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { translated: "配信ありがとう!" } });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  await waitFor(() => speechQueue.items.length === 2);
  assert.deepEqual(speechQueue.items.map((item) => item.text), [
    "Viewer: Thank you for the stream! That was a great match.",
    "Viewer: 配信ありがとう!",
  ]);
});

test("onFailure: readOriginal speaks the original text once when translation fails or times out", async () => {
  const config = baseConfig({ onFailure: "readOriginal", timeoutMs: 500 }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { error: new Error("boom") } });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  await waitFor(() => speechQueue.items.length === 1);
  assert.equal(speechQueue.items[0].text, "Thank you for the stream! That was a great match.");
});

test("onFailure: skip drops the comment entirely on translation failure", async () => {
  const config = baseConfig({ onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { error: new Error("boom") } });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(speechQueue.items.length, 0);
});

test("the default UNAVAILABLE_TRANSLATION_ADAPTER fails every translate() call with RUNTIME_UNAVAILABLE", async () => {
  await assert.rejects(() => UNAVAILABLE_TRANSLATION_ADAPTER.translate({ text: "hi", sourceLanguage: "en", targetLanguage: "ja" }), (error) => error.code === "RUNTIME_UNAVAILABLE");
});

test("speech order matches arrival order even when an earlier comment's translation is slower than a later one's", async () => {
  const config = baseConfig({ onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({
    "first comment goes here right now": { translated: "最初のコメント", delayMs: 60 },
    "the second comment arrives right after that one": { translated: "次のコメント", delayMs: 0 },
  });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "the second comment arrives right after that one" });
  await waitFor(() => speechQueue.items.length >= 2);
  assert.deepEqual(speechQueue.items.map((item) => item.text), ["最初のコメント", "次のコメント"]);
});

test("a translation-free comment arriving while an earlier translation is in flight still waits its turn", async () => {
  const config = baseConfig({ onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "first comment goes here right now": { translated: "最初のコメント", delayMs: 60 } });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "配信ありがとうございます!" }); // ja, no translation needed
  assert.equal(speechQueue.items.length, 0, "the ja comment must not jump ahead of the still-in-flight translation");
  await waitFor(() => speechQueue.items.length === 2);
  assert.deepEqual(speechQueue.items.map((item) => item.text), ["最初のコメント", "配信ありがとうございます!"]);
});

test("dispose() drops queued comments and stops the pipeline from accepting new ones", async () => {
  const config = baseConfig({ onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({
    "first comment goes here right now": { translated: "最初のコメント", delayMs: 60 },
    "the second comment arrives right after that one": { translated: "次のコメント" },
  });
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "the second comment arrives right after that one" });
  pipeline.dispose();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(speechQueue.items.length, 0, "nothing queued before dispose() should ever reach speechQueue");
  pipeline.submit({ id: "c", author: "C", text: "配信ありがとうございます!" });
  assert.equal(speechQueue.items.length, 0, "submit() after dispose() must be a no-op");
});

test("a stale generation's in-flight translation never enqueues into the (possibly torn-down) speechQueue", async () => {
  const config = baseConfig({ onFailure: "readOriginal" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "first comment goes here right now": { translated: "最初のコメント", delayMs: 40 } });
  let current = true;
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => current, translationAdapter: adapter });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  current = false; // a config reload landed while the translation was still in flight
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(speechQueue.items.length, 0, "isCurrent()===false must block the enqueue, even on the readOriginal fallback path");
});

test("maxPendingComments overflow drops the oldest still-queued comment and logs a warning", async () => {
  const config = baseConfig({ onFailure: "skip", maxPendingComments: 1 }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({
    "first comment goes here right now": { translated: "一件目", delayMs: 80 },
    "second comment follows soon after that": { translated: "二件目", delayMs: 0 },
    "third comment shows up a bit later": { translated: "三件目", delayMs: 0 },
  });
  const warnings = [];
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter,
    log: (message, level) => warnings.push({ message, level }),
  });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "second comment follows soon after that" });
  pipeline.submit({ id: "c", author: "C", text: "third comment shows up a bit later" });
  await waitFor(() => speechQueue.items.length >= 2);
  // "a" is already active (shifted out for processing, not sitting in the pending array) so it
  // still finishes; "b" was pushed onto the 1-slot pending queue and then evicted once "c"
  // arrived while that single slot was already full.
  assert.deepEqual(speechQueue.items.map((item) => item.text), ["一件目", "三件目"]);
  assert.ok(warnings.some((entry) => entry.level === "warn" && entry.message.includes("上限")));
});
