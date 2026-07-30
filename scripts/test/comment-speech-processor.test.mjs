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
