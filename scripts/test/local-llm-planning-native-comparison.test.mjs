// Investigation + comparison test for #78's explicit research TODO: "node-llama-cpp内蔵の
// GGUF解析・メモリ推定（readGgufFileInfo/GgufInsights/getVramState相当）の活用可否を調査し、
// 自前estimatorと突合するテストを用意する".
//
// Findings (see fit-estimator.ts's header comment for the full writeup):
//  - `readGgufFileInfo()` (node-llama-cpp@3.19.0) is a REAL, usable, pure-JS GGUF parser — it never
//    touches the native addon (verified by reading node_modules/node-llama-cpp/dist/gguf/
//    readGgufFileInfo.js: it only ever constructs a `GgufFsFileReader`/`GgufNetworkFetchFileReader`
//    and calls `parseGguf()`, no `getLlama()`/native import anywhere in that path).
//  - `GgufInsights.from(ggufFileInfo, llama?)`, however, is NOT native-load-free: passing no
//    `llama` makes it call `getLlamaWithoutBackend()` internally, which still loads node-llama-cpp's
//    native addon (a "slim, no backend" instance, but still a real native load) — verified by
//    reading node_modules/node-llama-cpp/dist/bindings/utils/getLlamaWithoutBackend.js. This is
//    exactly the "native model load" this whole planning layer's unit tests must avoid (issue
//    acceptance criterion: "estimator/plannerがnative model loadなしでunit testできる"), which is
//    why fit-estimator.ts implements its own formula rather than delegating to `GgufInsights`.
//  - This file is the "comparison test against node-llama-cpp's built-in facility" the issue asks
//    for. It's deliberately NOT part of the fast/pure suite (it genuinely loads the native addon,
//    same tradeoff local-llm-service-integration.test.mjs already makes for the same fixture) but
//    IS included in `test:unit`'s file list, matching that file's precedent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { GgufInsights, readGgufFileInfo } from "node-llama-cpp";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const fixturePath = path.join(repoRoot, "scripts/test/fixtures/local-llm/stories260K.gguf");

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { computeMemoryBreakdown, estimateFit, totalOffloadableLayers } from "./electron/main/services/local-llm/planning/fit-estimator.ts";`,
        `export { readGgufHeader } from "./electron/main/services/local-llm/models/gguf-metadata-reader.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-planning-native-comparison-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  // Own-module bundle never imports "node-llama-cpp" at all, so (unlike
  // local-llm-service-integration.test.mjs) a plain system tmpdir is fine here — nothing in this
  // bundle needs to resolve back to the repo's node_modules.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-planning-native-comparison-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return import(file);
}

const modules = await loadModules();
const { computeMemoryBreakdown, estimateFit, totalOffloadableLayers } = modules;

function baseHardware() {
  return {
    cpu: { cores: 8 },
    ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
    gpu: { backend: null, memory: { status: "unknown" } },
    detectedAtMs: 1_700_000_000_000,
    source: "detected",
  };
}

test("investigation: node-llama-cpp's readGgufFileInfo() runs successfully on the real fixture without any native model load", async () => {
  const info = await readGgufFileInfo(fixturePath);
  assert.equal(info.architectureMetadata.context_length, 128);
  assert.equal(info.architectureMetadata.embedding_length, 64);
  assert.equal(info.architectureMetadata.block_count, 5);
  assert.equal(info.architectureMetadata.attention.head_count, 8);
  assert.equal(info.architectureMetadata.attention.head_count_kv, 4);
});

test("investigation: node-llama-cpp's own GgufInsights facility IS usable and produces real, positive resource estimates for the fixture", async () => {
  const info = await readGgufFileInfo(fixturePath);
  const insights = await GgufInsights.from(info); // no llama passed -> falls back to getLlamaWithoutBackend() internally (a real, if slim, native load)
  assert.ok(insights.modelSize > 0);
  assert.ok(insights.totalLayers > 0);
  assert.ok(insights.trainContextSize > 0);

  const modelReqCpuOnly = await insights.estimateModelResourceRequirementsV2({ gpuLayers: 0 });
  assert.equal(modelReqCpuOnly.gpuVram, 0);
  assert.ok(modelReqCpuOnly.cpuRam > 0);

  const modelReqFullOffload = await insights.estimateModelResourceRequirementsV2({ gpuLayers: insights.totalLayers });
  assert.ok(modelReqFullOffload.gpuVram > 0);

  const ctxReq = await insights.estimateContextResourceRequirementsV2({ contextSize: insights.trainContextSize, modelGpuLayers: 0, batchSize: insights.trainContextSize });
  assert.ok(ctxReq.cpuRam > 0);
});

test("comparison: our own gguf-metadata-reader.ts extracts the EXACT same architecture fields as node-llama-cpp's real GGUF parser for this fixture", async () => {
  const [ourHeader, theirInfo] = await Promise.all([modules.readGgufHeader(fixturePath), readGgufFileInfo(fixturePath)]);
  assert.equal(ourHeader.valid, true);
  assert.equal(ourHeader.architecture, theirInfo.metadata.general.architecture);
  assert.equal(ourHeader.contextLength, theirInfo.architectureMetadata.context_length);
  assert.equal(ourHeader.embeddingLength, theirInfo.architectureMetadata.embedding_length);
  assert.equal(ourHeader.blockCount, theirInfo.architectureMetadata.block_count);
  assert.equal(ourHeader.attentionHeadCount, theirInfo.architectureMetadata.attention.head_count);
  assert.equal(ourHeader.attentionHeadCountKv, theirInfo.architectureMetadata.attention.head_count_kv);
  assert.equal(ourHeader.feedForwardLength, theirInfo.architectureMetadata.feed_forward_length);
});

test("comparison: our totalOffloadableLayers() (block_count + 1) matches GgufInsights.totalLayers exactly", async () => {
  const [ourHeader, theirInfo] = await Promise.all([modules.readGgufHeader(fixturePath), readGgufFileInfo(fixturePath)]);
  const insights = await GgufInsights.from(theirInfo);
  const model = { modelId: "stories260k", displayName: "stories260K", sizeBytes: 0, trainContextSize: ourHeader.contextLength, blockCount: ourHeader.blockCount, embeddingLength: ourHeader.embeddingLength, attentionHeadCount: ourHeader.attentionHeadCount, attentionHeadCountKv: ourHeader.attentionHeadCountKv };
  assert.equal(totalOffloadableLayers(model), insights.totalLayers);
});

test("comparison: our modelBytes proxy (GGUF file size on disk) is within 5% of GgufInsights.modelSize (tensor-payload-only size)", async () => {
  const stat = await fs.stat(fixturePath);
  const theirInfo = await readGgufFileInfo(fixturePath);
  const insights = await GgufInsights.from(theirInfo);
  const relativeDifference = Math.abs(stat.size - insights.modelSize) / insights.modelSize;
  assert.ok(relativeDifference < 0.05, `expected file-size-on-disk (${stat.size}) to be within 5% of GgufInsights.modelSize (${insights.modelSize}), got ${(relativeDifference * 100).toFixed(2)}%`);
  assert.ok(stat.size >= insights.modelSize, "file size on disk must be >= tensor-only size (it also includes the GGUF header/KV-metadata section)");
});

test("comparison: our full memory breakdown and node-llama-cpp's real combined estimate land in the same order of magnitude for this fixture (loose bound — see fit-estimator.ts's header comment on why an exact match isn't expected)", async () => {
  const [ourHeader, theirInfo, stat] = await Promise.all([modules.readGgufHeader(fixturePath), readGgufFileInfo(fixturePath), fs.stat(fixturePath)]);
  const insights = await GgufInsights.from(theirInfo);

  const model = {
    modelId: "stories260k",
    displayName: "stories260K",
    sizeBytes: stat.size,
    trainContextSize: ourHeader.contextLength,
    blockCount: ourHeader.blockCount,
    embeddingLength: ourHeader.embeddingLength,
    attentionHeadCount: ourHeader.attentionHeadCount,
    attentionHeadCountKv: ourHeader.attentionHeadCountKv,
  };
  const candidate = { backend: "cpu", contextSize: ourHeader.contextLength, gpuLayers: 0, batchSize: ourHeader.contextLength };
  const ourBreakdown = computeMemoryBreakdown(model, candidate);

  const theirModelReq = await insights.estimateModelResourceRequirementsV2({ gpuLayers: 0 });
  const theirCtxReq = await insights.estimateContextResourceRequirementsV2({ contextSize: ourHeader.contextLength, modelGpuLayers: 0, batchSize: ourHeader.contextLength });
  const theirTotal = theirModelReq.cpuRam + theirCtxReq.cpuRam;

  // Excludes our flat RUNTIME_OVERHEAD_BYTES (256 MiB) from the comparison: node-llama-cpp's own
  // estimate has no equivalent fixed process-overhead term, and on a genuinely tiny (1.2MB) toy
  // fixture like this one, that single constant would otherwise swamp every other term on both
  // sides of the comparison and make it meaningless.
  const ourVariablePortion = ourBreakdown.modelBytes + ourBreakdown.kvCacheBytes + ourBreakdown.computeBufferBytes;

  assert.ok(ourVariablePortion > 0);
  assert.ok(theirTotal > 0);
  const ratio = ourVariablePortion / theirTotal;
  assert.ok(ratio > 0.1 && ratio < 50, `expected our estimate (${ourVariablePortion} bytes) and node-llama-cpp's real estimate (${theirTotal} bytes) to be within the same rough order of magnitude, got ratio ${ratio.toFixed(3)}`);

  // Full round-trip through our own pure estimator (with a real hardware profile) must still
  // produce a sane, positive verdict for this trivially-small model.
  const estimate = estimateFit({ model, candidate, hardware: baseHardware() });
  assert.equal(estimate.verdict, "recommended");
});
