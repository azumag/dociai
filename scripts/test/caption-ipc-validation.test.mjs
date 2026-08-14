// captions:test IPC入力の検証テスト (issue #282)。
// セキュリティレビュー観点: Rendererから任意のOBS接続先・パスワード・実行ファイル引数を
// 渡せないこと、CaptionStatusにsecretが含まれないことをIPC境界で確認する。
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { parseCaptionTestInput } from "./electron/main/ipc/caption-input.ts";
export { PublicIpcError } from "./electron/shared/errors.ts";
export { MAX_CAPTION_TEXT_CHARS } from "./electron/shared/services/caption-contract.ts";`,
      resolveDir: repoRoot,
      sourcefile: "caption-ipc-validation-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-caption-ipc-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function withModules(run) {
  const { modules, directory } = await loadModules();
  try { await run(modules); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("textだけを受理する", async () => {
  await withModules(({ parseCaptionTestInput, MAX_CAPTION_TEXT_CHARS }) => {
    assert.deepEqual(parseCaptionTestInput({ text: "dociai caption test." }), { text: "dociai caption test." });
    assert.equal(MAX_CAPTION_TEXT_CHARS, 500);
  });
});

test("OBS接続先・パスワード・実行ファイルなどの追加キーを拒否する", async () => {
  await withModules(({ parseCaptionTestInput, PublicIpcError }) => {
    for (const payload of [
      { text: "hi", password: "s3cret" },
      { text: "hi", obs: { host: "10.0.0.1", port: 4455 } },
      { text: "hi", chromeExecutable: "/bin/sh" },
      { text: "hi", workerPort: 1234 },
    ]) {
      assert.throws(() => parseCaptionTestInput(payload), (error) => error instanceof PublicIpcError && error.code === "INVALID_INPUT");
    }
  });
});

test("不正な型・空文字・過大なtextを拒否する", async () => {
  await withModules(({ parseCaptionTestInput, PublicIpcError }) => {
    const invalid = (error) => error instanceof PublicIpcError && error.code === "INVALID_INPUT";
    assert.throws(() => parseCaptionTestInput(undefined), invalid);
    assert.throws(() => parseCaptionTestInput("hi"), invalid);
    assert.throws(() => parseCaptionTestInput([{ text: "hi" }]), invalid);
    assert.throws(() => parseCaptionTestInput({ text: "" }), invalid);
    assert.throws(() => parseCaptionTestInput({ text: 42 }), invalid);
    assert.throws(() => parseCaptionTestInput({ text: "a".repeat(501) }), invalid);
  });
});

test("captions関連のIPC channelはpreloadで公開された5つだけ", async () => {
  const channels = await fs.readFile(path.join(repoRoot, "electron/shared/ipc-channels.ts"), "utf8");
  const captionChannels = [...channels.matchAll(/^\s+(CAPTIONS_\w+): "([^"]+)"/gm)].map((match) => match[2]);
  assert.deepEqual(captionChannels.sort(), ["captions:open-worker", "captions:start", "captions:status", "captions:stop", "captions:test"]);
  const preload = await fs.readFile(path.join(repoRoot, "electron/preload/index.ts"), "utf8");
  for (const channel of ["CAPTIONS_STATUS", "CAPTIONS_OPEN_WORKER", "CAPTIONS_START", "CAPTIONS_STOP", "CAPTIONS_TEST"]) {
    assert.match(preload, new RegExp(`CHANNELS\\.${channel}`), `${channel} must be exposed through preload`);
  }
});

test("CaptionStatusの型にtoken・password・URLが含まれない", async () => {
  const contract = await fs.readFile(path.join(repoRoot, "electron/shared/services/caption-contract.ts"), "utf8");
  const status = contract.slice(contract.indexOf("export type CaptionStatus = {"), contract.indexOf("export type CaptionTestInput"));
  for (const forbidden of [/\btoken\b/i, /\bpassword\b/i, /\burl\b/i, /\bsecret\b/i]) {
    assert.equal(forbidden.test(status), false, `CaptionStatus must not expose ${forbidden}`);
  }
});
