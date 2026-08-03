// issue #267: guards the esbuild `alias` config (scripts/electron/build.mjs) that redirects
// "onnxruntime-node" -> electron/main/native/onnxruntime-node-shim.cjs and "sharp" ->
// electron/main/native/sharp-stub.cjs. Nothing in scripts/release/smoke-packaged.mjs or
// test:electron:translation (both packaged/dev-only, neither in CI) ever actually imports
// @huggingface/transformers, so a regression in the sharp stub's export shape — which must be
// truthy or transformers.js throws "Unable to load image processing library." at module scope —
// would otherwise break translation silently in every environment, dev and packaged alike, with
// no automated test catching it (a real gap found during #267's implementation review).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nativeDir = path.join(repoRoot, "electron/main/native");
const require = createRequire(import.meta.url);

test("the onnxruntime-node/sharp esbuild alias config lets @huggingface/transformers import without throwing", async () => {
  // The output file must live inside the repo tree (not os.tmpdir()) — the shim's dev-mode
  // fallback does a variable-bound require("onnxruntime-node") that relies on Node's normal
  // ancestor-directory node_modules walk finding the real package, exactly like main.cjs does
  // once bundled to dist/electron/. An /tmp output would fail for an unrelated reason (no
  // ancestor node_modules) and mask a real regression in the alias/shim mechanism itself.
  const outfile = path.join(repoRoot, "dist", ".native-bundling-test.cjs");
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  try {
    await build({
      stdin: {
        contents: 'export * as transformers from "@huggingface/transformers";',
        resolveDir: repoRoot,
        sourcefile: "native-bundling-test-entry.mjs",
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron", "node-llama-cpp"],
      alias: {
        "onnxruntime-node": path.join(nativeDir, "onnxruntime-node-shim.cjs"),
        sharp: path.join(nativeDir, "sharp-stub.cjs"),
      },
      outfile,
    });
    delete require.cache[outfile];
    const mod = require(outfile);
    assert.equal(typeof mod.transformers.pipeline, "function", "@huggingface/transformers must import cleanly with the sharp/onnxruntime-node aliases in place");
    assert.equal(typeof mod.transformers.env, "object");
  } finally {
    await fs.rm(outfile, { force: true });
  }
});

test("sharp-stub.cjs exports a truthy value that only throws if actually invoked", () => {
  const stub = require(path.join(nativeDir, "sharp-stub.cjs"));
  assert.ok(stub, "module.exports must be truthy — @huggingface/transformers checks `import_sharp.default` truthiness at module scope");
  assert.throws(() => stub(), /sharp is not available/);
});

test("onnxruntime-node-shim.cjs resolves the real package via the dev-mode fallback", () => {
  const shim = require(path.join(nativeDir, "onnxruntime-node-shim.cjs"));
  assert.equal(typeof shim.InferenceSession, "function");
  assert.equal(typeof shim.listSupportedBackends, "function");
});
