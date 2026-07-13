// Unit coverage for #78's fit-estimator.ts + estimation-policy.ts + fit-reasons.ts. Pure logic
// only — no node-llama-cpp, no native model load, no filesystem/clock access (see
// electron/main/services/local-llm/planning/fit-estimator.ts's header comment). Bundled via
// esbuild the same way every other local-llm-*.test.mjs in this repo is (see
// local-llm-model-repository.test.mjs for the original convention this follows).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { computeMemoryBreakdown, estimateFit, hasGpuOffloadSupport, totalOffloadableLayers, KV_CACHE_BYTES_PER_ELEMENT, RUNTIME_OVERHEAD_BYTES, ACTIVATION_BYTES_PER_ELEMENT, ACTIVATION_TENSOR_MULTIPLIER, OUTPUT_LAYER_COUNT } from "./electron/main/services/local-llm/planning/fit-estimator.ts";`,
        `export { classifyHeadroom, worseVerdict, meetsOrBetter, verdictRank, FIT_MARGIN_THRESHOLDS } from "./electron/main/services/local-llm/planning/estimation-policy.ts";`,
        `export { sortFitReasons, describeFitReason, FIT_REASON_DESCRIPTIONS } from "./electron/main/services/local-llm/planning/fit-reasons.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-fit-estimator-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-fit-estimator-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return import(file);
}

const modules = await loadModules();
const { computeMemoryBreakdown, estimateFit, hasGpuOffloadSupport, totalOffloadableLayers, RUNTIME_OVERHEAD_BYTES } = modules;
const { classifyHeadroom, worseVerdict, meetsOrBetter, verdictRank, FIT_MARGIN_THRESHOLDS } = modules;
const { sortFitReasons, describeFitReason, FIT_REASON_DESCRIPTIONS } = modules;

// A realistic small local model: ~4GiB weights, 32 transformer layers, GQA (8 KV heads out of 32
// query heads), 8192-token trained context.
function baseModel(overrides = {}) {
  return {
    modelId: "test-model",
    displayName: "Test Model",
    sizeBytes: 4 * 1024 ** 3,
    trainContextSize: 8192,
    blockCount: 32,
    embeddingLength: 4096,
    attentionHeadCount: 32,
    attentionHeadCountKv: 8,
    ...overrides,
  };
}

function baseHardware(overrides = {}) {
  return {
    cpu: { cores: 8 },
    ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
    gpu: { backend: null, memory: { status: "unknown" } },
    detectedAtMs: 1_700_000_000_000,
    source: "detected",
    ...overrides,
  };
}

function cpuCandidate(overrides = {}) {
  return { backend: "cpu", contextSize: 2048, gpuLayers: 0, batchSize: 512, ...overrides };
}

// =============================================================================================
// estimation-policy.ts: margin boundaries
// =============================================================================================

test("estimation-policy: classifyHeadroom boundaries are inclusive lower bounds at 0.25/0.10/0.0", () => {
  assert.equal(classifyHeadroom(FIT_MARGIN_THRESHOLDS.recommended), "recommended");
  assert.equal(classifyHeadroom(FIT_MARGIN_THRESHOLDS.recommended - 0.0001), "possible");
  assert.equal(classifyHeadroom(FIT_MARGIN_THRESHOLDS.possible), "possible");
  assert.equal(classifyHeadroom(FIT_MARGIN_THRESHOLDS.possible - 0.0001), "risky");
  assert.equal(classifyHeadroom(0), "risky");
  assert.equal(classifyHeadroom(-0.0001), "unsupported");
  assert.equal(classifyHeadroom(-1), "unsupported");
  assert.equal(classifyHeadroom(1), "recommended");
});

test("estimation-policy: worseVerdict/meetsOrBetter/verdictRank agree on ranking order", () => {
  assert.equal(worseVerdict("recommended", "risky"), "risky");
  assert.equal(worseVerdict("unsupported", "recommended"), "unsupported");
  assert.equal(worseVerdict("possible", "possible"), "possible");
  assert.ok(verdictRank("recommended") > verdictRank("possible"));
  assert.ok(verdictRank("possible") > verdictRank("risky"));
  assert.ok(verdictRank("risky") > verdictRank("unsupported"));
  assert.equal(meetsOrBetter("possible", "possible"), true);
  assert.equal(meetsOrBetter("risky", "possible"), false);
  assert.equal(meetsOrBetter("recommended", "risky"), true);
});

// =============================================================================================
// fit-reasons.ts
// =============================================================================================

test("fit-reasons: every FitReasonCode used by fit-estimator.ts has a non-empty description", () => {
  for (const code of Object.keys(FIT_REASON_DESCRIPTIONS)) {
    assert.equal(typeof describeFitReason(code), "string");
    assert.ok(describeFitReason(code).length > 0, `expected a non-empty description for ${code}`);
  }
});

test("fit-reasons: sortFitReasons dedupes and applies a stable canonical order", () => {
  const sorted = sortFitReasons(["FITS_COMFORTABLY", "RAM_INSUFFICIENT", "RAM_INSUFFICIENT", "GPU_MEMORY_UNKNOWN"]);
  assert.deepEqual(sorted, ["RAM_INSUFFICIENT", "GPU_MEMORY_UNKNOWN", "FITS_COMFORTABLY"]);
});

// =============================================================================================
// fit-estimator.ts: computeMemoryBreakdown — model/KV cache/compute/overhead separation
// =============================================================================================

test("computeMemoryBreakdown: separates model/KV cache/compute/overhead into distinct, positive components that sum to totalBytes", () => {
  const model = baseModel();
  const breakdown = computeMemoryBreakdown(model, cpuCandidate({ contextSize: 4096, batchSize: 256 }));
  assert.equal(breakdown.modelBytes, model.sizeBytes);
  assert.ok(breakdown.kvCacheBytes > 0);
  assert.ok(breakdown.computeBufferBytes > 0);
  assert.equal(breakdown.overheadBytes, RUNTIME_OVERHEAD_BYTES);
  assert.equal(breakdown.totalBytes, breakdown.modelBytes + breakdown.kvCacheBytes + breakdown.computeBufferBytes + breakdown.overheadBytes);
});

test("computeMemoryBreakdown: KV cache scales linearly with context size (2 * blockCount * headCountKv * headDim * contextSize * 2 bytes)", () => {
  const model = baseModel();
  const at1024 = computeMemoryBreakdown(model, cpuCandidate({ contextSize: 1024 }));
  const at2048 = computeMemoryBreakdown(model, cpuCandidate({ contextSize: 2048 }));
  assert.equal(at2048.kvCacheBytes, at1024.kvCacheBytes * 2);
  const headDim = model.embeddingLength / model.attentionHeadCount;
  const expectedAt1024 = 2 * model.blockCount * model.attentionHeadCountKv * headDim * 1024 * 2;
  assert.equal(at1024.kvCacheBytes, expectedAt1024);
});

test("computeMemoryBreakdown: attentionHeadCountKv defaults to attentionHeadCount (classic MHA, no GQA) when omitted", () => {
  const withoutKv = baseModel({ attentionHeadCountKv: undefined });
  const withMatchingKv = baseModel({ attentionHeadCountKv: withoutKv.attentionHeadCount });
  const candidate = cpuCandidate({ contextSize: 2048 });
  assert.equal(computeMemoryBreakdown(withoutKv, candidate).kvCacheBytes, computeMemoryBreakdown(withMatchingKv, candidate).kvCacheBytes);
});

// =============================================================================================
// estimateFit: RAM insufficient -> unsupported
// =============================================================================================

test("estimateFit: RAM far below required memory -> unsupported, with RAM_INSUFFICIENT reason and a positive (never coerced) requiredBytes", () => {
  const model = baseModel();
  const hardware = baseHardware({ ram: { totalBytes: 1024 ** 3, freeBytes: 200 * 1024 ** 2, availableBytes: 200 * 1024 ** 2 } });
  const estimate = estimateFit({ model, candidate: cpuCandidate(), hardware });
  assert.equal(estimate.verdict, "unsupported");
  assert.ok(estimate.reasons.includes("RAM_INSUFFICIENT"));
  assert.ok(estimate.ram.requiredBytes > 0);
  assert.ok(estimate.ram.headroomRatio < 0);
  assert.equal(estimate.vram, null); // gpuLayers is 0 — no VRAM dimension at all
});

test("estimateFit: ample RAM and no GPU use -> recommended, with NO_GPU_BACKEND_DETECTED noted when hardware has no GPU at all", () => {
  const model = baseModel();
  const hardware = baseHardware(); // gpu.backend === null
  const estimate = estimateFit({ model, candidate: cpuCandidate(), hardware });
  assert.equal(estimate.verdict, "recommended");
  assert.ok(estimate.reasons.includes("NO_GPU_BACKEND_DETECTED"));
  assert.ok(estimate.reasons.includes("FITS_COMFORTABLY"));
});

// =============================================================================================
// estimateFit: GPU memory known vs. unknown — the issue's central acceptance criterion
// =============================================================================================

test("estimateFit: GPU memory KNOWN and plentiful -> recommended/possible on the VRAM dimension, never treated as unknown", () => {
  const model = baseModel();
  const hardware = baseHardware({ gpu: { backend: { name: "cuda", supportsGpuOffload: true }, memory: { status: "known", totalBytes: 24 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 } } });
  const estimate = estimateFit({ model, candidate: { backend: "cuda", contextSize: 2048, gpuLayers: totalOffloadableLayers(model), batchSize: 512 }, hardware });
  assert.notEqual(estimate.vram, null);
  assert.equal(estimate.vram.available.status, "known");
  assert.equal(estimate.vram.headroomRatio !== null, true);
  assert.ok(["recommended", "possible"].includes(estimate.verdict));
});

test("estimateFit: GPU memory UNKNOWN never produces a numeric 0 — it's represented as status:'unknown', verdict capped at risky, never worse", () => {
  const model = baseModel();
  // RAM is generous, and — critically — this hardware has PLENTY of everything except we simply
  // don't know the VRAM reading. If unknown were coerced to 0 bytes available, this would report
  // "unsupported" (nothing fits in 0 bytes). It must not.
  const hardware = baseHardware({
    ram: { totalBytes: 64 * 1024 ** 3, freeBytes: 48 * 1024 ** 3, availableBytes: 48 * 1024 ** 3 },
    gpu: { backend: { name: "metal", supportsGpuOffload: true }, memory: { status: "unknown" } },
  });
  const estimate = estimateFit({ model, candidate: { backend: "metal", contextSize: 2048, gpuLayers: totalOffloadableLayers(model), batchSize: 512 }, hardware });
  assert.notEqual(estimate.vram, null);
  assert.equal(estimate.vram.available.status, "unknown");
  assert.equal(estimate.vram.headroomRatio, null);
  assert.ok(estimate.vram.requiredBytes > 0, "requiredBytes must still be computed from real formula inputs, never skipped/zeroed just because availability is unknown");
  assert.ok(estimate.reasons.includes("GPU_MEMORY_UNKNOWN"));
  assert.notEqual(estimate.verdict, "recommended", "unknown VRAM must never read as confidently as a known comfortable fit");
  assert.notEqual(estimate.verdict, "unsupported", "unknown VRAM must never be misjudged as 'definitely does not fit' either — that's the 0-byte-coercion bug this test guards against");
  assert.equal(estimate.verdict, "risky");
});

test("estimateFit: GPU memory unknown but RAM itself is insufficient -> still unsupported (an independent RAM shortfall is not masked by GPU uncertainty)", () => {
  const model = baseModel();
  const hardware = baseHardware({
    ram: { totalBytes: 1024 ** 3, freeBytes: 200 * 1024 ** 2, availableBytes: 200 * 1024 ** 2 },
    gpu: { backend: { name: "metal", supportsGpuOffload: true }, memory: { status: "unknown" } },
  });
  const estimate = estimateFit({ model, candidate: { backend: "metal", contextSize: 2048, gpuLayers: 4, batchSize: 512 }, hardware });
  assert.equal(estimate.verdict, "unsupported");
  assert.ok(estimate.reasons.includes("RAM_INSUFFICIENT"));
});

// =============================================================================================
// estimateFit: no GPU backend at all -> CPU fallback / structurally-impossible GPU request
// =============================================================================================

test("estimateFit: backend has no GPU offload support at all (null backend) and candidate requests gpuLayers=0 -> plain CPU estimate, no VRAM dimension", () => {
  const model = baseModel();
  const hardware = baseHardware(); // backend: null
  assert.equal(hasGpuOffloadSupport(hardware), false);
  const estimate = estimateFit({ model, candidate: cpuCandidate(), hardware });
  assert.equal(estimate.vram, null);
});

test("estimateFit: requesting gpuLayers > 0 on hardware with no GPU offload support is structurally impossible -> forced unsupported, GPU_LAYERS_UNSUPPORTED_NO_GPU", () => {
  const model = baseModel();
  const cpuOnlyHardware = baseHardware({ gpu: { backend: { name: "cpu", supportsGpuOffload: false }, memory: { status: "unknown" } } });
  const estimate = estimateFit({ model, candidate: { backend: "cpu", contextSize: 2048, gpuLayers: 8, batchSize: 512 }, hardware: cpuOnlyHardware });
  assert.equal(estimate.verdict, "unsupported");
  assert.ok(estimate.reasons.includes("GPU_LAYERS_UNSUPPORTED_NO_GPU"));
  assert.equal(estimate.vram, null);
});

// =============================================================================================
// estimateFit: increasing context size can only hold steady or lower the verdict, never improve it
// =============================================================================================

test("estimateFit: increasing context size (same everything else) never improves the verdict, and demonstrably lowers it at least once (recommended -> possible)", () => {
  const model = baseModel();
  // Sized precisely so that the small context is "recommended" and the much larger context (same
  // model, same RAM) drops to "possible" purely from KV cache growth — see the PR description /
  // this test's derivation for the arithmetic.
  const hardware = baseHardware({ ram: { totalBytes: 8 * 1024 ** 3, freeBytes: 6_500_000_000, availableBytes: 6_500_000_000 } });

  const small = estimateFit({ model, candidate: cpuCandidate({ contextSize: 512, batchSize: 512 }), hardware });
  const large = estimateFit({ model, candidate: cpuCandidate({ contextSize: 8192, batchSize: 512 }), hardware });

  assert.equal(small.verdict, "recommended");
  assert.equal(large.verdict, "possible");
  assert.ok(verdictRank(large.verdict) <= verdictRank(small.verdict));
  assert.ok(large.ram.requiredBytes > small.ram.requiredBytes);
  assert.ok(large.ram.headroomRatio < small.ram.headroomRatio);

  // Monotonicity across a fuller sweep, not just the two endpoints.
  const contextSizes = [256, 512, 1024, 2048, 4096, 8192];
  const verdicts = contextSizes.map((contextSize) => estimateFit({ model, candidate: cpuCandidate({ contextSize, batchSize: 512 }), hardware }).verdict);
  for (let i = 1; i < verdicts.length; i += 1) {
    assert.ok(verdictRank(verdicts[i]) <= verdictRank(verdicts[i - 1]), `verdict must not improve as context grows: ${contextSizes[i - 1]}=${verdicts[i - 1]} -> ${contextSizes[i]}=${verdicts[i]}`);
  }
});

test("estimateFit: a context size beyond the model's trained context is blocked as unsupported regardless of memory headroom", () => {
  const model = baseModel({ trainContextSize: 4096 });
  const hardware = baseHardware({ ram: { totalBytes: 256 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, availableBytes: 200 * 1024 ** 3 } }); // absurd amount of RAM
  const estimate = estimateFit({ model, candidate: cpuCandidate({ contextSize: 8192 }), hardware });
  assert.equal(estimate.verdict, "unsupported");
  assert.ok(estimate.reasons.includes("CONTEXT_EXCEEDS_TRAIN_CONTEXT"));
});

// =============================================================================================
// Determinism
// =============================================================================================

test("estimateFit: the exact same input produces the exact same output, called repeatedly and in different orders", () => {
  const model = baseModel();
  const hardware = baseHardware({ gpu: { backend: { name: "vulkan", supportsGpuOffload: true }, memory: { status: "known", totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 } } });
  const candidate = { backend: "vulkan", contextSize: 3072, gpuLayers: 20, batchSize: 384 };

  const first = estimateFit({ model, candidate, hardware });
  const second = estimateFit({ model, candidate, hardware });
  const interleavedOther = estimateFit({ model: baseModel({ sizeBytes: 1 }), candidate: cpuCandidate(), hardware: baseHardware() });
  void interleavedOther;
  const third = estimateFit({ model, candidate, hardware });

  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});
