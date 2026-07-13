// Issue #177: coverage for src/trigger-engine.js's handleComment() double-fire guard. No dedicated
// test file previously existed for TriggerEngine.handleComment() (only its hotkey/global-shortcut
// paths were covered, in scripts/test/electron-shortcut.test.mjs) — this file adds it, focused on
// the #177 investigation finding: a real Twitch cheer's own chat message arrives as an ordinary IRC
// PRIVMSG (carrying a `bits` tag — see src/twitch-chat/twitch-chat-session.js's own forwarding) IN
// ADDITION to the separate channel.cheer EventSub notification the production event-trigger
// pipeline (src/app/runtime-factory.js's eventTriggerRunner) already reacts to; without a guard, a
// keyword/random comment trigger configured here could ALSO fire an AI response for the identical
// cheer. `handleComment()` now skips keyword/random dispatch entirely for any comment carrying a
// positive `bits` value.
import assert from "node:assert/strict";
import test from "node:test";
import { TriggerEngine } from "../../src/trigger-engine.js";

test("TriggerEngine.handleComment: fires keyword and random triggers for an ordinary comment", () => {
  const fired = [];
  const engine = new TriggerEngine(
    { kw: { type: "keyword", keywords: ["hello"] }, always: { type: "random", probability: 1 } },
    { onFire: (id, event) => fired.push([id, event.reason, event.comment]) },
  );
  const comment = { author: "Viewer", text: "hello world", channel: "one" };
  const ids = engine.handleComment(comment);
  assert.deepEqual([...ids].sort(), ["always", "kw"]);
  assert.equal(fired.length, 2);
  for (const [, reason, firedComment] of fired) {
    assert.equal(reason, "comment");
    assert.equal(firedComment, comment);
  }
});

test("TriggerEngine.handleComment: a comment carrying a positive `bits` value (a cheer's own chat PRIVMSG) never fires ANY keyword/random trigger — avoids double-firing alongside the event-trigger pipeline's own channel.cheer response", () => {
  const fired = [];
  const engine = new TriggerEngine(
    { kw: { type: "keyword", keywords: ["cheer"] }, always: { type: "random", probability: 1 } },
    { onFire: (id, event) => fired.push([id, event]) },
  );
  const cheerComment = { author: "Viewer", text: "Cheer100 cheer for the stream!", channel: "one", bits: 100 };
  const ids = engine.handleComment(cheerComment);
  assert.deepEqual(ids, []);
  assert.equal(fired.length, 0, "no trigger may fire for a bits-tagged comment, even one whose text matches a keyword");
});

test("TriggerEngine.handleComment: bits:null / bits:0 / missing bits are all treated as an ordinary comment (only a POSITIVE bits value suppresses dispatch)", () => {
  const fired = [];
  const engine = new TriggerEngine({ kw: { type: "keyword", keywords: ["hi"] } }, { onFire: (id) => fired.push(id) });
  assert.deepEqual(engine.handleComment({ author: "a", text: "hi", bits: null }), ["kw"]);
  assert.deepEqual(engine.handleComment({ author: "a", text: "hi", bits: 0 }), ["kw"]);
  assert.deepEqual(engine.handleComment({ author: "a", text: "hi" }), ["kw"]);
  assert.equal(fired.length, 3);
});
