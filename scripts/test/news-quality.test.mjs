import assert from "node:assert/strict";
import test from "node:test";
import { parseNewsOutput } from "../../src/news/quality/news-output-parser.js";
import { sanitizeSpokenText } from "../../src/news/quality/spoken-text-sanitizer.js";
import { detectRepetition } from "../../src/news/quality/repetition-detector.js";
import { analyzeLanguage } from "../../src/news/quality/language-detector.js";
import { validateTone } from "../../src/news/quality/tone-validator.js";
import { validateMode } from "../../src/news/quality/mode-validator.js";
import { validateGrounding } from "../../src/news/quality/grounding-validator.js";
import { runNewsQualityGate } from "../../src/news/quality/news-quality-gate.js";
import { decideRewrite } from "../../src/news/quality/rewrite-policy.js";
import { NEWS_OUTPUT_MARKERS } from "../../src/news/generation/news-output-contract.js";
import { resolveModePolicy } from "../../src/news/mode-policy.js";
import { createNewsPipelineCoordinator } from "../../src/news/news-pipeline-coordinator.js";
import { createNewsPromptGenerateStage } from "../../src/news/stages/generate-stage.js";
import { createNewsQualityGateStage } from "../../src/news/stages/quality-stage.js";
import { createSelectStage } from "../../src/news/stages/select-stage.js";
import { MemoryItemProcessingStore } from "../../src/readers/item-processing-store.js";
import { MemoryNewsHistoryStore } from "../../src/news/selection/memory-news-history-store.js";

function markerText({ title = "タイトル", body = "本文です。", summary = "要約です。", entities = "なし", sourceIds = "なし" } = {}) {
  return [
    NEWS_OUTPUT_MARKERS.TITLE, title,
    NEWS_OUTPUT_MARKERS.BODY, body,
    NEWS_OUTPUT_MARKERS.SUMMARY, summary,
    NEWS_OUTPUT_MARKERS.ENTITIES, entities,
    NEWS_OUTPUT_MARKERS.SOURCE_IDS, sourceIds,
  ].join("\n");
}

test("parseNewsOutput extracts every marker section in order and reports nothing missing on well-formed output", () => {
  const parsed = parseNewsOutput(markerText({ title: "見出し", body: "本文テキスト", summary: "要約テキスト", entities: "日銀\n政府", sourceIds: "s1\ns2" }));
  assert.equal(parsed.titleSpoken, "見出し");
  assert.equal(parsed.body, "本文テキスト");
  assert.equal(parsed.summary, "要約テキスト");
  assert.deepEqual(parsed.entities, ["日銀", "政府"]);
  assert.deepEqual(parsed.sourceIds, ["s1", "s2"]);
  assert.deepEqual(parsed.parserWarnings, []);
});

test("parseNewsOutput strips markdown code fences before re-parsing", () => {
  const fenced = "```\n" + markerText({ body: "フェンス内の本文" }) + "\n```";
  const parsed = parseNewsOutput(fenced);
  assert.equal(parsed.body, "フェンス内の本文");
});

test("parseNewsOutput falls back to the longest natural-language block when BODY is missing", () => {
  const raw = "前置きの挨拶です。\n\n" + "これはBODYマーカーが無い場合に採用されるべき、最も長い自然文の段落です。".repeat(2) + "\n\n短い断片。";
  const parsed = parseNewsOutput(raw);
  assert.ok(parsed.parserWarnings.includes("body_marker_missing"));
  assert.ok(parsed.body.includes("最も長い自然文の段落です"));
});

test("parseNewsOutput drops source ids that the model invented but are not in the research bundle", () => {
  const parsed = parseNewsOutput(markerText({ sourceIds: "s1\nforged-id" }), { validSourceIds: new Set(["s1"]) });
  assert.deepEqual(parsed.sourceIds, ["s1"]);
  assert.ok(parsed.parserWarnings.includes("source_id_forged_removed"));
});

test("sanitizeSpokenText removes markdown syntax, URLs, ANSI/control characters, and marker residue", () => {
  const esc = String.fromCharCode(27);
  const raw = "# 見出し\n**強調**された*本文*です https://example.com/x " + esc + "[31m危険" + esc + "[0m ===BODY=== 続き";
  const { text, warnings } = sanitizeSpokenText(raw);
  assert.doesNotMatch(text, /[#*]/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.ok(!text.includes(esc), "the ANSI escape byte itself must be stripped");
  assert.doesNotMatch(text, /\[[0-9;]*m/);
  assert.doesNotMatch(text, /===[A-Z_]+===/);
  assert.equal(warnings.length, 0);
});

test("sanitizeSpokenText strips tool/API-failure/internal-事情 sentences and records why", () => {
  const { text, warnings } = sanitizeSpokenText("通常の文です。WebSearchに失敗しました。rate limitに達しました。");
  assert.doesNotMatch(text, /WebSearch|rate limit/i);
  assert.ok(warnings.includes("internal_leak_tool"));
  assert.ok(warnings.includes("internal_leak_error"));
});

test("detectRepetition flags a 10+ char sentence repeated 3+ times and a 3x consecutive identical line", () => {
  const sentence = "これは反復チェック用の十分に長い一文です。";
  const repeated = detectRepetition(sentence.repeat(3));
  assert.ok(repeated.failures.some((f) => f.code === "sentence_repetition"));
  assert.equal(repeated.maxSentenceRepetition, 3);

  const lineRepeated = detectRepetition("同じ行\n同じ行\n同じ行\n違う行");
  assert.ok(lineRepeated.failures.some((f) => f.code === "line_repetition_3x"));
});

test("analyzeLanguage flags low Japanese ratio, long English runs, and kanji-only (Chinese-like) sentences while tolerating short foreign proper nouns", () => {
  const english = analyzeLanguage("This is a long English sentence that should never appear in spoken Japanese output at all.");
  assert.ok(english.failures.some((f) => f.code === "long_english_segment"));

  const chineseLike = analyzeLanguage("中国政府近日宣布将于本周举行重要经济会议讨论相关政策问题。");
  assert.ok(chineseLike.failures.some((f) => f.code === "kanji_only_sentence"));

  const naturalJapanese = analyzeLanguage("iPhoneの新機能について、開発者たちが詳しく説明しました。");
  assert.ok(!naturalJapanese.failures.some((f) => f.code === "kanji_only_sentence"), "a short foreign proper noun mixed into natural Japanese must not be flagged");
});

test("validateTone flags self-deprecating and cheap-incitement phrases plus configured banned phrases", () => {
  assert.ok(validateTone("どうせ誰も見てないから適当に話します").failures.some((f) => f.code === "self_deprecating_tone"));
  assert.ok(validateTone("これは絶対に許せない話です").failures.some((f) => f.code === "cheap_incitement"));
  assert.ok(validateTone("普通の文章です", { bannedPhrases: ["普通の文章"] }).failures.some((f) => f.code === "banned_phrase"));
});

test("validateMode blocks opinion language in simple mode and flags a current-mode take that ignores a second viewpoint", () => {
  const simplePolicy = resolveModePolicy("simple");
  assert.ok(validateMode("株価が下落したと思います", { policy: simplePolicy }).failures.some((f) => f.code === "simple_mode_opinion"));

  const currentPolicy = resolveModePolicy("current");
  const research = { viewpoints: ["一時的な調整という見方", "構造的な問題という見方"] };
  assert.ok(validateMode("株価が下落しました。これは大きな問題です。", { policy: currentPolicy, research }).failures.some((f) => f.code === "current_mode_single_viewpoint"));
  assert.equal(validateMode("株価が下落しました。一方で回復を見込む声もあります。", { policy: currentPolicy, research }).failures.length, 0);
});

test("validateGrounding only flags unsupported numbers/entities when a research bundle exists to compare against", () => {
  assert.deepEqual(validateGrounding("死者は120人に上った", { research: null }).failures, []);

  const research = { facts: [{ text: "死者は12人に上った" }], background: [] };
  const result = validateGrounding("死者は120人に上った", { research, entities: [] });
  assert.ok(result.failures.some((f) => f.code === "ungrounded_number"));

  const groundedResult = validateGrounding("死者は12人に上った", { research, entities: [] });
  assert.equal(groundedResult.failures.length, 0);
});

test("runNewsQualityGate rejects a too-short/unmarked response and passes a well-formed marker response", () => {
  const policy = resolveModePolicy("topic");
  const tooShort = runNewsQualityGate({ rawText: "ok", policy });
  assert.equal(tooShort.passed, false);
  assert.ok(tooShort.failures.some((f) => f.code === "too_short"));

  const naturalBody = [
    "この記事は開発チームの新しい取り組みについて伝えています。",
    "担当者によると、来月には具体的な発表が予定されているとのことです。",
    "すでに一部の機能はテストを開始しており、順調に進んでいるとのことです。",
    "視聴者の皆さんも今後の展開にぜひ注目してください。",
  ].join("");
  const wellFormed = runNewsQualityGate({ rawText: markerText({ body: naturalBody }), policy });
  assert.equal(wellFormed.passed, true);
  assert.ok(wellFormed.parsed.body.length > 0);
});

test("decideRewrite accepts passing reports, offers one rewrite, then rejects after the budget is exhausted", () => {
  const passing = { passed: true, failures: [] };
  assert.equal(decideRewrite(passing, { attempt: 0, maxAttempts: 1 }).action, "accept");

  const failing = { passed: false, failures: [{ code: "too_short", severity: "rewrite" }] };
  assert.equal(decideRewrite(failing, { attempt: 0, maxAttempts: 1 }).action, "rewrite");
  assert.equal(decideRewrite(failing, { attempt: 1, maxAttempts: 1 }).action, "reject");

  const warningOnly = { passed: false, failures: [{ code: "topic_mode_padding", severity: "warning" }] };
  assert.equal(decideRewrite(warningOnly, { attempt: 0, maxAttempts: 1 }).action, "accept", "warning-only failures do not force a rewrite");
});

test("integration: NewsPromptGenerateStage + NewsQualityGateStage compose through the coordinator so only the sanitized body reaches delivery", async () => {
  const persona = { id: "p", name: "P", connector: "main", enabled: true, voice: {}, systemPrompt: "テスト用ペルソナ" };
  const item = { title: "テストニュース見出し", sourceName: "mock", publishedAt: "2026-07-16T00:00:00Z", guid: "g1", processingKey: "news:g1" };

  let call = 0;
  const connector = {
    chat: async () => {
      call++;
      if (call === 1) {
        // 1回目はmarker欠落 + 短文 (quality gateでrewriteされるべき壊れた応答)
        return { text: "だめな応答" };
      }
      return {
        text: markerText({
          title: "見出し",
          body: [
            "この本文は十分な長さと構造化markerを持つ、正しく生成された応答の例です。",
            "quality gateはこの本文をsanitizeしたうえで読み上げに使うべきです。",
            "前回の壊れた応答とは違い、今回はmarker形式に沿って正しく出力されています。",
          ].join(""),
        }),
      };
    },
  };

  const store = new MemoryItemProcessingStore({ clock: () => 1000 });
  const historyStore = new MemoryNewsHistoryStore({ clock: () => 1000 });
  const delivered = [];
  const reads = [];

  const coordinator = createNewsPipelineCoordinator({
    getConfig: () => ({ news: { enabled: true, maxItems: 1, mode: "topic" } }),
    getConnector: () => connector,
    personaRouter: { get: () => persona, defaultPersona: () => persona },
    contextBuilder: { build: () => { throw new Error("generic ContextBuilder must not be used by the new news-prompt stage"); } },
    speechQueue: { enqueue: (payload) => { delivered.push(payload); return { state: "waiting" }; } },
    store,
    clock: () => 1000,
    onRead: (payload) => reads.push(payload),
    stages: {
      acquire: { id: "acquire", run: async () => [item] },
      select: createSelectStage({ store, clock: () => 1000, historyStore }),
      generate: createNewsPromptGenerateStage({ getConnector: () => connector }),
      quality: createNewsQualityGateStage(),
    },
  });

  const result = await coordinator.run({ generation: 1 });
  assert.equal(result.status, "delivered");
  assert.equal(call, 2, "the malformed first attempt must trigger exactly one rewrite");
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0].text, /===[A-Z_]+===/, "raw markers must never reach SpeechQueue");
  assert.ok(delivered[0].text.includes("十分な長さと構造化"), "the well-formed rewrite's body must reach delivery");
  assert.equal(reads[0].text, delivered[0].text, "onRead and deliver must receive the same sanitized body");
});
