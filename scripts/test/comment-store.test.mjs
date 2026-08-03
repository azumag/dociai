import assert from "node:assert/strict";
import test from "node:test";
import { CommentStore } from "../../src/comment-store.js";

test("setTranslation() attaches translatedText to the matching comment without touching its other fields", () => {
  const store = new CommentStore({ limit: 10 });
  const comment = store.add({ author: "V", text: "Thank you for the stream!" });
  store.setTranslation(comment.id, "配信ありがとう!");
  const stored = store.recent(1)[0];
  assert.equal(stored.translatedText, "配信ありがとう!");
  assert.equal(stored.text, "Thank you for the stream!", "the original text must never be overwritten");
  assert.equal(stored.author, "V");
});

test("setTranslation() is a silent no-op for an id that no longer exists (already evicted by the ring-buffer limit)", () => {
  const store = new CommentStore({ limit: 1 });
  const first = store.add({ author: "A", text: "first" });
  store.add({ author: "B", text: "second" }); // evicts `first` (limit: 1)
  assert.doesNotThrow(() => store.setTranslation(first.id, "should be dropped silently"));
  assert.equal(store.recent(1)[0].text, "second");
});

test("setTranslation() notifies onChange listeners, matching add()'s own notification behavior", () => {
  const store = new CommentStore({ limit: 10 });
  const comment = store.add({ author: "V", text: "hello" });
  let notified = 0;
  store.onChange(() => { notified += 1; });
  store.setTranslation(comment.id, "こんにちは");
  assert.equal(notified, 1);
});
