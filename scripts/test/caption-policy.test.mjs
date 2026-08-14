// 英語CC (issue #282) の受理policy・有界キュー・health決定のテスト。
//
// 「Twitchへ日本語原文を一切送らない」「interimを送らない」「翻訳失敗時にフォールバックしない」
// という受け入れ条件の中核がここに集まっているため、実機 (Chrome/OBS/Twitch) を使わずに
// 自動検証できる範囲はすべてこのファイルで押さえる。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { validateConfigStructure } from "../../src/config/config-validation.js";
import { applyConfigDefaults } from "../../src/config/config-defaults.js";
import { splitConnectorSecrets } from "../../src/config/config-secrets-split.js";
import { createConfigExport } from "../../src/config/config-export.js";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { CaptionPolicy, normalizeCaptionText, containsSourceLanguage, hasControlCharacters, applyCaptionReplacements, splitCaption } from "./electron/main/services/captions/caption-policy.ts";
export { resolveCaptionHealth } from "./electron/main/services/captions/caption-health.ts";
export { readCaptionsConfig } from "./electron/main/services/captions/captions-config.ts";`,
      resolveDir: repoRoot,
      sourcefile: "caption-policy-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-caption-policy-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const OPTIONS = { maxPending: 2, maxAgeMs: 5_000, maxCaptionChars: 0, replacements: {} };
const caption = (overrides = {}) => ({ sequence: 1, isFinal: true, recognized: "こんばんは", text: "Good evening.", ageMs: 0, ...overrides });

async function withModules(run) {
  const { modules, directory } = await loadModules();
  try { await run(modules); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("finalな英訳だけを受理し、interimは送出しない", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    const accepted = policy.evaluate(caption(), { connectionGeneration: policy.generation });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.segments, ["Good evening."]);
    const interim = policy.evaluate(caption({ isFinal: false, text: "Good ev" }), { connectionGeneration: policy.generation });
    assert.deepEqual(interim, { ok: false, reason: "not-final" });
  });
});

test("日本語が残った翻訳結果・空文字・制御文字・過大な本文を拒否する", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    // 翻訳が素通ししたケース (issue #282: Twitchへ日本語原文を一切送らない)
    assert.deepEqual(policy.evaluate(caption({ text: "こんばんは" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    assert.deepEqual(policy.evaluate(caption({ text: "Good evening、everyone" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    assert.deepEqual(policy.evaluate(caption({ text: "Tokyo 東京" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    // 半角句読点・半角濁点・CJK拡張B以降 (サロゲートペア) も素通しさせない
    assert.deepEqual(policy.evaluate(caption({ text: "Hello｡" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    assert.deepEqual(policy.evaluate(caption({ text: "Hello ｶﾞ" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    assert.deepEqual(policy.evaluate(caption({ text: "Name: \u{20B9F}" }), { connectionGeneration: 0 }), { ok: false, reason: "source-language-leak" });
    assert.deepEqual(policy.evaluate(caption({ text: "   " }), { connectionGeneration: 0 }), { ok: false, reason: "empty" });
    assert.deepEqual(policy.evaluate(caption({ text: "Goodevening" }), { connectionGeneration: 0 }), { ok: false, reason: "control-characters" });
    assert.deepEqual(policy.evaluate(caption({ text: "a".repeat(501) }), { connectionGeneration: 0 }), { ok: false, reason: "too-long" });
  });
});

test("全角スペース・改行は空白へ正規化され、それ自体は拒否理由にならない", async () => {
  await withModules(({ CaptionPolicy, normalizeCaptionText, containsSourceLanguage, hasControlCharacters }) => {
    assert.equal(normalizeCaptionText("  Good\n evening　everyone "), "Good evening everyone");
    assert.equal(containsSourceLanguage("Good evening"), false);
    assert.equal(hasControlCharacters("Good\tevening"), false);
    const policy = new CaptionPolicy(OPTIONS);
    const result = policy.evaluate(caption({ text: "Good\nevening　everyone" }), { connectionGeneration: 0 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.segments, ["Good evening everyone"]);
  });
});

test("直前と同じ字幕・期限切れ・停止後のstale generationを破棄する", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    assert.equal(policy.evaluate(caption(), { connectionGeneration: 0 }).ok, true);
    assert.deepEqual(policy.evaluate(caption({ sequence: 2 }), { connectionGeneration: 0 }), { ok: false, reason: "duplicate" });
    assert.deepEqual(policy.evaluate(caption({ sequence: 3, text: "Later.", ageMs: 5_001 }), { connectionGeneration: 0 }), { ok: false, reason: "expired" });
    const generation = policy.reset();
    assert.equal(generation, 1);
    // 停止前 (generation 0) の接続から遅れて届いた結果は落とす
    assert.deepEqual(policy.evaluate(caption({ sequence: 4, text: "Stale." }), { connectionGeneration: 0 }), { ok: false, reason: "stale-generation" });
    // resetで重複排除の記憶も消えるので、同じ本文が再び通る
    assert.equal(policy.evaluate(caption({ sequence: 5 }), { connectionGeneration: 1 }).ok, true);
  });
});

test("キューは上限で溢れた分を捨て、待ち時間を含めて期限切れを捨てる", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy({ ...OPTIONS, maxPending: 2 });
    // 同一発話の3分割: 文の先頭を残し、収まらない末尾を落とす (自分の先頭は追い出さない)
    const dropped = policy.enqueue(["one", "two", "three"], { sequence: 1, now: 1_000, ageMs: 0, source: "one two three" });
    assert.equal(dropped.dropped, 1);
    assert.deepEqual(dropped.droppedSequences, [1]);
    assert.deepEqual(dropped.droppedSources, ["one two three"]);
    assert.equal(policy.pending, 2);
    assert.equal(policy.take(1_000).caption.text, "one");
    assert.equal(policy.take(1_000).caption.text, "two");
    assert.equal(policy.take(1_000).caption, null);
    // 認識からの経過(ageMs) + キュー待ち時間 が maxAgeMs を超えたものは送らない
    policy.enqueue(["late"], { sequence: 2, now: 1_000, ageMs: 4_000, source: "late" });
    const taken = policy.take(2_500);
    assert.equal(taken.caption, null);
    assert.equal(taken.expired, 1);
  });
});

test("送出できなかった字幕だけが重複排除の記憶から外れ、言い直しが通る", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    assert.equal(policy.evaluate(caption(), { connectionGeneration: 0 }).ok, true);
    assert.deepEqual(policy.evaluate(caption({ sequence: 2 }), { connectionGeneration: 0 }), { ok: false, reason: "duplicate" });
    // OBS送出失敗・期限切れ・queue溢れでTwitchへ届かなかった場合に、その字幕の全文を渡して呼ぶ
    policy.forgetLastSent("Good evening.");
    assert.equal(policy.evaluate(caption({ sequence: 3 }), { connectionGeneration: 0 }).ok, true);
  });
});

test("これから送出される字幕の記憶は、別の字幕を捨てても消えない", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    assert.equal(policy.evaluate(caption(), { connectionGeneration: 0 }).ok, true);
    // 溢れて捨てられたのは以前の字幕。記憶の主 ("Good evening.") はキューに残って送出される。
    policy.forgetLastSent("An older caption.");
    // 無条件に消していると、直後の同一文が通ってTwitchへ二重に出てしまう
    assert.deepEqual(policy.evaluate(caption({ sequence: 4 }), { connectionGeneration: 0 }), { ok: false, reason: "duplicate" });
  });
});

test("clearQueueは世代を進めずキューだけを捨て、捨てたsequenceを返す", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy(OPTIONS);
    policy.enqueue(["one"], { sequence: 1, now: 0, ageMs: 0, source: "one" });
    assert.deepEqual(policy.clearQueue(), { dropped: 1, droppedSequences: [1], droppedSources: ["one"] });
    assert.equal(policy.pending, 0);
    assert.equal(policy.generation, 0);
  });
});

test("分割した字幕は自分自身の先頭segmentを追い出さず、収まらない末尾だけを落とす", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy({ ...OPTIONS, maxPending: 2 });
    // maxPending=2 のキューへ3分割の字幕を積む: 文の先頭 s1/s2 が残り、末尾 s3 が落ちる
    const result = policy.enqueue(["s1", "s2", "s3"], { sequence: 7, now: 0, ageMs: 0, source: "s1 s2 s3" });
    assert.deepEqual(result, { dropped: 1, droppedSequences: [7], droppedSources: ["s1 s2 s3"] });
    assert.equal(policy.take(0).caption.text, "s1");
    assert.equal(policy.take(0).caption.text, "s2");
    assert.equal(policy.take(0).caption, null);
  });
});

test("新しい発話は以前の発話を追い出して優先される", async () => {
  await withModules(({ CaptionPolicy }) => {
    const policy = new CaptionPolicy({ ...OPTIONS, maxPending: 2 });
    policy.enqueue(["old1"], { sequence: 1, now: 0, ageMs: 0, source: "old1" });
    policy.enqueue(["old2"], { sequence: 2, now: 0, ageMs: 0, source: "old2" });
    const result = policy.enqueue(["new1"], { sequence: 3, now: 0, ageMs: 0, source: "new1" });
    assert.deepEqual(result, { dropped: 1, droppedSequences: [1], droppedSources: ["old1"] });
    assert.equal(policy.take(0).caption.text, "old2");
    assert.equal(policy.take(0).caption.text, "new1");
  });
});

test("長文は語境界で分割し、1語が上限を超える場合だけ強制的に切る", async () => {
  await withModules(({ splitCaption }) => {
    assert.deepEqual(splitCaption("one two three four", 0), ["one two three four"]);
    assert.deepEqual(splitCaption("one two three four", 9), ["one two", "three", "four"]);
    assert.deepEqual(splitCaption("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  });
});

test("固有名詞置換は長いキーを優先し、置換結果を再走査しない", async () => {
  await withModules(({ applyCaptionReplacements, CaptionPolicy }) => {
    assert.equal(applyCaptionReplacements("doci ai and doci", { doci: "DOCI", "doci ai": "dociai" }), "dociai and DOCI");
    // 相互参照する辞書でも無限ループしない
    assert.equal(applyCaptionReplacements("ab", { a: "b", b: "a" }), "ba");
    const policy = new CaptionPolicy({ ...OPTIONS, replacements: { "doci ai": "dociai" } });
    const result = policy.evaluate(caption({ text: "Welcome to doci ai." }), { connectionGeneration: 0 });
    assert.deepEqual(result.segments, ["Welcome to dociai."]);
  });
});

test("healthは上流から順に決まり、送出条件が揃ってはじめてsendingになる", async () => {
  await withModules(({ resolveCaptionHealth }) => {
    const base = {
      enabled: true, running: true, chromeFound: true, workerConnected: true, workerState: "recognizing",
      obsConnected: true, obsCaptionSupported: true, obsStreaming: true, micMuted: false, sendingRecently: false, hasError: false,
    };
    assert.equal(resolveCaptionHealth({ ...base, enabled: false }), "disabled");
    assert.equal(resolveCaptionHealth({ ...base, running: false }), "disabled");
    assert.equal(resolveCaptionHealth({ ...base, hasError: true }), "error");
    assert.equal(resolveCaptionHealth({ ...base, chromeFound: false }), "chrome_not_found");
    assert.equal(resolveCaptionHealth({ ...base, workerConnected: false }), "worker_disconnected");
    assert.equal(resolveCaptionHealth({ ...base, workerState: "microphone_permission_required" }), "microphone_permission_required");
    assert.equal(resolveCaptionHealth({ ...base, workerState: "translator_downloading" }), "translator_downloading");
    assert.equal(resolveCaptionHealth({ ...base, obsConnected: false }), "obs_disconnected");
    assert.equal(resolveCaptionHealth({ ...base, obsCaptionSupported: false }), "obs_disconnected");
    assert.equal(resolveCaptionHealth({ ...base, obsStreaming: false }), "obs_not_streaming");
    assert.equal(resolveCaptionHealth({ ...base, micMuted: true }), "mic_muted");
    assert.equal(resolveCaptionHealth({ ...base, sendingRecently: true }), "sending");
    assert.equal(resolveCaptionHealth(base), "recognizing");
  });
});

test("captions設定の読み出しは壊れた値を安全側の既定へ丸める", async () => {
  await withModules(({ readCaptionsConfig }) => {
    const defaults = readCaptionsConfig({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.workerPort, 0);
    assert.equal(defaults.obs.port, 4455);
    assert.equal(defaults.maxPending, 2);
    const broken = readCaptionsConfig({ captions: { enabled: true, workerPort: "abc", maxPending: 999, maxAgeMs: 1, obs: { port: -1, microphoneInputName: 5 }, replacements: { ok: "OK", bad: 3 } } });
    assert.equal(broken.enabled, true);
    assert.equal(broken.workerPort, 0);
    assert.equal(broken.maxPending, 2);
    assert.equal(broken.maxAgeMs, 5_000);
    assert.equal(broken.obs.port, 4455);
    assert.equal(broken.obs.microphoneInputName, "");
    assert.deepEqual(broken.replacements, { ok: "OK" });
  });
});

// ---- config側 (src/config/*) の検証 ----

const baseConfig = (captions) => applyConfigDefaults({
  schemaVersion: 3,
  connectors: { mock: { provider: "mock" } },
  personas: [{ id: "p", name: "P", connector: "mock" }],
  triggers: {},
  ...(captions === undefined ? {} : { captions }),
});

const errorPaths = (config) => validateConfigStructure(config).issues.filter((issue) => issue.severity === "error").map((issue) => issue.path.join("."));

test("captionsは既定でOFFのopt-inで、既存configの検証結果を変えない", () => {
  assert.equal(baseConfig().captions.enabled, false);
  assert.deepEqual(errorPaths(baseConfig()), []);
  // 有効にしただけの既定値一式はそのまま通る
  assert.deepEqual(errorPaths(baseConfig({ enabled: true })), []);
});

test("captions.obs.passwordを設定へ直接書くと、有効・無効に関わらずerrorになる", () => {
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, obs: { password: "s3cret" } })), ["captions.obs.password"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: false, obs: { password: "s3cret" } })), ["captions.obs.password"]);
});

test("captions有効時のenum・範囲を検証する", () => {
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, sourceLanguage: "en-US" })), ["captions.sourceLanguage"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, targetLanguage: "fr" })), ["captions.targetLanguage"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, recognitionEngine: "whisper" })), ["captions.recognitionEngine"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, translationEngine: "deepl" })), ["captions.translationEngine"]);
  // 0は「自動」なので許可、1〜1023は特権ポートなので拒否
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, workerPort: 0 })), []);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, workerPort: 80 })), ["captions.workerPort"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, maxPending: 0 })), ["captions.maxPending"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, maxAgeMs: 100 })), ["captions.maxAgeMs"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, maxCaptionChars: 501 })), ["captions.maxCaptionChars"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, obs: { host: "  " } })), ["captions.obs.host"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, replacements: [1, 2] })), ["captions.replacements"]);
  assert.deepEqual(errorPaths(baseConfig({ enabled: true, replacements: { ok: 3 } })), ["captions.replacements"]);
});

test("OBSパスワードは設定exportに含まれず、legacy importではsecret storeへ分離される", () => {
  const config = baseConfig({ enabled: true });
  config.captions.obs.password = "s3cret";
  const exported = JSON.stringify(createConfigExport(config));
  assert.equal(exported.includes("s3cret"), false);
  const { publicConfig, secretEntries } = splitConnectorSecrets(config);
  assert.equal("password" in publicConfig.captions.obs, false);
  assert.equal(publicConfig.captions.obs.passwordConfigured, true);
  assert.deepEqual(secretEntries.filter((entry) => entry.key === "captions.obs.password"), [{ key: "captions.obs.password", value: "s3cret" }]);
});
