// issue #257 Phase 5 (#264): translation:translate IPC入力のenum/文字列長に対する検証テスト
// (セキュリティレビュー観点: 不正なsourceLanguage/targetLanguage・過大なtext・不正な型が
// register.ts境界で確実に拒否されることを確認する)。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { parseTranslateInput } from "./electron/main/ipc/translation-input.ts"; export { PublicIpcError } from "./electron/shared/errors.ts"; export { MAX_TRANSLATE_INPUT_CHARS } from "./electron/shared/services/translation-contract.ts";`,
      resolveDir: repoRoot,
      sourcefile: "translation-ipc-validation-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    // translation-input.ts (unlike register.ts itself, which also imports `electron` for ipcMain)
    // has zero Electron/native dependencies, so this bundle stays plain-Node-importable. Keeping
    // onnxruntime-node/sharp external is unnecessary here (nothing in this bundle reaches them) but
    // harmless — kept for consistency with the other translation test files' build() config.
    external: ["onnxruntime-node", "sharp"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-ipc-validation-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

const validInput = { text: "Thank you for the stream!", sourceLanguage: "en", targetLanguage: "ja" };

test("accepts a well-formed request and passes requestId/generation/ownerId through", async () => {
  const { modules, directory } = await loadModules();
  try {
    const result = modules.parseTranslateInput({ ...validInput, requestId: "req-1", generation: 3, ownerId: "console" });
    assert.deepEqual(result, { text: validInput.text, sourceLanguage: "en", targetLanguage: "ja", requestId: "req-1", generation: 3, ownerId: "console" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects non-object input (null, array, string, number)", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const bad of [null, undefined, [], "text", 42, true]) {
      assert.throws(() => modules.parseTranslateInput(bad), modules.PublicIpcError, JSON.stringify(bad));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects missing/empty/non-string text", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const bad of [{ ...validInput, text: undefined }, { ...validInput, text: "" }, { ...validInput, text: 123 }, { ...validInput, text: null }, { ...validInput, text: ["a"] }]) {
      assert.throws(() => modules.parseTranslateInput(bad), modules.PublicIpcError, JSON.stringify(bad));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects text longer than MAX_TRANSLATE_INPUT_CHARS, accepts exactly the boundary", async () => {
  const { modules, directory } = await loadModules();
  try {
    const atLimit = "x".repeat(modules.MAX_TRANSLATE_INPUT_CHARS);
    assert.doesNotThrow(() => modules.parseTranslateInput({ ...validInput, text: atLimit }));
    const overLimit = "x".repeat(modules.MAX_TRANSLATE_INPUT_CHARS + 1);
    assert.throws(() => modules.parseTranslateInput({ ...validInput, text: overLimit }), modules.PublicIpcError);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects any sourceLanguage outside the en/fr enum, including case variants and injection-shaped strings", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const bad of ["EN", "de", "en-US", "en ", " en", "en\0", "fr;drop table", "*", "", null, undefined, 1, ["en"], { en: true }]) {
      assert.throws(() => modules.parseTranslateInput({ ...validInput, sourceLanguage: bad }), modules.PublicIpcError, JSON.stringify(bad));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects any targetLanguage other than the literal 'ja'", async () => {
  const { modules, directory } = await loadModules();
  try {
    for (const bad of ["en", "JA", "ja ", "jpn", "", null, undefined, 1]) {
      assert.throws(() => modules.parseTranslateInput({ ...validInput, targetLanguage: bad }), modules.PublicIpcError, JSON.stringify(bad));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("ignores requestId/generation/ownerId of the wrong type rather than throwing or passing them through unchecked", async () => {
  const { modules, directory } = await loadModules();
  try {
    const result = modules.parseTranslateInput({ ...validInput, requestId: 12345, generation: "not-a-number", ownerId: { nested: true } });
    assert.deepEqual(result, { text: validInput.text, sourceLanguage: "en", targetLanguage: "ja" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an oversized JSON payload (well beyond a plausible comment) is rejected by expectRecord's own size cap", async () => {
  const { modules, directory } = await loadModules();
  try {
    // expectRecord (shared/validation.ts) caps at 256_000 JSON-serialized chars regardless of any
    // one field's own limit — a defense-in-depth check against a payload padded with unrelated
    // oversized junk fields rather than just an oversized `text`.
    const bloated = { ...validInput, junk: "x".repeat(300_000) };
    assert.throws(() => modules.parseTranslateInput(bloated), modules.PublicIpcError);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
