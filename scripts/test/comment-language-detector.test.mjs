import assert from "node:assert/strict";
import test from "node:test";
import { detectCommentLanguage } from "../../src/comment-language-detector.js";

test("Japanese text short-circuits to ja without running the detector", () => {
  assert.deepEqual(detectCommentLanguage("配信ありがとうございます!"), { language: "ja", confidence: 1 });
  assert.equal(detectCommentLanguage("最高😂 これは英語じゃない").language, "ja");
});

test("confidently detects English and French within the configured source languages", () => {
  const en = detectCommentLanguage("Thank you for the stream! That was a great match.", { sourceLanguages: ["en", "fr"], minimumConfidence: 0.7 });
  assert.equal(en.language, "en");
  assert.ok(en.confidence > 0.7);

  const fr = detectCommentLanguage("Merci pour le stream, c'était très amusant !", { sourceLanguages: ["en", "fr"], minimumConfidence: 0.7 });
  assert.equal(fr.language, "fr");
  assert.ok(fr.confidence > 0.7);
});

test("short gaming slang / reactions stay undetected so they are spoken as-is", () => {
  for (const text of ["GG", "gg wp", "LOL", "nice", "W", "Minecraft"]) {
    assert.equal(detectCommentLanguage(text).language, null, text);
  }
});

test("URL-only, emoji-only, and mention-only text stays undetected", () => {
  for (const text of ["https://example.com/clip/12345", "😂😂😂", "@azumag"]) {
    assert.equal(detectCommentLanguage(text).language, null, text);
  }
});

test("a language outside sourceLanguages is never returned, even for a long confident sentence", () => {
  const result = detectCommentLanguage("Vielen Dank für den Stream, das war großartig!", { sourceLanguages: ["en", "fr"] });
  assert.equal(result.language, null);
});

test("minimumConfidence gates a borderline top1/top2 margin", () => {
  const text = "je pense que tu as raté l'objet en haut à gauche";
  const lenient = detectCommentLanguage(text, { sourceLanguages: ["en", "fr"], minimumConfidence: 0.65 });
  assert.equal(lenient.language, "fr");
  const strict = detectCommentLanguage(text, { sourceLanguages: ["en", "fr"], minimumConfidence: 0.7 });
  assert.equal(strict.language, null);
});

test("empty/nullish input never throws and is treated as undetected", () => {
  assert.equal(detectCommentLanguage("").language, null);
  assert.equal(detectCommentLanguage(undefined).language, null);
  assert.equal(detectCommentLanguage(null).language, null);
});
