// NewsQualityGate (issue #192)
// parse -> sanitize -> repetition/language/tone/mode/grounding検査 をまとめ、NewsQualityReport
// と、実際に読み上げる (parse+sanitize済みの) titleSpoken/bodyを返す。

import { parseNewsOutput } from "./news-output-parser.js";
import { sanitizeSpokenText } from "./spoken-text-sanitizer.js";
import { detectRepetition } from "./repetition-detector.js";
import { analyzeLanguage } from "./language-detector.js";
import { validateTone } from "./tone-validator.js";
import { validateMode } from "./mode-validator.js";
import { validateGrounding } from "./grounding-validator.js";

export function runNewsQualityGate({ rawText, policy, research = null, validSourceIds = null, minChars = null, maxChars = null, bannedPhrases = [] }) {
  const parsed = parseNewsOutput(rawText, { validSourceIds });
  const sanitizedBody = sanitizeSpokenText(parsed.body);
  const sanitizedTitle = sanitizeSpokenText(parsed.titleSpoken);
  const text = sanitizedBody.text;

  const failures = [];
  for (const code of parsed.parserWarnings) failures.push({ code: `parser_${code}`, severity: "warning", message: code });
  for (const code of sanitizedBody.warnings) failures.push({ code, severity: "warning", message: code });

  const effectiveMin = minChars ?? policy?.targetChars?.min ?? 0;
  const effectiveMax = maxChars ?? policy?.targetChars?.max ?? null;
  if (!text || text.length < effectiveMin * 0.5) failures.push({ code: "too_short", severity: "rewrite", message: "本文が短すぎます" });
  if (effectiveMax && text.length > effectiveMax * 2) failures.push({ code: "too_long", severity: "rewrite", message: "本文が長すぎます" });

  const repetition = detectRepetition(text);
  for (const f of repetition.failures) failures.push({ code: f.code, severity: "rewrite", message: f.code, evidence: f.detail });

  const language = analyzeLanguage(text);
  for (const f of language.failures) failures.push({ code: f.code, severity: f.severity, message: f.code, evidence: f.detail });

  const tone = validateTone(text, { bannedPhrases });
  for (const f of tone.failures) failures.push({ code: f.code, severity: f.severity, message: f.code, evidence: f.detail });

  const mode = validateMode(text, { policy, research });
  for (const f of mode.failures) failures.push({ code: f.code, severity: f.severity, message: f.code });

  const grounding = validateGrounding(text, { research, entities: parsed.entities });
  for (const f of grounding.failures) failures.push({ code: f.code, severity: f.severity, message: f.code, evidence: f.detail });

  const rewriteFailures = failures.filter((f) => f.severity === "rewrite");
  const passed = rewriteFailures.length === 0 && Boolean(text);

  return {
    passed,
    failures,
    metrics: {
      chars: text.length,
      japaneseRatio: language.japaneseRatio,
      sentenceCount: text.split(/[。！？!?]/).filter((s) => s.trim()).length,
      maxSentenceRepetition: repetition.maxSentenceRepetition,
      groundedEntityRatio: grounding.groundedEntityRatio,
      groundedNumberRatio: grounding.groundedNumberRatio,
    },
    parsed: { ...parsed, titleSpoken: sanitizedTitle.text, body: text },
  };
}
