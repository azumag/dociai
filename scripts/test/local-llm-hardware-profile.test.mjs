// Unit coverage for #78's hardware-profile-service.ts. Every `os.*`/filesystem/clock/GPU-probing
// dependency is injected (see HardwareProfileServiceDeps) — this suite never touches the real
// filesystem, the real `os` module, or "node-llama-cpp"; `createNativeLoaderGpuProbe()`'s coverage
// below uses native-loader.ts's own fake-module test pattern (see local-llm-service.test.mjs),
// never the real native module.
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
        `export { HardwareProfileService, createNativeLoaderGpuProbe } from "./electron/main/services/local-llm/planning/hardware-profile-service.ts";`,
        `export { NativeLoader } from "./electron/main/services/local-llm/native-loader.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-hardware-profile-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["node-llama-cpp"], // never actually referenced (every test injects a fake importModule), but keep native-loader.ts's default arrow function unresolved at build time, matching local-llm-service.test.mjs's convention
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-hardware-profile-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return import(file);
}

const modules = await loadModules();
const { HardwareProfileService, createNativeLoaderGpuProbe, NativeLoader } = modules;

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeService(overrides = {}) {
  const probeCalls = { count: 0 };
  const baseProbe = overrides.probeGpu ?? (async () => ({ backend: null, supportsGpuOffload: false, memory: { status: "unknown" } }));
  const wrappedProbe = async (...args) => { probeCalls.count += 1; return baseProbe(...args); };
  const service = new HardwareProfileService({
    cpus: overrides.cpus ?? (() => Array.from({ length: 8 }, () => ({ model: "fake-cpu" }))),
    totalmem: overrides.totalmem ?? (() => 16 * 1024 ** 3),
    freemem: overrides.freemem ?? (() => 4 * 1024 ** 3),
    readProcMeminfo: overrides.readProcMeminfo ?? (() => null),
    now: overrides.now ?? (() => 1_700_000_000_000),
    probeGpu: wrappedProbe,
  });
  return { service, probeCalls };
}

// =============================================================================================
// CPU / RAM detection
// =============================================================================================

test("HardwareProfileService: reports CPU core count and RAM total/free from injected os-equivalents", async () => {
  const { service } = makeService({ cpus: () => Array.from({ length: 12 }, () => ({})), totalmem: () => 64 * 1024 ** 3, freemem: () => 10 * 1024 ** 3 });
  const profile = await service.getProfile();
  assert.equal(profile.cpu.cores, 12);
  assert.equal(profile.ram.totalBytes, 64 * 1024 ** 3);
  assert.equal(profile.ram.freeBytes, 10 * 1024 ** 3);
});

test("HardwareProfileService: cpus().length of 0 is clamped up to 1 core (never reports 0 usable cores)", async () => {
  const { service } = makeService({ cpus: () => [] });
  const profile = await service.getProfile();
  assert.equal(profile.cpu.cores, 1);
});

test("HardwareProfileService: availableBytes falls back to freeBytes when readProcMeminfo returns null (non-Linux, or unreadable)", async () => {
  const { service } = makeService({ freemem: () => 3 * 1024 ** 3, readProcMeminfo: () => null });
  const profile = await service.getProfile();
  assert.equal(profile.ram.availableBytes, 3 * 1024 ** 3);
});

test("HardwareProfileService: availableBytes uses /proc/meminfo's MemAvailable (kB) when present, NOT freeBytes — Linux's MemFree undercounts reclaimable cache", async () => {
  const meminfo = ["MemTotal:       16000000 kB", "MemFree:         1000000 kB", "MemAvailable:    9000000 kB", "Buffers:          200000 kB", ""].join("\n");
  const { service } = makeService({ freemem: () => 1000000 * 1024, readProcMeminfo: () => meminfo });
  const profile = await service.getProfile();
  assert.equal(profile.ram.availableBytes, 9000000 * 1024);
  assert.notEqual(profile.ram.availableBytes, profile.ram.freeBytes);
});

test("HardwareProfileService: availableBytes falls back to freeBytes when /proc/meminfo text has no MemAvailable line (older kernel)", async () => {
  const meminfo = ["MemTotal:       16000000 kB", "MemFree:         1000000 kB", ""].join("\n");
  const { service } = makeService({ freemem: () => 1000000 * 1024, readProcMeminfo: () => meminfo });
  const profile = await service.getProfile();
  assert.equal(profile.ram.availableBytes, 1000000 * 1024);
});

// =============================================================================================
// GPU: known / unknown pass-through — never coerced
// =============================================================================================

test("HardwareProfileService: GPU memory KNOWN is passed through with real numbers, backend name and supportsGpuOffload preserved", async () => {
  const { service } = makeService({ probeGpu: async () => ({ backend: "metal", supportsGpuOffload: true, memory: { status: "known", totalBytes: 12 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 } }) });
  const profile = await service.getProfile();
  assert.deepEqual(profile.gpu.backend, { name: "metal", supportsGpuOffload: true });
  assert.deepEqual(profile.gpu.memory, { status: "known", totalBytes: 12 * 1024 ** 3, freeBytes: 9 * 1024 ** 3 });
});

test("HardwareProfileService: GPU memory UNKNOWN stays status:'unknown' — never coerced to a numeric 0", async () => {
  const { service } = makeService({ probeGpu: async () => ({ backend: "metal", supportsGpuOffload: true, memory: { status: "unknown" } }) });
  const profile = await service.getProfile();
  assert.deepEqual(profile.gpu.memory, { status: "unknown" });
  assert.notEqual(profile.gpu.memory.totalBytes, 0);
});

test("HardwareProfileService: no GPU backend detected at all -> gpu.backend is null", async () => {
  const { service } = makeService({ probeGpu: async () => ({ backend: null, supportsGpuOffload: false, memory: { status: "unknown" } }) });
  const profile = await service.getProfile();
  assert.equal(profile.gpu.backend, null);
});

test("HardwareProfileService: a CPU-only native backend ('cpu', llama.gpu === false) is reported as a real backend, not null, with supportsGpuOffload:false", async () => {
  const { service } = makeService({ probeGpu: async () => ({ backend: "cpu", supportsGpuOffload: false, memory: { status: "unknown" } }) });
  const profile = await service.getProfile();
  assert.deepEqual(profile.gpu.backend, { name: "cpu", supportsGpuOffload: false });
});

// =============================================================================================
// Cache / manual re-detect / suspend-resume / backend-error hooks
// =============================================================================================

test("HardwareProfileService: caches the profile — a second getProfile() call does not re-probe GPU hardware", async () => {
  const { service, probeCalls } = makeService();
  const first = await service.getProfile();
  const second = await service.getProfile();
  assert.equal(probeCalls.count, 1);
  assert.equal(first.source, "detected");
  assert.equal(second.source, "cached");
  assert.equal(first.detectedAtMs, second.detectedAtMs);
});

test("HardwareProfileService: concurrent getProfile() calls before the first resolves share a single in-flight probe (single-flight)", async () => {
  const gate = deferred();
  let calls = 0;
  const { service } = makeService({
    probeGpu: async () => {
      calls += 1;
      await gate.promise;
      return { backend: "cuda", supportsGpuOffload: true, memory: { status: "known", totalBytes: 1, freeBytes: 1 } };
    },
  });
  const p1 = service.getProfile();
  const p2 = service.getProfile();
  const p3 = service.getProfile();
  gate.resolve();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);
});

test("HardwareProfileService: redetect() discards the cache and re-probes, returning source:'detected'", async () => {
  const { service, probeCalls } = makeService();
  await service.getProfile();
  await service.getProfile();
  assert.equal(probeCalls.count, 1);

  const redetected = await service.redetect("manual");
  assert.equal(probeCalls.count, 2);
  assert.equal(redetected.source, "detected");

  const afterRedetectCached = await service.getProfile();
  assert.equal(probeCalls.count, 2);
  assert.equal(afterRedetectCached.source, "cached");
});

test("HardwareProfileService: onSuspendResume() forces a fresh probe (suspend/resume hook)", async () => {
  const { service, probeCalls } = makeService();
  await service.getProfile();
  assert.equal(probeCalls.count, 1);
  await service.onSuspendResume();
  assert.equal(probeCalls.count, 2);
});

test("HardwareProfileService: onBackendError() forces a fresh probe (backend-error hook)", async () => {
  const { service, probeCalls } = makeService();
  await service.getProfile();
  assert.equal(probeCalls.count, 1);
  await service.onBackendError();
  assert.equal(probeCalls.count, 2);
});

test("HardwareProfileService: redetect() actually picks up a changed GPU reading (e.g. after a driver update / eGPU plug-in)", async () => {
  let known = false;
  const { service } = makeService({
    probeGpu: async () => (known
      ? { backend: "cuda", supportsGpuOffload: true, memory: { status: "known", totalBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 } }
      : { backend: null, supportsGpuOffload: false, memory: { status: "unknown" } }),
  });
  const before = await service.getProfile();
  assert.equal(before.gpu.backend, null);
  known = true;
  const after = await service.redetect("backend-error");
  assert.deepEqual(after.gpu.backend, { name: "cuda", supportsGpuOffload: true });
});

// =============================================================================================
// createNativeLoaderGpuProbe: reuses native-loader.ts's ALREADY-memoized probing, never a second
// `import("node-llama-cpp")`.
// =============================================================================================

function makeFakeLlamaModule({ gpu = "metal", vramState, throwOnVram = false } = {}) {
  let importCount = 0;
  const llama = {
    gpu,
    async getVramState() {
      if (throwOnVram) throw new Error("boom");
      if (vramState === undefined) return undefined; // simulates a backend that doesn't implement VRAM introspection
      return vramState;
    },
  };
  const module = {
    async getLlama() { return llama; },
    LlamaChatSession: class {},
    async getModuleVersion() { return "0.0.0-fake"; },
  };
  return {
    importModule: async () => { importCount += 1; return module; },
    getImportCount: () => importCount,
  };
}

test("createNativeLoaderGpuProbe: native module unavailable -> backend null, supportsGpuOffload false, memory unknown", async () => {
  const nativeLoader = new NativeLoader({ importModule: async () => { throw new Error("no native module"); } });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  const result = await probe();
  assert.deepEqual(result, { backend: null, supportsGpuOffload: false, memory: { status: "unknown" } });
});

test("createNativeLoaderGpuProbe: llama.gpu === false ('cpu' backend) -> supportsGpuOffload false, memory unknown (never even queries VRAM)", async () => {
  const fake = makeFakeLlamaModule({ gpu: false });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  const result = await probe();
  assert.deepEqual(result, { backend: "cpu", supportsGpuOffload: false, memory: { status: "unknown" } });
});

test("createNativeLoaderGpuProbe: a real GPU backend with a working getVramState() reports known memory with real numbers", async () => {
  const fake = makeFakeLlamaModule({ gpu: "metal", vramState: { total: 12 * 1024 ** 3, used: 1 * 1024 ** 3, free: 11 * 1024 ** 3 } });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  const result = await probe();
  assert.deepEqual(result, { backend: "metal", supportsGpuOffload: true, memory: { status: "known", totalBytes: 12 * 1024 ** 3, freeBytes: 11 * 1024 ** 3 } });
});

test("createNativeLoaderGpuProbe: a GPU backend whose getVramState() throws reports memory:unknown, not a crash and not a coerced 0", async () => {
  const fake = makeFakeLlamaModule({ gpu: "vulkan", throwOnVram: true });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  const result = await probe();
  assert.deepEqual(result, { backend: "vulkan", supportsGpuOffload: true, memory: { status: "unknown" } });
});

test("createNativeLoaderGpuProbe: a GPU backend whose getVramState() resolves to undefined reports memory:unknown", async () => {
  const fake = makeFakeLlamaModule({ gpu: "vulkan", vramState: undefined });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  const result = await probe();
  assert.deepEqual(result, { backend: "vulkan", supportsGpuOffload: true, memory: { status: "unknown" } });
});

test("createNativeLoaderGpuProbe: reuses NativeLoader's own single-flight load() — calling the probe twice never triggers a second import(\"node-llama-cpp\")", async () => {
  const fake = makeFakeLlamaModule({ gpu: "metal", vramState: { total: 1, used: 0, free: 1 } });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const probe = createNativeLoaderGpuProbe(nativeLoader);
  await probe();
  await probe();
  assert.equal(fake.getImportCount(), 1);
});

test("HardwareProfileService end-to-end with createNativeLoaderGpuProbe: a full service wired to a fake NativeLoader produces a coherent profile", async () => {
  const fake = makeFakeLlamaModule({ gpu: "metal", vramState: { total: 16 * 1024 ** 3, used: 2 * 1024 ** 3, free: 14 * 1024 ** 3 } });
  const nativeLoader = new NativeLoader({ importModule: fake.importModule });
  const service = new HardwareProfileService({
    cpus: () => Array.from({ length: 10 }, () => ({})),
    totalmem: () => 32 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    readProcMeminfo: () => null,
    probeGpu: createNativeLoaderGpuProbe(nativeLoader),
  });
  const profile = await service.getProfile();
  assert.equal(profile.cpu.cores, 10);
  assert.deepEqual(profile.gpu.backend, { name: "metal", supportsGpuOffload: true });
  assert.deepEqual(profile.gpu.memory, { status: "known", totalBytes: 16 * 1024 ** 3, freeBytes: 14 * 1024 ** 3 });
});
