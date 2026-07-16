import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
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
