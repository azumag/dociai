import assert from "node:assert/strict";
import test from "node:test";
import { processCommentForSpeech } from "../../src/comment-speech-processor.js";
import { commentReaderDefaults } from "../../src/config/config-defaults.js";

function cr(overrides = {}) {
  return commentReaderDefaults({ enabled: true, ...overrides });
}

function crWithTranslation(translationOverrides = {}, crOverrides = {}) {
  const base = cr(crOverrides);
  return { ...base, translation: { ...base.translation, enabled: true, ...translationOverrides } };
}

test("disabled commentReader always skips, before touching author/text at all", () => {
  const result = processCommentForSpeech({ author: "V", text: "hi" }, commentReaderDefaults({ enabled: false }));
  assert.deepEqual(result, { kind: "skip", reason: "disabled" });
});

test("ignoreUsers match is case-insensitive and ignores surrounding whitespace in the configured name", () => {
  const config = cr({ ignoreUsers: [" Spammer "] });
  const result = processCommentForSpeech({ author: "spammer", text: "hi" }, config);
  assert.deepEqual(result, { kind: "skip", reason: "ignored-user" });
});

test("an emote that covers the entire comment strips to empty and is skipped, before translation ever runs", () => {
  const config = crWithTranslation({}, { skipEmotes: true });
  const result = processCommentForSpeech({ author: "V", text: "Kappa", emotes: "25:0-4" }, config);
  assert.deepEqual(result, { kind: "skip", reason: "empty" });
});

test("consecutive emoji are collapsed before the empty check and before detection", () => {
  const config = crWithTranslation({}, { collapseConsecutiveEmoji: true });
  const result = processCommentForSpeech({ author: "V", text: "😂😂😂" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "😂", translated: false });
});

test("consecutive Twitch emote codes are collapsed to the first one, using the emotes tag ranges", () => {
  const config = crWithTranslation({}, { collapseConsecutiveEmoji: true });
  const result = processCommentForSpeech({ author: "V", text: "Kappa Kappa Kappa", emotes: "25:0-4,6-10,12-16" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "Kappa", translated: false });
});

test("skipEmotes takes priority over collapseConsecutiveEmoji: emotes are stripped entirely, not collapsed", () => {
  const config = crWithTranslation({}, { skipEmotes: true, collapseConsecutiveEmoji: true });
  const result = processCommentForSpeech({ author: "V", text: "Kappa Kappa nice stream", emotes: "25:0-4,6-10" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "nice stream", translated: false });
});

test("excludeAfterMarker cuts the marker and everything after it, trimming trailing whitespace", () => {
  const config = cr({ excludeAfterMarker: "ここまで" });
  const result = processCommentForSpeech({ author: "V", text: "こんにちは ここまで 個人情報" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "こんにちは", translated: false });
});

test("excludeAfterMarker unset (default empty string) leaves the text unaffected", () => {
  const config = cr();
  const result = processCommentForSpeech({ author: "V", text: "hello ここまで world" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "hello ここまで world", translated: false });
});

test("excludeAfterMarker at the very start of the comment truncates to empty and is skipped", () => {
  const config = cr({ excludeAfterMarker: "ここまで" });
  const result = processCommentForSpeech({ author: "V", text: "ここまで 個人情報" }, config);
  assert.deepEqual(result, { kind: "skip", reason: "empty" });
});

test("excludeAfterMarker with multiple occurrences cuts at the first one", () => {
  const config = cr({ excludeAfterMarker: "NG" });
  const result = processCommentForSpeech({ author: "V", text: "A NG B NG C" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "A", translated: false });
});

test("excludeAfterMarker is case-sensitive: a lowercase marker does not match uppercase text", () => {
  const config = cr({ excludeAfterMarker: "ng" });
  const result = processCommentForSpeech({ author: "V", text: "A NG B" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "A NG B", translated: false });
});

test("excludeAfterMarker supports multi-character emoji markers, run before consecutive-emoji collapsing would otherwise eat them", () => {
  const config = cr({ excludeAfterMarker: "🚫🚫" });
  const result = processCommentForSpeech({ author: "V", text: "hello 🚫🚫 secret" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "hello", translated: false });
});

test("excludeAfterMarker runs before Twitch emote stripping, so emote ranges (absolute offsets into the original text) still resolve correctly for the retained prefix", () => {
  const config = cr({ skipEmotes: true, excludeAfterMarker: "secret" });
  // "Kappa nice stream secret info" — emote "Kappa" spans codepoints 0-4, entirely within the retained prefix.
  const result = processCommentForSpeech({ author: "V", text: "Kappa nice stream secret info", emotes: "25:0-4" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "nice stream", translated: false });
});

test("excludeAfterMarker runs before Twitch emote-run collapsing too, for emotes within the retained prefix", () => {
  const config = cr({ collapseConsecutiveEmoji: true, excludeAfterMarker: "secret" });
  // "Kappa Kappa nice stream secret info" — two consecutive Kappa emotes (both within the retained prefix) collapse to one.
  const result = processCommentForSpeech({ author: "V", text: "Kappa Kappa nice stream secret info", emotes: "25:0-4,6-10" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "Kappa nice stream", translated: false });
});

test("excludeAfterMarker still finds a marker that coincides with a real Twitch emote code, instead of losing it to skipEmotes first (regression: truncation must run before emote stripping)", () => {
  const config = cr({ skipEmotes: true, excludeAfterMarker: "Kappa" });
  // "Kappa" (codepoints 6-10) is a real, Twitch-tagged emote here — if truncation ran after
  // stripEmotes, stripEmotes would remove it first and the marker could never be found.
  const result = processCommentForSpeech({ author: "V", text: "hello Kappa world", emotes: "25:6-10" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "hello", translated: false });
});

test("excludeAfterMarker with internal double spaces is found even when the comment has an unrelated Twitch emote (regression: emote-stripping's whitespace normalization must not run before marker matching)", () => {
  const config = cr({ skipEmotes: true, excludeAfterMarker: "  MARKER  " });
  // "keep" (codepoints 0-3) is stripped by skipEmotes, which unconditionally collapses runs of
  // whitespace in its output — if that ran before marker matching, the marker's own double
  // spaces would already be gone and indexOf would fail to find it.
  const result = processCommentForSpeech({ author: "V", text: "keep this  MARKER  drop this", emotes: "25:0-3" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "this", translated: false });
});

test("excludeAfterMarker truncation never mutates the original comment object", () => {
  const comment = { author: "V", text: "keep this NG drop this" };
  const config = cr({ excludeAfterMarker: "NG" });
  processCommentForSpeech(comment, config);
  assert.equal(comment.text, "keep this NG drop this");
});

test("translation disabled (the default) speaks the original text without running detection", () => {
  const config = cr(); // translation.enabled defaults to false
  const result = processCommentForSpeech({ author: "V", text: "Thank you for the stream!" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "Thank you for the stream!", translated: false });
});

test("translation enabled + a Japanese comment speaks as-is with detectedLanguage ja", () => {
  const config = crWithTranslation();
  const result = processCommentForSpeech({ author: "V", text: "配信ありがとうございます!" }, config);
  assert.deepEqual(result, { kind: "speak", originalText: "配信ありがとうございます!", translated: false, detectedLanguage: "ja" });
});

test("translation enabled + a confident English comment requests translation", () => {
  const config = crWithTranslation();
  const text = "Thank you for the stream! That was a great match.";
  const result = processCommentForSpeech({ author: "V", text }, config);
  assert.equal(result.kind, "translate");
  assert.equal(result.detectedLanguage, "en");
  assert.equal(result.originalText, text);
  assert.ok(result.confidence > 0.7);
});

test("translation enabled + a confident French comment requests translation", () => {
  const config = crWithTranslation();
  const text = "Merci pour le stream, c'était très amusant !";
  const result = processCommentForSpeech({ author: "V", text }, config);
  assert.equal(result.kind, "translate");
  assert.equal(result.detectedLanguage, "fr");
});

test("translation enabled + input longer than maxInputChars speaks as-is without running detection", () => {
  const config = crWithTranslation({ maxInputChars: 10 });
  const text = "Thank you for the stream! That was a great match.";
  const result = processCommentForSpeech({ author: "V", text }, config);
  assert.deepEqual(result, { kind: "speak", originalText: text, translated: false });
});

test("translation enabled + short gaming slang speaks as-is (never mistranslated)", () => {
  const config = crWithTranslation();
  for (const text of ["GG", "LOL", "nice", "Minecraft"]) {
    const result = processCommentForSpeech({ author: "V", text }, config);
    assert.equal(result.kind, "speak", text);
    assert.equal(result.translated, false, text);
  }
});

test("translation enabled + a language outside sourceLanguages speaks as-is", () => {
  const config = crWithTranslation({ sourceLanguages: ["en"] });
  const text = "Merci pour le stream, c'était très amusant !";
  const result = processCommentForSpeech({ author: "V", text }, config);
  assert.equal(result.kind, "speak");
  assert.equal(result.translated, false);
});
