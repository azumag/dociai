import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

async function loadModules() {
  const result = await build({
    stdin: {
      contents: `export { downloadVerifiedFile, guardedLookup } from "./electron/main/services/translation/translation-model-downloader.ts"; export { ServiceError } from "./electron/main/services/service-error.ts";`,
      resolveDir: repoRoot,
      sourcefile: "translation-model-downloader-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["onnxruntime-node", "sharp"],
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(repoRoot, "node_modules", ".dociai-translation-downloader-test-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
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

function sha256Of(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("downloads a file, streams it to disk, and returns the matching sha256/size", async () => {
  const { modules, directory } = await loadModules();
  const buffer = crypto.randomBytes(64 * 1024);
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(buffer.length) }); res.end(buffer); });
  try {
    const destinationPath = path.join(directory, "out.bin");
    const progressCalls = [];
    const result = await modules.downloadVerifiedFile({
      url: new URL(url("/file.bin")),
      destinationPath,
      expectedSizeBytes: buffer.length,
      expectedSha256: sha256Of(buffer),
      signal: new AbortController().signal,
      isAddressAllowed: () => true, // 127.0.0.1 fixture server — real SSRF policy is tested separately below
      allowInsecure: true,
      onProgress: (bytesDownloaded, totalBytes) => progressCalls.push([bytesDownloaded, totalBytes]),
    });
    assert.equal(result.sha256, sha256Of(buffer));
    assert.equal(result.sizeBytes, buffer.length);
    assert.deepEqual(await fs.readFile(destinationPath), buffer);
    assert.ok(progressCalls.length > 0);
    assert.deepEqual(progressCalls.at(-1), [buffer.length, buffer.length]);
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("a sha256 mismatch throws BAD_REQUEST/retryable:false and removes the partial file", async () => {
  const { modules, directory } = await loadModules();
  const buffer = crypto.randomBytes(4096);
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(buffer.length) }); res.end(buffer); });
  try {
    const destinationPath = path.join(directory, "out.bin");
    await assert.rejects(
      modules.downloadVerifiedFile({
        url: new URL(url("/file.bin")),
        destinationPath,
        expectedSizeBytes: buffer.length,
        expectedSha256: "0".repeat(64),
        signal: new AbortController().signal,
        isAddressAllowed: () => true,
        allowInsecure: true,
      }),
      // retryable:false — re-downloading the exact same URL would re-fetch the exact same
      // (wrong) bytes and fail identically every time, unlike a genuinely transient NETWORK
      // error; PR review flagged this as previously (inconsistently) retryable:true.
      (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST" && error.retryable === false && /sha256 mismatch/.test(error.message),
    );
    await assert.rejects(fs.access(destinationPath));
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("a declared size mismatch throws and removes the partial file", async () => {
  const { modules, directory } = await loadModules();
  const buffer = crypto.randomBytes(4096);
  const { server, url } = await startServer((req, res) => { res.writeHead(200, { "Content-Length": String(buffer.length) }); res.end(buffer); });
  try {
    const destinationPath = path.join(directory, "out.bin");
    await assert.rejects(
      modules.downloadVerifiedFile({
        url: new URL(url("/file.bin")),
        destinationPath,
        expectedSizeBytes: buffer.length + 100,
        expectedSha256: sha256Of(buffer),
        signal: new AbortController().signal,
        isAddressAllowed: () => true,
        allowInsecure: true,
      }),
      (error) => error instanceof modules.ServiceError && /expected \d+/.test(error.message),
    );
    await assert.rejects(fs.access(destinationPath));
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("follows a same-protocol redirect to the final URL", async () => {
  const { modules, directory } = await loadModules();
  const buffer = crypto.randomBytes(2048);
  const { server, url } = await startServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: url("/final") }); res.end(); return; }
    res.writeHead(200, { "Content-Length": String(buffer.length) });
    res.end(buffer);
  });
  try {
    const destinationPath = path.join(directory, "out.bin");
    const result = await modules.downloadVerifiedFile({
      url: new URL(url("/redirect")),
      destinationPath,
      expectedSizeBytes: buffer.length,
      expectedSha256: sha256Of(buffer),
      signal: new AbortController().signal,
      isAddressAllowed: () => true,
      allowInsecure: true,
    });
    assert.equal(result.sha256, sha256Of(buffer));
  } finally { await closeServer(server); await fs.rm(directory, { recursive: true, force: true }); }
});

test("rejects a non-https starting URL before ever connecting", async () => {
  const { modules, directory } = await loadModules();
  try {
    await assert.rejects(
      modules.downloadVerifiedFile({
        url: new URL("http://127.0.0.1:1/file.bin"),
        destinationPath: path.join(directory, "out.bin"),
        expectedSizeBytes: 10,
        expectedSha256: "0".repeat(64),
        signal: new AbortController().signal,
      }),
      (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST" && /https/.test(error.message),
    );
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("the default address policy refuses a literal 127.0.0.1 host without ever opening a connection (SSRF regression)", async () => {
  const { modules, directory } = await loadModules();
  try {
    // A literal IP host is checked synchronously before any socket is opened (see
    // translation-model-downloader.ts's singleRequest), so no server needs to be listening here —
    // if this ever regressed to "allow by default", the test would instead hang/fail on ECONNREFUSED
    // rather than reject with this specific BAD_REQUEST message.
    await assert.rejects(
      modules.downloadVerifiedFile({
        url: new URL("https://127.0.0.1:65535/file.bin"),
        destinationPath: path.join(directory, "out.bin"),
        expectedSizeBytes: 4,
        expectedSha256: "0".repeat(64),
        signal: new AbortController().signal,
        // isAddressAllowed intentionally omitted: exercises the real default (isPublicAddress).
      }),
      (error) => error instanceof modules.ServiceError && error.code === "BAD_REQUEST" && /disallowed address/.test(error.message),
    );
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Regression coverage for a real bug found by testing against a live hostname (huggingface.co):
// Node's http/https client sometimes invokes a custom `lookup` option with `{ all: true }`
// (Happy-Eyeballs dual-stack racing), requesting every resolved address back as an array rather
// than a single (address, family) pair. The originally-reused createGuardedLookup
// (electron/main/services/local-llm/models/model-source-resolver.ts) always calls the underlying
// dns.lookup with `all: false` regardless of what was requested, which crashed with
// `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` the first time a real hostname was
// exercised end-to-end (never caught by unit tests using only literal IPs / local fixture
// servers). guardedLookup here must handle both calling conventions correctly.

function fakeDnsLookupAll(addresses) {
  return (hostname, options, callback) => {
    assert.equal(options.all, true, "guardedLookup must always request all:true from the underlying dns.lookup, regardless of what its own caller asked for");
    callback(null, addresses);
  };
}

test("guardedLookup responds with a single (address, family) pair when the caller did not request all:true", async () => {
  const { modules, directory } = await loadModules();
  try {
    const lookup = modules.guardedLookup(() => true, fakeDnsLookupAll([{ address: "203.0.113.5", family: 4 }, { address: "2001:db8::1", family: 6 }]));
    await new Promise((resolve, reject) => {
      lookup("example.test", { family: 0, all: false }, (err, address, family) => {
        try {
          assert.equal(err, null);
          assert.equal(address, "203.0.113.5");
          assert.equal(family, 4);
          resolve();
        } catch (e) { reject(e); }
      });
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("guardedLookup responds with an array of allowed addresses when the caller requested all:true (Happy Eyeballs)", async () => {
  const { modules, directory } = await loadModules();
  try {
    const lookup = modules.guardedLookup(() => true, fakeDnsLookupAll([{ address: "203.0.113.5", family: 4 }, { address: "2001:db8::1", family: 6 }]));
    await new Promise((resolve, reject) => {
      lookup("example.test", { family: 0, all: true }, (err, addresses) => {
        try {
          assert.equal(err, null);
          assert.deepEqual(addresses, [{ address: "203.0.113.5", family: 4 }, { address: "2001:db8::1", family: 6 }]);
          resolve();
        } catch (e) { reject(e); }
      });
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("guardedLookup filters out disallowed addresses and only rejects when NONE of the resolved addresses are allowed", async () => {
  const { modules, directory } = await loadModules();
  try {
    const dnsLookup = fakeDnsLookupAll([{ address: "127.0.0.1", family: 4 }, { address: "203.0.113.5", family: 4 }]);
    const isAllowed = (address) => address !== "127.0.0.1";

    const lookup = modules.guardedLookup(isAllowed, dnsLookup);
    await new Promise((resolve, reject) => {
      lookup("example.test", { family: 0, all: true }, (err, addresses) => {
        try {
          assert.equal(err, null);
          assert.deepEqual(addresses, [{ address: "203.0.113.5", family: 4 }]);
          resolve();
        } catch (e) { reject(e); }
      });
    });

    const allBlockedLookup = modules.guardedLookup(() => false, dnsLookup);
    await new Promise((resolve, reject) => {
      allBlockedLookup("example.test", { family: 0, all: true }, (err) => {
        try {
          assert.ok(err);
          assert.equal(err.code, "EADDRBLOCKED");
          resolve();
        } catch (e) { reject(e); }
      });
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
