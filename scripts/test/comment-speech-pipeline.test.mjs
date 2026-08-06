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

test("onTranslated(comment, translatedText) fires exactly once on a successful translation, independent of speech outputMode/enqueueing", async () => {
  const config = baseConfig({ outputMode: "originalThenTranslated", onFailure: "skip" }, { includeAuthor: true });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { translated: "配信ありがとう!" } });
  const calls = [];
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter,
    onTranslated: (comment, translatedText) => calls.push({ comment, translatedText }),
  });
  const submitted = { id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." };
  pipeline.submit(submitted);
  await waitFor(() => speechQueue.items.length === 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].comment, submitted);
  assert.equal(calls[0].translatedText, "配信ありがとう!");
});

test("onTranslated still fires for a stale-generation translation, even though it's never enqueued for speech — CommentStore (unlike speechQueue) survives generation changes", async () => {
  const config = baseConfig({ onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { translated: "配信ありがとう!" } });
  const calls = [];
  let current = true;
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => current, translationAdapter: adapter,
    onTranslated: (comment, translatedText) => calls.push({ comment, translatedText }),
  });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  current = false; // a config reload landed while the translation was still in flight
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].translatedText, "配信ありがとう!");
  assert.equal(speechQueue.items.length, 0, "a stale-generation translation must still never reach the (possibly torn-down) speechQueue");
});

test("a throwing onTranslated callback is logged and does not stop speech enqueueing or block later comments (PR review regression)", async () => {
  const config = baseConfig({ outputMode: "translated", onFailure: "skip" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({
    "first comment goes here right now": { translated: "最初のコメント" },
    "the second comment arrives right after that one": { translated: "次のコメント" },
  });
  const logs = [];
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter,
    onTranslated: () => { throw new Error("boom from a display listener"); },
    log: (message, level) => logs.push({ message, level }),
  });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "the second comment arrives right after that one" });
  await waitFor(() => speechQueue.items.length === 2);
  assert.deepEqual(speechQueue.items.map((item) => item.text), ["最初のコメント", "次のコメント"]);
  assert.ok(logs.some((entry) => entry.level === "warn" && entry.message.includes("boom from a display listener")));
});

test("onTranslated is never called when translation fails or times out", async () => {
  const config = baseConfig({ onFailure: "readOriginal", timeoutMs: 500 }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { error: new Error("boom") } });
  let called = false;
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter,
    onTranslated: () => { called = true; },
  });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  await waitFor(() => speechQueue.items.length === 1);
  assert.equal(called, false);
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
  // the translation (2nd item) must be marked so SpeechQueue's inter-comment pacing doesn't
  // insert a full commentReaderIntervalMs pause between a comment and its own translation
  // (PR review regression) — the original (1st item) is unmarked, pacing normally against
  // whatever comment came before it.
  assert.equal(speechQueue.items[0].metadata, undefined);
  assert.deepEqual(speechQueue.items[1].metadata, { skipCommentReaderInterval: true });
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

test("a translation failure is logged with the underlying error message, instead of being silently swallowed", async () => {
  const config = baseConfig({ onFailure: "readOriginal" }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = delayedAdapter({ "Thank you for the stream! That was a great match.": { error: new Error("translation model failed to load") } });
  const logs = [];
  const pipeline = new CommentSpeechPipeline({
    config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter,
    log: (message, level) => logs.push({ message, level }),
  });
  pipeline.submit({ id: "c1", author: "Viewer", text: "Thank you for the stream! That was a great match." });
  await waitFor(() => speechQueue.items.length === 1);
  assert.ok(logs.some((entry) => entry.level === "warn" && entry.message.includes("translation model failed to load")));
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

test("timeoutMs actually bounds the wait even when the adapter's promise never settles (PR review regression)", async () => {
  // #processQueued clamps timeoutMs to a 500ms floor (matching config-validation.js's own
  // minimum), so 500 is the smallest bound observable here — not an arbitrary test choice.
  const config = baseConfig({ onFailure: "readOriginal", timeoutMs: 500 }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  let abortedSignal = null;
  const adapter = {
    translate({ signal }) {
      abortedSignal = signal;
      return new Promise(() => {}); // never resolves/rejects — simulates a hung IPC/Main handler
    },
  };
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  const start = Date.now();
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  await waitFor(() => speechQueue.items.length === 1, { timeoutMs: 2000 });
  assert.ok(Date.now() - start < 1000, "the pipeline must move on around the 500ms timeout floor, not wait for the adapter forever");
  assert.equal(speechQueue.items[0].text, "first comment goes here right now", "onFailure: readOriginal after a timeout");
  assert.equal(abortedSignal?.aborted, true, "the abort signal is still sent, even though the pipeline doesn't wait on it");
});

test("a later comment is not blocked behind an earlier one whose adapter promise never settles", async () => {
  const config = baseConfig({ onFailure: "skip", timeoutMs: 500 }, { includeAuthor: false });
  const speechQueue = fakeSpeechQueue();
  const adapter = {
    translate({ text }) {
      if (text === "first comment goes here right now") return new Promise(() => {});
      return Promise.resolve({ text: "次のコメント" });
    },
  };
  const pipeline = new CommentSpeechPipeline({ config, speechQueue, resolveVoice: () => ({ engine: "webspeech" }), isCurrent: () => true, translationAdapter: adapter });
  pipeline.submit({ id: "a", author: "A", text: "first comment goes here right now" });
  pipeline.submit({ id: "b", author: "B", text: "the second comment arrives right after that one" });
  await waitFor(() => speechQueue.items.length === 1, { timeoutMs: 1000 });
  assert.equal(speechQueue.items[0].text, "次のコメント", "the first comment's stuck translate() must not block the second comment forever");
});

test("maxPendingComments overflow never drops a queued comment; it only logs a warning (issue #277)", async () => {
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
  await waitFor(() => speechQueue.items.length >= 3);
  // 上限超過でもコメントは破棄されず、全件が順番に読み上げられる (issue #277)。
  assert.deepEqual(speechQueue.items.map((item) => item.text), ["一件目", "二件目", "三件目"]);
  assert.ok(warnings.some((entry) => entry.level === "warn" && entry.message.includes("上限")));
});
