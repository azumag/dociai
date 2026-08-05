import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

async function loadModule() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({ stdin: { contents: `export { backfillReferencedTriggers } from "./electron/main/config/seed-merge.ts";`, resolveDir: root, sourcefile: "seed-merge-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "dociai-seed-merge-"));
  const file = path.join(directory, "module.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function loadSeedAiConnectorConfig() {
  const root = path.resolve(new URL("../..", import.meta.url).pathname);
  const result = await build({ stdin: { contents: `export { seedAiConnectorConfig } from "./electron/main/config/seed-ai-connector-config.ts";`, resolveDir: root, sourcefile: "seed-ai-connector-config-test.ts", loader: "ts" }, bundle: true, format: "esm", platform: "node", write: false });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-seed-ai-connector-"));
  const file = path.join(directory, "module.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

function fakeConfigRepository(initialConfig) {
  let config = initialConfig;
  return {
    async getPublic() { return { config, revision: "rev-1", warnings: [] }; },
    async save(next) { config = next; return { saved: true, revision: "rev-2" }; },
  };
}

function fakeSecretStore() {
  const values = new Map();
  return {
    values,
    isPersistentAvailable() { return true; },
    async listStatus(keys) { return (keys ?? [...values.keys()]).map((key) => ({ key, configured: values.has(key), persistent: true })); },
    async getForService(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}

test("backfillReferencedTriggers adds only trigger IDs referenced by the backfilled personas that are missing from current triggers", async () => {
  const { modules, directory } = await loadModule();
  try {
    const current = { keep_me: { type: "manual" } };
    const backfilledPersonas = [
      { id: "doci", triggers: ["mention_ai", "hotkey_partner", "manual"] },
      { id: "meriken", triggers: ["random_comment"] },
    ];
    const legacy = {
      mention_ai: { type: "keyword", keywords: ["AIさん"] },
      hotkey_partner: { type: "hotkey", keys: "Alt+1" },
      random_comment: { type: "random", probability: 0.2 },
      unrelated_legacy_trigger: { type: "manual" },
    };
    const result = modules.backfillReferencedTriggers(current, backfilledPersonas, legacy);
    assert.deepEqual(result, {
      keep_me: { type: "manual" },
      mention_ai: legacy.mention_ai,
      hotkey_partner: legacy.hotkey_partner,
      random_comment: legacy.random_comment,
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("backfillReferencedTriggers does not touch triggers that already exist", async () => {
  const { modules, directory } = await loadModule();
  try {
    const current = { mention_ai: { type: "keyword", keywords: ["現行"] } };
    const backfilledPersonas = [{ id: "doci", triggers: ["mention_ai"] }];
    const legacy = { mention_ai: { type: "keyword", keywords: ["legacy"] } };
    const result = modules.backfillReferencedTriggers(current, backfilledPersonas, legacy);
    assert.equal(result, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("backfillReferencedTriggers heals dangling references left in already-persisted personas", async () => {
  // 旧バージョンのseedがtrigger補完なしでpersonasだけをconfig.jsonへ保存してしまった状態。
  // personasはbackfill対象でなくても、宙に浮いた参照はlegacy configから毎起動で修復される。
  const { modules, directory } = await loadModule();
  try {
    const persistedPersonas = [
      { id: "doci", triggers: ["mention_ai", "hotkey_partner", "manual"] },
      { id: "meriken", triggers: ["random_comment"] },
    ];
    const legacy = {
      mention_ai: { type: "keyword", keywords: ["AIさん"] },
      hotkey_partner: { type: "hotkey", keys: "Alt+1" },
      random_comment: { type: "random", probability: 0.2 },
    };
    const result = modules.backfillReferencedTriggers({}, persistedPersonas, legacy);
    assert.deepEqual(result, legacy);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("backfillReferencedTriggers returns null when no personas were backfilled", async () => {
  const { modules, directory } = await loadModule();
  try {
    const result = modules.backfillReferencedTriggers({}, undefined, { mention_ai: { type: "keyword", keywords: ["x"] } });
    assert.equal(result, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("backfillReferencedTriggers ignores 'manual' and IDs missing from legacy config too", async () => {
  const { modules, directory } = await loadModule();
  try {
    const backfilledPersonas = [{ id: "doci", triggers: ["manual", "totally_unknown"] }];
    const result = modules.backfillReferencedTriggers({}, backfilledPersonas, {});
    assert.equal(result, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// #254: 設定UIで設定し直した本物のTodoistトークンが、毎起動のseedAiConnectorConfigによって
// bundle同梱のconfig.local.example.json (またはlegacy config.local.json) が持つ配列index基準の
// 同じキー (topics.sources.0.token) で静かに上書きされ、次回のTodoist取得が401になる不具合の
// 回帰テスト。「topicsセクションが既にconfig.jsonにある(=missingTopicsでない)」状態では
// secretStoreへ一切書き込まない (=既存の本物のトークンを上書きしない)ことを確認する。
test("seedAiConnectorConfig does not re-seed an already-configured topics token from the bundled example config on every launch", async () => {
  const { modules, directory } = await loadSeedAiConnectorConfig();
  try {
    const appPath = path.join(directory, "app");
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, "config.local.example.json"), JSON.stringify({
      connectors: { openai_main: { provider: "openai", apiKey: "sk-example-placeholder" } },
      topics: { sources: [{ name: "Todoist", type: "todoist", enabled: true, token: "your_todoist_personal_api_token" }] },
    }));
    const paths = {
      configFile: path.join(directory, "config.local.json"), // does not exist -> falls back to the bundled example above
      configRepositoryFile: path.join(directory, "config.json"),
    };
    await fs.writeFile(paths.configRepositoryFile, "{}"); // not a fresh install
    const configRepository = fakeConfigRepository({
      topics: { sources: [{ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }] },
      personas: [{ id: "doci", triggers: [] }],
    });
    const secretStore = fakeSecretStore();
    await secretStore.set("topics.sources.0.token", "the-real-user-todoist-token");

    await modules.seedAiConnectorConfig(configRepository, secretStore, paths, appPath);

    assert.equal(await secretStore.getForService("topics.sources.0.token"), "the-real-user-todoist-token");
    assert.equal(secretStore.values.has("connectors.openai_main.apiKey"), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("seedAiConnectorConfig still seeds secrets from the bundled example config on a genuine fresh install", async () => {
  const { modules, directory } = await loadSeedAiConnectorConfig();
  try {
    const appPath = path.join(directory, "app");
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, "config.local.example.json"), JSON.stringify({
      connectors: { openai_main: { provider: "openai", apiKey: "sk-example-placeholder" } },
      topics: { sources: [{ name: "Todoist", type: "todoist", enabled: true, token: "your_todoist_personal_api_token" }] },
      personas: [{ id: "doci", triggers: [] }],
    }));
    const paths = {
      configFile: path.join(directory, "config.local.json"), // does not exist -> falls back to the bundled example above
      configRepositoryFile: path.join(directory, "config.json"), // does not exist -> fresh install
    };
    const configRepository = fakeConfigRepository({});
    const secretStore = fakeSecretStore();

    await modules.seedAiConnectorConfig(configRepository, secretStore, paths, appPath);

    assert.equal(await secretStore.getForService("topics.sources.0.token"), "your_todoist_personal_api_token");
    assert.equal(await secretStore.getForService("connectors.openai_main.apiKey"), "sk-example-placeholder");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// missingNews/missingTopicsが独立に効くことの確認 (両方まとめて既存 or 両方まとめて新規、の
// 2択だけでは「片方だけ未migrateなアップグレード」を見落とす)。topicsは既にconfig.jsonにあるので
// legacy configの値で上書きされず、newsはまだ無いのでlegacy configから正しく取り込まれる。
test("seedAiConnectorConfig seeds only the section that is actually missing (news), leaving an already-present section (topics) alone, on a non-fresh-install upgrade", async () => {
  const { modules, directory } = await loadSeedAiConnectorConfig();
  try {
    const appPath = path.join(directory, "app");
    await fs.mkdir(appPath, { recursive: true });
    const configFile = path.join(directory, "config.local.json"); // a real, existing legacy file (not the bundled example)
    await fs.writeFile(configFile, JSON.stringify({
      topics: { sources: [{ name: "Todoist", type: "todoist", enabled: true, token: "stale-legacy-topics-token" }] },
      news: { sources: [{ name: "RSS", type: "rss-token-source", enabled: true, token: "real-legacy-news-token" }] },
    }));
    const paths = { configFile, configRepositoryFile: path.join(directory, "config.json") };
    await fs.writeFile(paths.configRepositoryFile, "{}"); // not a fresh install
    const configRepository = fakeConfigRepository({
      topics: { sources: [{ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }] },
      personas: [{ id: "doci", triggers: [] }],
      // news is absent -> missingNews === true
    });
    const secretStore = fakeSecretStore();
    await secretStore.set("topics.sources.0.token", "the-real-user-todoist-token");

    await modules.seedAiConnectorConfig(configRepository, secretStore, paths, appPath);

    assert.equal(await secretStore.getForService("topics.sources.0.token"), "the-real-user-todoist-token", "an already-present section must not be re-seeded from legacy config");
    assert.equal(await secretStore.getForService("news.sources.0.token"), "real-legacy-news-token", "a genuinely missing section must still be migrated from legacy config");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// legacy config.local.json自体(bundleのexampleではなく実ファイル)は、移管したsecretのplaintextを
// 保持し続けてはいけない(次回以降ずっとplaintextがディスク上に残ってしまう)。
test("seedAiConnectorConfig strips the migrated plaintext token out of a real legacy config.local.json after seeding it", async () => {
  const { modules, directory } = await loadSeedAiConnectorConfig();
  try {
    const appPath = path.join(directory, "app");
    await fs.mkdir(appPath, { recursive: true });
    const configFile = path.join(directory, "config.local.json");
    await fs.writeFile(configFile, JSON.stringify({
      topics: { sources: [{ name: "Todoist", type: "todoist", enabled: true, token: "the-real-user-todoist-token" }] },
      personas: [{ id: "doci", triggers: [] }],
    }));
    const paths = { configFile, configRepositoryFile: path.join(directory, "config.json") }; // does not exist -> fresh install
    const configRepository = fakeConfigRepository({});
    const secretStore = fakeSecretStore();

    await modules.seedAiConnectorConfig(configRepository, secretStore, paths, appPath);

    assert.equal(await secretStore.getForService("topics.sources.0.token"), "the-real-user-todoist-token");
    const rewritten = JSON.parse(await fs.readFile(configFile, "utf8"));
    assert.equal(rewritten.topics.sources[0].token, undefined, "plaintext token must not remain on disk after migration");
    assert.equal(rewritten.topics.sources[0].tokenConfigured, true);
    assert.equal(rewritten.topics.sources[0].tokenSecretRef, "topics.sources.0.token");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// PR #274のreviewで指摘された不具合の回帰テスト: sectionNeedsSeedでsecretStoreへの書き込みは
// gateしても、legacy config.local.json本体からplaintextを剥がして書き戻すwritePublicConfigの方を
// gateし忘れると、「secretStoreへは一切保存していないのに、legacy config.local.json側の
// plaintextだけは消えてしまい、値がどこにも残らなくなる」という新しい破壊パターンが生まれる。
// topics (既にconfig.jsonにありseedされない) はfileの中でplaintextのまま残り、news (missingで
// 実際にseedされる) だけがfileの中でも正しく剥がされることを確認する。
test("seedAiConnectorConfig leaves an unseeded section's plaintext token intact in config.local.json, stripping only the section it actually seeded", async () => {
  const { modules, directory } = await loadSeedAiConnectorConfig();
  try {
    const appPath = path.join(directory, "app");
    await fs.mkdir(appPath, { recursive: true });
    const configFile = path.join(directory, "config.local.json");
    await fs.writeFile(configFile, JSON.stringify({
      topics: { sources: [{ name: "Todoist", type: "todoist", enabled: true, token: "hand-edited-but-not-yet-migrated-topics-token" }] },
      news: { sources: [{ name: "RSS", type: "rss-token-source", enabled: true, token: "real-legacy-news-token" }] },
    }));
    const paths = { configFile, configRepositoryFile: path.join(directory, "config.json") };
    await fs.writeFile(paths.configRepositoryFile, "{}"); // not a fresh install
    const configRepository = fakeConfigRepository({
      topics: { sources: [{ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, tokenConfigured: true, tokenSecretRef: "topics.sources.0.token" }] },
      personas: [{ id: "doci", triggers: [] }],
      // news is absent -> missingNews === true
    });
    const secretStore = fakeSecretStore();
    await secretStore.set("topics.sources.0.token", "the-real-user-todoist-token");

    await modules.seedAiConnectorConfig(configRepository, secretStore, paths, appPath);

    assert.equal(await secretStore.getForService("topics.sources.0.token"), "the-real-user-todoist-token");
    const rewritten = JSON.parse(await fs.readFile(configFile, "utf8"));
    assert.equal(rewritten.topics.sources[0].token, "hand-edited-but-not-yet-migrated-topics-token", "an unseeded section's plaintext must survive on disk, not vanish with nowhere to go");
    assert.equal(rewritten.news.sources[0].token, undefined, "a section that WAS actually seeded must still have its plaintext stripped");
    assert.equal(rewritten.news.sources[0].tokenSecretRef, "news.sources.0.token");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
