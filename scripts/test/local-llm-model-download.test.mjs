import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: [
        `export { sanitizeIdSegment, resolveWithinModelsDir, MODEL_DIR_NAMES } from "./electron/main/services/local-llm/models/model-paths.ts";`,
        `export { InstalledRegistry } from "./electron/main/services/local-llm/models/installed-registry.ts";`,
        `export { readGgufHeader, computeSha256 } from "./electron/main/services/local-llm/models/gguf-metadata-reader.ts";`,
        `export { DownloadJobStore } from "./electron/main/services/local-llm/models/download-job-store.ts";`,
        `export { installVerifiedDownload } from "./electron/main/services/local-llm/models/model-installer.ts";`,
        `export { resolveHuggingFaceUrl, resolveDownloadSourceUrl, classifyIpAddress, isPublicAddress, createGuardedLookup } from "./electron/main/services/local-llm/models/model-source-resolver.ts";`,
        `export { ProgressTracker, createThrottledEmitter } from "./electron/main/services/local-llm/models/download-progress.ts";`,
        `export { getDiskSpace, hasSufficientSpace, DEFAULT_DOWNLOAD_OVERHEAD_BYTES } from "./electron/main/services/local-llm/models/disk-space.ts";`,
        `export { ModelDownloadService, HUGGING_FACE_TOKEN_SECRET_KEY } from "./electron/main/services/local-llm/models/model-download-service.ts";`,
        `export { ModelRepository } from "./electron/main/services/local-llm/models/model-repository.ts";`,
        `export { MemorySecretStore } from "./electron/main/secrets/memory-secret-store.ts";`,
        `export { ServiceError } from "./electron/main/services/service-error.ts";`,
      ].join("\n"),
      resolveDir: repoRoot,
      sourcefile: "local-llm-download-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-local-llm-download-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Same fixture builder as #75's gguf-metadata-reader tests: a real (spec-shaped) GGUF byte
 * buffer, good enough to exercise the real header parser/hasher end-to-end without real model
 * bytes. Padded to `padTo` bytes (with trailing zero bytes) so we have a payload big enough to
 * observe multiple progress ticks / partial-content behavior over a real socket. */
function buildGgufBuffer({ magic = "GGUF", version = 3, tensorCount = 0n, kvEntries = [], padTo = 0 } = {}) {
  const parts = [Buffer.from(magic, "ascii")];
  const versionBuf = Buffer.alloc(4); versionBuf.writeUInt32LE(version, 0); parts.push(versionBuf);
  const tensorCountBuf = Buffer.alloc(8); tensorCountBuf.writeBigUInt64LE(BigInt(tensorCount), 0); parts.push(tensorCountBuf);
  const kvCountBuf = Buffer.alloc(8); kvCountBuf.writeBigUInt64LE(BigInt(kvEntries.length), 0); parts.push(kvCountBuf);
  for (const [key, value] of kvEntries) {
    const keyBuf = Buffer.from(key, "utf8");
    const keyLenBuf = Buffer.alloc(8); keyLenBuf.writeBigUInt64LE(BigInt(keyBuf.length), 0);
    const typeBuf = Buffer.alloc(4); typeBuf.writeUInt32LE(8, 0); // GGUF_TYPE.STRING
    const valueBuf = Buffer.from(value, "utf8");
    const valueLenBuf = Buffer.alloc(8); valueLenBuf.writeBigUInt64LE(BigInt(valueBuf.length), 0);
    parts.push(keyLenBuf, keyBuf, typeBuf, valueLenBuf, valueBuf);
  }
  let buffer = Buffer.concat(parts);
  if (padTo > buffer.length) buffer = Buffer.concat([buffer, Buffer.alloc(padTo - buffer.length, 7)]);
  return buffer;
}

function makeJobRecord(overrides = {}) {
  const now = new Date(0).toISOString();
  return {
    id: "job-x",
    displayName: "Test Model",
    fileName: "test-model.gguf",
    source: { kind: "url", url: "https://example.com/test-model.gguf" },
    expectedSizeBytes: 100,
    license: { id: "mit", name: "MIT License" },
    licenseAcceptedAt: now,
    state: "queued",
    bytesDownloaded: 0,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: (p) => `http://127.0.0.1:${port}${p}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Builds a request handler for /resumable serving `buffer`, with knobs for the specific
 * download-mechanics scenarios under test: a mid-stream drop on the first request (to force our
 * automatic-retry-then-Range-resume path), ignoring Range entirely (server without resume
 * support), and rotating the ETag after the first request (stale resume validator). */
function makeResumableHandler(buffer, { dropAfterBytesOnRequest, ignoreRange = false, rotateEtagAfterRequest, etag = '"fixture-etag"' } = {}) {
  let requestCount = 0;
  return (req, res) => {
    requestCount += 1;
    const currentEtag = rotateEtagAfterRequest !== undefined && requestCount > rotateEtagAfterRequest ? '"rotated-etag"' : etag;
    const range = req.headers.range;
    const ifRange = req.headers["if-range"];
    if (range && !ignoreRange && ifRange === currentEtag) {
      const match = /bytes=(\d+)-/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const chunk = buffer.subarray(start);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${buffer.length - 1}/${buffer.length}`,
        "Content-Length": String(chunk.length),
        ETag: currentEtag,
        "Last-Modified": "Wed, 01 Jan 2026 00:00:00 GMT",
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, { "Content-Length": String(buffer.length), ETag: currentEtag, "Last-Modified": "Wed, 01 Jan 2026 00:00:00 GMT" });
    if (requestCount === dropAfterBytesOnRequest?.request) {
      res.write(buffer.subarray(0, dropAfterBytesOnRequest.bytes));
      req.socket.destroy();
      return;
    }
    res.end(buffer);
  };
}

function createService(modules, modelsDir, opts = {}) {
  const jobStore = new modules.DownloadJobStore({ jobsFile: path.join(modelsDir, "download-jobs.json"), jobsBackupFile: path.join(modelsDir, "download-jobs.json.bak") });
  const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });
  const secretStore = new modules.MemorySecretStore();
  const events = [];
  const fastSleep = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(ms, 15));
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new modules.ServiceError("CANCELLED", "cancelled", { retryable: false })); }, { once: true });
  });
  const service = new modules.ModelDownloadService(modelsDir, jobStore, registry, secretStore, (event) => events.push(event), {
    // TEST-ONLY escape hatch: our mock HTTP server lives on 127.0.0.1 (loopback), which the
    // shipped default policy (isPublicAddress, see model-source-resolver.ts) correctly refuses to
    // connect to. A dedicated test below proves that default-policy rejection really happens
    // against a real server; every other test here explicitly opts back into loopback so it can
    // reach its own mock server — this override is never present in the shipped default.
    isAddressAllowed: () => true,
    // TEST-ONLY: our mock HTTP server is plain HTTP; the shipped default requires https for a
    // `kind: "url"` source (see model-source-resolver.ts's resolveDownloadSourceUrl). Never set in
    // electron/main/index.ts's real construction.
    allowInsecureSources: true,
    diskSpace: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 }),
    overheadBytes: 0,
    progressIntervalMs: 1,
    maxAttempts: 4,
    retryBaseDelayMs: 5,
    retryMaxDelayMs: 15,
    idleTimeoutMs: 1500,
    connectTimeoutMs: 1500,
    sleep: fastSleep,
    ...opts,
  });
  return { service, jobStore, registry, secretStore, events };
}

// -------------------------------------------------------------------------------------------
// Pure, network-free coverage: IP classification, disk space, progress math, URL resolution.
// -------------------------------------------------------------------------------------------

test("model-source-resolver: classifyIpAddress/isPublicAddress recognize loopback/link-local/private/public IP literals (no network)", async () => {
  const { modules } = await loadModules();
  assert.equal(modules.classifyIpAddress("127.0.0.1"), "loopback");
  assert.equal(modules.classifyIpAddress("169.254.169.254"), "link-local"); // cloud metadata endpoint
  assert.equal(modules.classifyIpAddress("10.0.0.1"), "private");
  assert.equal(modules.classifyIpAddress("172.16.0.5"), "private");
  assert.equal(modules.classifyIpAddress("172.32.0.5"), "public");
  assert.equal(modules.classifyIpAddress("192.168.1.1"), "private");
  assert.equal(modules.classifyIpAddress("100.64.0.1"), "private");
  assert.equal(modules.classifyIpAddress("0.0.0.0"), "unspecified");
  assert.equal(modules.classifyIpAddress("8.8.8.8"), "public");
  assert.equal(modules.classifyIpAddress("1.1.1.1"), "public");
  assert.equal(modules.classifyIpAddress("::1"), "loopback");
  assert.equal(modules.classifyIpAddress("fe80::1"), "link-local");
  assert.equal(modules.classifyIpAddress("fc00::1"), "unique-local");
  assert.equal(modules.classifyIpAddress("2606:4700:4700::1111"), "public");

  assert.equal(modules.isPublicAddress("8.8.8.8", 4), true);
  assert.equal(modules.isPublicAddress("127.0.0.1", 4), false);
  assert.equal(modules.isPublicAddress("169.254.169.254", 4), false);
  assert.equal(modules.isPublicAddress("10.0.0.1", 4), false);
});

test("model-source-resolver: createGuardedLookup's DNS-hook path rejects a hostname that resolves to a private address (no real network — a fake dnsLookup)", async () => {
  const { modules } = await loadModules();
  const fakeDnsLookup = (hostname, options, callback) => callback(null, "10.1.2.3", 4);
  const lookup = modules.createGuardedLookup(modules.isPublicAddress, fakeDnsLookup);
  const outcome = await new Promise((resolve) => {
    lookup("internal.example.corp", { family: 0 }, (err, address) => resolve({ err, address }));
  });
  assert.match(String(outcome.err?.message), /disallowed address/);
  assert.equal(outcome.err?.code, "EADDRBLOCKED");

  const allowingLookup = modules.createGuardedLookup(() => true, fakeDnsLookup);
  const allowed = await new Promise((resolve) => allowingLookup("internal.example.corp", { family: 0 }, (err, address) => resolve({ err, address })));
  assert.equal(allowed.err, null);
  assert.equal(allowed.address, "10.1.2.3");
});

test("ModelDownloadService: with the DEFAULT (shipped) address policy, a job whose source is a literal 127.0.0.1 URL is refused before ever connecting to a real local server", async () => {
  let requestCount = 0;
  const { server, url } = await startServer((req, res) => { requestCount += 1; res.end("should never be reached"); });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const jobStore = new modules.DownloadJobStore({ jobsFile: path.join(modelsDir, "download-jobs.json"), jobsBackupFile: path.join(modelsDir, "download-jobs.json.bak") });
      const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });
      const secretStore = new modules.MemorySecretStore();
      // Deliberately NO isAddressAllowed override here: this is the real shipped default
      // (isPublicAddress), pointed at a real local mock server on loopback, to confirm the
      // rejection actually happens because of address classification — not a stand-in.
      const service = new modules.ModelDownloadService(modelsDir, jobStore, registry, secretStore, () => {}, {
        allowInsecureSources: true, // only to get past the https-only check; address policy is untouched
        diskSpace: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 }),
        overheadBytes: 0,
        maxAttempts: 1,
      });

      const job = await service.start({ source: { kind: "url", url: url("/blocked") }, displayName: "Blocked", fileName: "blocked.gguf", expectedSizeBytes: 100, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "failed");
      assert.match(settled.error?.message ?? "", /disallowed address/);
      assert.equal(requestCount, 0, "the mock server must never have received a request — refused before connecting");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("model-source-resolver: resolveHuggingFaceUrl matches the URL shape already used by resources/catalog/local-models.json, and rejects unsafe input", async () => {
  const { modules } = await loadModules();
  const url = modules.resolveHuggingFaceUrl({ repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", revision: "main", filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf" });
  assert.equal(url.toString(), "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf");

  const catalogRaw = JSON.parse(await fs.readFile(path.join(repoRoot, "resources/catalog/local-models.json"), "utf8"));
  assert.ok(catalogRaw.models.length > 0);
  for (const model of catalogRaw.models) assert.match(model.source.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[^/]+\/[^/]+$/);

  assert.throws(() => modules.resolveHuggingFaceUrl({ repo: "not-a-repo", revision: "main", filename: "x.gguf" }), /repo/);
  assert.throws(() => modules.resolveHuggingFaceUrl({ repo: "org/name", revision: "../etc", filename: "x.gguf" }), /revision/);
  assert.throws(() => modules.resolveHuggingFaceUrl({ repo: "org/name", revision: "main", filename: "../../etc/passwd" }), /filename/);
  assert.throws(() => modules.resolveHuggingFaceUrl({ repo: "org/name", revision: "main", filename: "model.bin" }), /filename/);

  assert.throws(() => modules.resolveDownloadSourceUrl({ kind: "url", url: "http://example.com/model.gguf" }), /https/);
  assert.throws(() => modules.resolveDownloadSourceUrl({ kind: "url", url: "https://user:pass@example.com/model.gguf" }), /credentials/);
  assert.equal(modules.resolveDownloadSourceUrl({ kind: "url", url: "https://example.com/model.gguf" }).toString(), "https://example.com/model.gguf");
});

test("disk-space: real fs.statfs against a real temp directory, plus hasSufficientSpace with real and injected fake values", async () => {
  const { modules } = await loadModules();
  const directory = await tempDir("dociai-diskspace-");
  try {
    const info = await modules.getDiskSpace(directory);
    assert.ok(Number.isFinite(info.freeBytes) && info.freeBytes > 0, "a real temp directory must report positive real free space");
    assert.ok(info.totalBytes >= info.freeBytes);
    assert.equal(modules.hasSufficientSpace(info.freeBytes, 1, modules.DEFAULT_DOWNLOAD_OVERHEAD_BYTES), true);

    assert.equal(modules.hasSufficientSpace(1000, 2000, 0), false);
    assert.equal(modules.hasSufficientSpace(3000, 2000, 500), true);
    assert.equal(modules.hasSufficientSpace(2500, 2000, 500), true);
    assert.equal(modules.hasSufficientSpace(2499, 2000, 500), false);
    assert.equal(modules.hasSufficientSpace(-1, 100, 0), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("download-progress: ProgressTracker derives rate/eta/percent from a rolling window, createThrottledEmitter throttles with a force override", async () => {
  const { modules } = await loadModules();
  let now = 0;
  const tracker = new modules.ProgressTracker(5000, () => now);
  const first = tracker.snapshot(0, 1000);
  assert.equal(first.percent, 0);
  now = 1000;
  const second = tracker.snapshot(500, 1000);
  assert.ok(second.bytesPerSecond > 0);
  assert.ok(second.etaSeconds > 0);
  assert.equal(second.percent, 50);

  const events = [];
  let clock = 0;
  const emit = modules.createThrottledEmitter(100, (value) => events.push(value), () => clock);
  emit("a");
  emit("b");
  clock = 50;
  emit("c");
  clock = 150;
  emit("d");
  emit("e", true);
  assert.deepEqual(events, ["a", "d", "e"]);
});

// -------------------------------------------------------------------------------------------
// download-job-store: atomic persistence, same pattern as #75's InstalledRegistry test.
// -------------------------------------------------------------------------------------------

test("DownloadJobStore: atomic upsert/list/remove, and recovers from a corrupted primary via backup", async () => {
  const { modules, directory } = await loadModules();
  try {
    const jobsFile = path.join(directory, "download-jobs.json");
    const jobsBackupFile = path.join(directory, "download-jobs.json.bak");
    const store = new modules.DownloadJobStore({ jobsFile, jobsBackupFile });

    const empty = await store.list();
    assert.deepEqual(empty.jobs, []);
    assert.equal(empty.repairNeeded, false);

    await store.upsert(makeJobRecord({ id: "job-1" }));
    assert.equal(await fs.access(jobsBackupFile).then(() => true, () => false), false, "no backup before a second save");

    await store.upsert(makeJobRecord({ id: "job-2" }));
    const afterTwo = await store.list();
    assert.deepEqual(afterTwo.jobs.map((j) => j.id).sort(), ["job-1", "job-2"]);

    await fs.writeFile(jobsFile, "{ not valid json");
    const recovered = await store.load();
    assert.equal(recovered.recovered, true);
    assert.deepEqual(recovered.file.jobs.map((j) => j.id), ["job-1"]);

    await fs.writeFile(jobsFile, "{ still not valid");
    await fs.writeFile(jobsBackupFile, "also not json");
    const bothCorrupt = await store.load();
    assert.equal(bothCorrupt.repairNeeded, true);
    assert.deepEqual(bothCorrupt.file.jobs, []);

    await store.upsert(makeJobRecord({ id: "job-1" }));
    await store.remove("job-1");
    assert.deepEqual((await store.list()).jobs, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------
// model-installer: verify-then-install, quarantine on invalid/mismatched data, dedupe by hash.
// -------------------------------------------------------------------------------------------

test("model-installer: installVerifiedDownload installs a verified file, detects duplicates, and quarantines hash-mismatch/invalid-GGUF files without installing them", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    const stagingDir = path.join(modelsDir, ".staging");
    await fs.mkdir(stagingDir, { recursive: true });
    const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });

    const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]] });
    const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");

    const partial1 = path.join(stagingDir, "job1.partial");
    await fs.writeFile(partial1, buffer);
    const installed = await modules.installVerifiedDownload({ modelsDir, registry, partialPath: partial1, job: { fileName: "model.gguf", displayName: "Model", expectedSha256: expectedHash }, sourceUrl: "https://example.com/model.gguf" });
    assert.equal(installed.status, "installed");
    assert.equal(installed.model.sha256, expectedHash);
    assert.equal(installed.model.source.kind, "download");
    assert.equal(await fs.access(partial1).then(() => true, () => false), false, "partial must be gone (renamed) after install");

    const partial2 = path.join(stagingDir, "job2.partial");
    await fs.writeFile(partial2, buffer);
    const duplicate = await modules.installVerifiedDownload({ modelsDir, registry, partialPath: partial2, job: { fileName: "model.gguf", displayName: "Model", expectedSha256: expectedHash }, sourceUrl: "https://example.com/model.gguf" });
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.existing.id, installed.model.id);

    const partial3 = path.join(stagingDir, "job3.partial");
    await fs.writeFile(partial3, buffer);
    const mismatched = await modules.installVerifiedDownload({ modelsDir, registry, partialPath: partial3, job: { fileName: "model.gguf", displayName: "Model", expectedSha256: "f".repeat(64) }, sourceUrl: "https://example.com/model.gguf" });
    assert.equal(mismatched.status, "failed");
    assert.match(mismatched.reason, /sha256 mismatch/);

    const partial4 = path.join(stagingDir, "job4.partial");
    await fs.writeFile(partial4, "this is not a gguf file, just plain text padding".repeat(4));
    const invalid = await modules.installVerifiedDownload({ modelsDir, registry, partialPath: partial4, job: { fileName: "bad.gguf", displayName: "Bad" }, sourceUrl: "https://example.com/bad.gguf" });
    assert.equal(invalid.status, "failed");
    assert.match(invalid.reason, /not a valid GGUF/);

    assert.equal((await registry.list()).models.length, 1, "only the first, verified file should ever be installed");
    const quarantined = await fs.readdir(path.join(modelsDir, ".quarantine"));
    assert.equal(quarantined.length, 2, "the hash-mismatch and invalid-GGUF files should both be quarantined, not deleted or installed");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------
// ModelDownloadService end-to-end, against real local mock HTTP servers on 127.0.0.1.
// -------------------------------------------------------------------------------------------

test("ModelDownloadService: start() validates input before ever touching the network (bad license, bad size, insufficient disk space)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });
    const { service } = createService(modules, modelsDir);
    const validInput = { source: { kind: "url", url: "https://example.com/model.gguf" }, displayName: "M", fileName: "model.gguf", expectedSizeBytes: 100, license: { id: "mit", name: "MIT" } };

    await assert.rejects(service.start({ ...validInput, fileName: "model.bin" }), /bare \.gguf/);
    await assert.rejects(service.start({ ...validInput, expectedSizeBytes: 0 }), /expectedSizeBytes/);
    await assert.rejects(service.start({ ...validInput, license: undefined }), /license/);

    const { service: tightService } = createService(modules, modelsDir, { diskSpace: async () => ({ freeBytes: 10, totalBytes: 1000 }) });
    await assert.rejects(tightService.start(validInput), /insufficient disk space/);
    assert.deepEqual((await tightService.list()), [], "a rejected start() must never create a job record");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ModelDownloadService: full download with Content-Length completes, verifies, and installs", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 4096 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer(makeResumableHandler(buffer));
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, registry, events } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/resumable") }, displayName: "Fixture", fileName: "fixture.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      assert.equal(job.state, "queued");

      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.equal(settled.bytesDownloaded, buffer.length);
      assert.ok(settled.installedModelId);

      const installedModel = await registry.get(settled.installedModelId);
      assert.equal(installedModel.sha256, expectedHash);
      assert.equal(installedModel.architecture, "llama");

      assert.ok(events.some((event) => event.state === "downloading" && event.bytesDownloaded > 0), "progress events must have been emitted");
      assert.ok(events.some((event) => event.state === "completed"));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a chunked response with no Content-Length completes and installs correctly", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "qwen2"]], padTo: 4096 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer((req, res) => {
    // No Content-Length set, and multiple writes: Node emits this as chunked transfer-encoding.
    res.writeHead(200, { "Transfer-Encoding": "chunked" });
    res.write(buffer.subarray(0, Math.floor(buffer.length / 2)));
    res.end(buffer.subarray(Math.floor(buffer.length / 2)));
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/chunked") }, displayName: "Chunked", fileName: "chunked.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.equal(settled.bytesDownloaded, buffer.length);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a mid-stream disconnect is automatically retried and resumes via Range, producing a byte-correct final file", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 8192 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer(makeResumableHandler(buffer, { dropAfterBytesOnRequest: { request: 1, bytes: 2048 } }));
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/resumable") }, displayName: "Resumable", fileName: "resumable.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.ok(settled.attempt >= 2, "the drop must have forced at least one retry");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: cancel(deletePartial:false) then retry() resumes the same download via Range and completes with the correct hash", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 16384 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  let firstConnectionSeen = false;
  const { server, url } = await startServer((req, res) => {
    const range = req.headers.range;
    if (!range) {
      firstConnectionSeen = true;
      res.writeHead(200, { "Content-Length": String(buffer.length), ETag: '"stable-etag"', "Last-Modified": "Wed, 01 Jan 2026 00:00:00 GMT" });
      // Stream slowly enough that the test can cancel mid-flight, then just hang (simulating the
      // client walking away) — the request is destroyed client-side by cancel(), not resolved here.
      res.write(buffer.subarray(0, 4096));
      return;
    }
    const ifRange = req.headers["if-range"];
    assert.equal(ifRange, '"stable-etag"', "retry() must resend the previously stored validator");
    const match = /bytes=(\d+)-/.exec(range);
    const start = Number(match[1]);
    assert.ok(start > 0 && start <= buffer.length, "resume must start from a real partial offset, not from zero");
    const chunk = buffer.subarray(start);
    res.writeHead(206, { "Content-Range": `bytes ${start}-${buffer.length - 1}/${buffer.length}`, "Content-Length": String(chunk.length), ETag: '"stable-etag"' });
    res.end(chunk);
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, jobStore } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/slow") }, displayName: "Cancelable", fileName: "cancelable.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });

      // Wait until at least some bytes have landed before cancelling.
      let waited = 0;
      while (waited < 2000) {
        const current = await jobStore.get(job.id);
        if (current && current.bytesDownloaded > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        waited += 10;
      }
      assert.ok(firstConnectionSeen);

      const cancelled = await service.cancel(job.id, { deletePartial: false });
      assert.equal(cancelled, true);
      await service.waitForSettled(job.id);
      const paused = await jobStore.get(job.id);
      assert.equal(paused.state, "paused");
      assert.ok(paused.bytesDownloaded > 0, "the partial bytes must be preserved by a keep-partial cancel");
      assert.ok(paused.resumeValidator?.etag, "the resume validator must be preserved by a keep-partial cancel");

      // Never installed while paused.
      assert.equal((await service.list()).find((j) => j.id === job.id).installedModelId, undefined);

      const retried = await service.retry(job.id);
      assert.equal(retried.state, "queued");
      const finalJob = await service.waitForSettled(job.id);
      assert.equal(finalJob.state, "completed");
      assert.ok(finalJob.installedModelId);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: cancel(deletePartial:true) discards the partial and the job is never installed", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 16384 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": String(buffer.length) });
    res.write(buffer.subarray(0, 4096));
    // Then just hang — the client (cancel()) tears the connection down.
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, jobStore, registry } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/slow") }, displayName: "Discardable", fileName: "discardable.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });

      let waited = 0;
      while (waited < 2000) {
        const current = await jobStore.get(job.id);
        if (current && current.bytesDownloaded > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        waited += 10;
      }
      await service.cancel(job.id, { deletePartial: true });
      await service.waitForSettled(job.id);

      const finalJob = await jobStore.get(job.id);
      assert.equal(finalJob.state, "cancelled");
      assert.equal(finalJob.bytesDownloaded, 0);
      assert.equal(finalJob.partialRelativePath, undefined);
      assert.equal((await registry.list()).models.length, 0, "a discarded cancel must never install anything");

      const stagingEntries = await fs.readdir(path.join(modelsDir, ".staging")).catch(() => []);
      assert.equal(stagingEntries.length, 0, "the partial file must actually be removed from disk");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: dispose() (simulated force-quit) preserves the partial for a later resume rather than installing or silently discarding it", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 16384 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": String(buffer.length), ETag: '"force-quit-etag"' });
    res.write(buffer.subarray(0, 4096));
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, jobStore, registry } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/slow") }, displayName: "ForceQuit", fileName: "force-quit.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });

      let waited = 0;
      while (waited < 2000) {
        const current = await jobStore.get(job.id);
        if (current && current.bytesDownloaded > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        waited += 10;
      }
      service.dispose(); // no explicit cancel() call: this is the "raw kill" path
      await new Promise((resolve) => setTimeout(resolve, 100));

      const finalJob = await jobStore.get(job.id);
      assert.equal(finalJob.state, "paused", "an external abort (not a user cancel) must default to keeping the partial, not discarding it");
      assert.ok(finalJob.bytesDownloaded > 0);
      assert.equal((await registry.list()).models.length, 0, "must never be installed without full verification");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a server that ignores Range (no resume support) still completes correctly by restarting the attempt from scratch", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 8192 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer(makeResumableHandler(buffer, { dropAfterBytesOnRequest: { request: 1, bytes: 2048 }, ignoreRange: true }));
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/resumable") }, displayName: "NoResume", fileName: "no-resume.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.equal(settled.bytesDownloaded, buffer.length);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a resume validator mismatch (server ETag changed) is detected and the attempt restarts from scratch", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 8192 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer(makeResumableHandler(buffer, { dropAfterBytesOnRequest: { request: 1, bytes: 2048 }, rotateEtagAfterRequest: 1 }));
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/resumable") }, displayName: "StaleValidator", fileName: "stale-validator.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.equal(settled.bytesDownloaded, buffer.length);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: 429 (Retry-After) then 500 then success are retried with backoff and the job still completes", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 2048 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  let requestCount = 0;
  const { server, url } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) { res.writeHead(429, { "Retry-After": "0" }); res.end("slow down"); return; }
    if (requestCount === 2) { res.writeHead(500); res.end("server error"); return; }
    res.writeHead(200, { "Content-Length": String(buffer.length) });
    res.end(buffer);
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/flaky") }, displayName: "Flaky", fileName: "flaky.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      assert.equal(requestCount, 3);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a 404 is not retried and fails the job immediately", async () => {
  const { server, url } = await startServer((req, res) => { res.writeHead(404); res.end("not found"); });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/missing") }, displayName: "Missing", fileName: "missing.gguf", expectedSizeBytes: 100, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "failed");
      assert.equal(settled.attempt, 1, "a non-retryable status must not be retried");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a response exceeding the expected/declared size is rejected and the job fails without installing anything", async () => {
  const oversized = buildGgufBuffer({ version: 3, padTo: 4096 });
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": String(oversized.length) });
    res.end(oversized);
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, registry } = createService(modules, modelsDir);
      // Declare a much smaller expected size than what the server will actually send.
      const job = await service.start({ source: { kind: "url", url: url("/oversized") }, displayName: "Oversized", fileName: "oversized.gguf", expectedSizeBytes: 1024, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "failed");
      assert.match(settled.error?.message ?? "", /exceeds/);
      assert.equal((await registry.list()).models.length, 0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: a sha256 mismatch fails the job and quarantines the file instead of installing it", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 2048 });
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(buffer.length) }); res.end(buffer); });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, registry } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/wronghash") }, displayName: "WrongHash", fileName: "wrong-hash.gguf", expectedSizeBytes: buffer.length, expectedSha256: "f".repeat(64), license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "failed");
      assert.match(settled.error?.message ?? "", /sha256 mismatch/);
      assert.equal((await registry.list()).models.length, 0);
      const quarantined = await fs.readdir(path.join(modelsDir, ".quarantine"));
      assert.equal(quarantined.length, 1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: an invalid GGUF payload fails the job and quarantines it instead of installing", async () => {
  const garbage = Buffer.from("not a gguf file, just padding text to be a plausible size".repeat(40), "utf8");
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(garbage.length) }); res.end(garbage); });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service, registry } = createService(modules, modelsDir);
      const job = await service.start({ source: { kind: "url", url: url("/garbage") }, displayName: "Garbage", fileName: "garbage.gguf", expectedSizeBytes: garbage.length, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "failed");
      assert.match(settled.error?.message ?? "", /not a valid GGUF/);
      assert.equal((await registry.list()).models.length, 0);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("ModelDownloadService: redirect chains are followed up to the limit and rejected beyond it", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 1024 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");

  const { server: okServer, url: okUrl } = await startServer((req, res) => {
    const hops = Number(new URL(req.url, "http://x").searchParams.get("hops") ?? "0");
    if (hops > 0) { res.writeHead(302, { Location: okUrl(`/hop?hops=${hops - 1}`) }); res.end(); return; }
    res.writeHead(200, { "Content-Length": String(buffer.length) });
    res.end(buffer);
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const { service: withinLimit } = createService(modules, modelsDir, { maxRedirects: 5 });
      const goodJob = await withinLimit.start({ source: { kind: "url", url: okUrl("/hop?hops=3") }, displayName: "Redirected", fileName: "redirected.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const goodSettled = await withinLimit.waitForSettled(goodJob.id);
      assert.equal(goodSettled.state, "completed");

      const { service: tooFew } = createService(modules, modelsDir, { maxRedirects: 2 });
      const badJob = await tooFew.start({ source: { kind: "url", url: okUrl("/hop?hops=5") }, displayName: "TooManyHops", fileName: "too-many-hops.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const badSettled = await tooFew.waitForSettled(badJob.id);
      assert.equal(badSettled.state, "failed");
      assert.match(badSettled.error?.message ?? "", /too many redirects/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(okServer);
  }
});

test("ModelDownloadService: an https-to-http redirect downgrade is refused", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    await fs.mkdir(modelsDir, { recursive: true });
    // httpsRequest is overridden to a fake transport whose "response" is actually a synthetic
    // 302 pointing at a plain http:// URL — this isolates the downgrade check itself without
    // needing a real TLS server.
    const fakeHttpsRequest = (target, options, callback) => {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = () => {};
      req.setTimeout = () => {};
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 302;
        res.headers = { location: "http://127.0.0.1:1/downgraded" };
        res.resume = () => {};
        callback(res);
      });
      return req;
    };
    const { service } = createService(modules, modelsDir, { httpsRequest: fakeHttpsRequest });
    const job = await service.start({ source: { kind: "url", url: "https://example.com/model.gguf" }, displayName: "Downgrade", fileName: "downgrade.gguf", expectedSizeBytes: 100, license: { id: "mit", name: "MIT" } });
    const settled = await service.waitForSettled(job.id);
    assert.equal(settled.state, "failed");
    assert.match(settled.error?.message ?? "", /downgrade/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ModelDownloadService: the HF token is attached to a gated host's request and stripped when a redirect crosses to a different host", async () => {
  const buffer = buildGgufBuffer({ version: 3, padTo: 1024 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  let originSawAuth;
  let targetSawAuth;

  const { server: targetServer, url: targetUrl } = await startServer((req, res) => {
    targetSawAuth = req.headers.authorization;
    res.writeHead(200, { "Content-Length": String(buffer.length) });
    res.end(buffer);
  });
  const { server: originServer, url: originUrl } = await startServer((req, res) => {
    originSawAuth = req.headers.authorization;
    res.writeHead(302, { Location: targetUrl("/cdn-file.gguf") });
    res.end();
  });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const originHost = new URL(originUrl("/")).hostname;
      const { service, secretStore } = createService(modules, modelsDir, { gatedHosts: [originHost] });
      await secretStore.set(modules.HUGGING_FACE_TOKEN_SECRET_KEY, "secret-hf-token");

      const job = await service.start({ source: { kind: "url", url: originUrl("/gated-model.gguf") }, displayName: "Gated", fileName: "gated.gguf", expectedSizeBytes: buffer.length, expectedSha256: expectedHash, license: { id: "mit", name: "MIT" } });
      const settled = await service.waitForSettled(job.id);
      assert.equal(settled.state, "completed");

      assert.equal(originSawAuth, "Bearer secret-hf-token", "the origin (gated) host must receive the token");
      assert.equal(targetSawAuth, undefined, "a different host reached via redirect must never receive the token");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(originServer);
    await closeServer(targetServer);
  }
});

// -------------------------------------------------------------------------------------------
// Restart recovery: jobs left mid-flight by an unclean shutdown become resumable or cleanup
// candidates, never silently "still downloading" forever.
// -------------------------------------------------------------------------------------------

test("ModelDownloadService: recoverOnStartup() turns an orphaned 'downloading' job with a partial+validator into 'paused' (resumable), and one without into 'failed' (cleaned up)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const modelsDir = path.join(directory, "models");
    const stagingDir = path.join(modelsDir, ".staging");
    await fs.mkdir(stagingDir, { recursive: true });
    const jobStore = new modules.DownloadJobStore({ jobsFile: path.join(modelsDir, "download-jobs.json"), jobsBackupFile: path.join(modelsDir, "download-jobs.json.bak") });
    const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });

    // Resumable orphan: partial file + resume validator both survived the crash.
    const resumableId = "orphan-resumable";
    await fs.writeFile(path.join(stagingDir, `${resumableId}.partial`), Buffer.alloc(1024, 1));
    await jobStore.upsert(makeJobRecord({ id: resumableId, state: "downloading", bytesDownloaded: 1024, resumeValidator: { etag: '"e"' }, expectedSizeBytes: 4096 }));

    // Cleanup orphan: state says "downloading" but nothing usable survived (no validator).
    const deadId = "orphan-dead";
    await fs.writeFile(path.join(stagingDir, `${deadId}.partial`), Buffer.alloc(512, 2));
    await jobStore.upsert(makeJobRecord({ id: deadId, state: "downloading", bytesDownloaded: 512, expectedSizeBytes: 4096 }));

    const secretStore = new modules.MemorySecretStore();
    const service = new modules.ModelDownloadService(modelsDir, jobStore, registry, secretStore, () => {}, { isAddressAllowed: () => true, allowInsecureSources: true });
    const result = await service.recoverOnStartup();
    assert.deepEqual(result.resumed, [resumableId]);
    assert.deepEqual(result.failed, [deadId]);

    const resumableAfter = await jobStore.get(resumableId);
    assert.equal(resumableAfter.state, "paused");
    assert.equal(resumableAfter.bytesDownloaded, 1024, "resumable recovery must preserve the partial's byte count");

    const deadAfter = await jobStore.get(deadId);
    assert.equal(deadAfter.state, "failed");
    assert.equal(deadAfter.bytesDownloaded, 0);
    assert.equal(await fs.access(path.join(stagingDir, `${deadId}.partial`)).then(() => true, () => false), false, "the unusable partial must actually be deleted from disk");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ModelDownloadService: a recovered 'paused' job can be retried end-to-end via Range resume after a simulated restart", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 8192 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer(makeResumableHandler(buffer));
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      const stagingDir = path.join(modelsDir, ".staging");
      await fs.mkdir(stagingDir, { recursive: true });
      const jobId = "restart-resume";
      const partialBytes = buffer.subarray(0, 4096);
      await fs.writeFile(path.join(stagingDir, `${jobId}.partial`), partialBytes);

      const jobStore = new modules.DownloadJobStore({ jobsFile: path.join(modelsDir, "download-jobs.json"), jobsBackupFile: path.join(modelsDir, "download-jobs.json.bak") });
      const registry = new modules.InstalledRegistry({ registryFile: path.join(modelsDir, "registry.json"), registryBackupFile: path.join(modelsDir, "registry.json.bak") });
      await jobStore.upsert(makeJobRecord({
        id: jobId, state: "downloading", bytesDownloaded: partialBytes.length,
        resumeValidator: { etag: '"fixture-etag"' }, expectedSizeBytes: buffer.length, expectedSha256: expectedHash,
        source: { kind: "url", url: url("/resumable") }, fileName: "restart.gguf", displayName: "Restart",
      }));

      const secretStore = new modules.MemorySecretStore();
      const service = new modules.ModelDownloadService(modelsDir, jobStore, registry, secretStore, () => {}, {
        isAddressAllowed: () => true, allowInsecureSources: true, diskSpace: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 }), overheadBytes: 0, progressIntervalMs: 1,
      });
      const recovery = await service.recoverOnStartup();
      assert.deepEqual(recovery.resumed, [jobId]);
      assert.equal((await jobStore.get(jobId)).state, "paused");

      await service.retry(jobId);
      const settled = await service.waitForSettled(jobId);
      assert.equal(settled.state, "completed");
      assert.ok(settled.installedModelId);
      const model = await registry.get(settled.installedModelId);
      assert.equal(model.sha256, expectedHash);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});

// -------------------------------------------------------------------------------------------
// ModelRepository facade: catalog-driven start resolves size/hash/license from the bundled
// catalog, and the IPC-facing job list never carries an absolute path.
// -------------------------------------------------------------------------------------------

test("ModelRepository: startDownload(kind:'catalog') resolves size/hash/license from the bundled catalog and installs under the catalog model id", async () => {
  const buffer = buildGgufBuffer({ version: 3, kvEntries: [["general.architecture", "llama"]], padTo: 2048 });
  const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(buffer.length) }); res.end(buffer); });
  try {
    const { modules, directory } = await loadModules();
    try {
      const modelsDir = path.join(directory, "models");
      await fs.mkdir(modelsDir, { recursive: true });
      const catalogFile = path.join(directory, "catalog.json");
      await fs.writeFile(catalogFile, JSON.stringify({
        schemaVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        models: [{
          id: "repo-model", name: "Repo Model", architecture: "llama", quantization: "Q4_K_M",
          fileName: "repo-model.gguf", sizeBytes: buffer.length, sha256: expectedHash,
          license: { id: "mit", name: "MIT License" }, capabilities: ["chat"],
          // catalog-loader.ts's own schema validation (#75) requires a genuine https:// URL —
          // unlike the other tests here, this one keeps that check fully real (no
          // allowInsecureSources escape hatch) and instead rewrites the transport itself below.
          source: { kind: "download", url: url("/repo-model.gguf").replace("http://", "https://") },
        }],
      }));

      const secretStore = new modules.MemorySecretStore();
      const repository = new modules.ModelRepository({ modelsDir, catalogFile, chooseFile: async () => null, secretStore, emitDownloadProgress: () => {} }, {}, {
        isAddressAllowed: () => true,
        // TEST-ONLY: rewrites the https:// URL back to plain http before handing it to Node's
        // real http.request, so the mock server (plain HTTP) can serve it while the catalog entry
        // and resolveDownloadSourceUrl both see (and validate) a genuine https:// URL end to end.
        httpsRequest: (target, options, callback) => http.request(new URL(target.toString().replace(/^https:/, "http:")), options, callback),
        diskSpace: async () => ({ freeBytes: 10 * 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024 }), overheadBytes: 0, progressIntervalMs: 1,
      });
      await repository.initializeDownloads();

      await assert.rejects(repository.startDownload({ kind: "catalog", catalogModelId: "repo-model", licenseAccepted: false }), /license/);

      const job = await repository.startDownload({ kind: "catalog", catalogModelId: "repo-model", licenseAccepted: true });
      assert.equal(job.catalogModelId, "repo-model");
      const settled = await repository.downloads.waitForSettled(job.id);
      assert.equal(settled.state, "completed");
      const model = await repository.getInstalled(settled.installedModelId);
      assert.equal(model.sha256, expectedHash);
      assert.equal(model.source.catalogModelId, "repo-model");

      const listed = await repository.listDownloads();
      assert.ok(listed.every((entry) => !entry.partialRelativePath || !path.isAbsolute(entry.partialRelativePath)));

      await assert.rejects(repository.startDownload({ kind: "catalog", catalogModelId: "does-not-exist", licenseAccepted: true }), /was not found/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    await closeServer(server);
  }
});
