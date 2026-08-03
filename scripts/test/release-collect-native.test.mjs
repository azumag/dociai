import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shouldStrip, copyFilteredTree, resolveUpstreamPackages, collectTarget, collectAll } from "../electron/collect-native.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dociai-collect-native-test-"));
}

async function writeFile(root, relPath, contents = "x") {
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
}

test("shouldStrip excludes .map and .d.ts files, keeps everything else", () => {
  assert.equal(shouldStrip("index.js.map"), true);
  assert.equal(shouldStrip("index.d.ts"), true);
  assert.equal(shouldStrip("index.js"), false);
  assert.equal(shouldStrip("onnxruntime_binding.node"), false);
  assert.equal(shouldStrip("libonnxruntime.1.24.3.dylib"), false);
});

test("copyFilteredTree copies files recursively, strips map/d.ts, and reports relative paths+sizes", async () => {
  const root = await makeTempDir();
  try {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    await writeFile(src, "package.json", '{"name":"x"}');
    await writeFile(src, "dist/index.js", "console.log(1)");
    await writeFile(src, "dist/index.js.map", "should be stripped");
    await writeFile(src, "dist/index.d.ts", "should be stripped");
    await writeFile(src, "bin/napi-v6/darwin/arm64/binding.node", "binary-ish");

    const files = await copyFilteredTree(src, dest);
    const paths = files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["bin/napi-v6/darwin/arm64/binding.node", "dist/index.js", "package.json"]);
    assert.equal(await fs.readFile(path.join(dest, "package.json"), "utf8"), '{"name":"x"}');
    await assert.rejects(fs.access(path.join(dest, "dist/index.js.map")));
    await assert.rejects(fs.access(path.join(dest, "dist/index.d.ts")));
    const entry = files.find((f) => f.path === "package.json");
    assert.equal(entry.size, Buffer.byteLength('{"name":"x"}'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeFixturePackages(root) {
  const onnxruntimeNodeDir = path.join(root, "onnxruntime-node");
  const onnxruntimeCommonDir = path.join(root, "onnxruntime-common");
  await writeFile(onnxruntimeNodeDir, "package.json", JSON.stringify({ name: "onnxruntime-node", version: "9.9.9" }));
  await writeFile(onnxruntimeNodeDir, "dist/index.js", "module.exports = {};");
  await writeFile(onnxruntimeNodeDir, "dist/index.js.map", "stripped");
  await writeFile(onnxruntimeNodeDir, "bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "fake-binary");
  await writeFile(onnxruntimeNodeDir, "bin/napi-v6/darwin/arm64/libonnxruntime.dylib", "fake-dylib");
  await writeFile(onnxruntimeCommonDir, "package.json", JSON.stringify({ name: "onnxruntime-common", version: "1.2.3" }));
  await writeFile(onnxruntimeCommonDir, "dist/index.js", "module.exports = {};");
  const licenseSrc = path.join(root, "LICENSE.txt");
  await writeFile(root, "LICENSE.txt", "MIT-ish license text");
  return { onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc };
}

test("collectTarget writes a {supported:true} manifest and a verbatim-but-scoped package subtree when the target's binary exists", async () => {
  const root = await makeTempDir();
  try {
    const { onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc } = await makeFixturePackages(root);
    const archRoot = path.join(root, "out", "darwin-arm64");
    const manifest = await collectTarget({
      target: { platform: "darwin", arch: "arm64" },
      archRoot,
      onnxruntimeNodeDir,
      onnxruntimeCommonDir,
      licenseSrc,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    assert.equal(manifest.supported, true);
    assert.equal(manifest.package, "onnxruntime-node");
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.platform, "darwin");
    assert.equal(manifest.arch, "arm64");
    const paths = manifest.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      "LICENSE.txt",
      "bin/napi-v6/darwin/arm64/libonnxruntime.dylib",
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "dist/index.js",
      "node_modules/onnxruntime-common/dist/index.js",
      "node_modules/onnxruntime-common/package.json",
      "package.json",
    ]);
    // .map must never survive collection, even though it wasn't in a "bin/" or "dist/" dir at
    // the destination root (regression guard for the strip filter being scoped too narrowly).
    await assert.rejects(fs.access(path.join(archRoot, "package/dist/index.js.map")));
    // onnxruntime-common must be nested under package/node_modules/, not a sibling of package/ —
    // this is the exact placement electron/main/native/onnxruntime-node-shim.cjs and
    // dist/index.js's own bare `require("onnxruntime-common")` depend on (issue #267 review: the
    // sibling-under-top-level-node_modules layout considered during planning does NOT match what
    // ships here; nested is what's actually collected and loadable).
    assert.equal(await fs.readFile(path.join(archRoot, "package/node_modules/onnxruntime-common/package.json"), "utf8"), JSON.stringify({ name: "onnxruntime-common", version: "1.2.3" }));

    const manifestOnDisk = JSON.parse(await fs.readFile(path.join(archRoot, "manifest.json"), "utf8"));
    assert.deepEqual(manifestOnDisk, manifest);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectTarget writes a manifest-only {supported:false} entry when the target has no upstream binary", async () => {
  const root = await makeTempDir();
  try {
    const { onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc } = await makeFixturePackages(root);
    const archRoot = path.join(root, "out", "darwin-x64");
    const manifest = await collectTarget({
      target: { platform: "darwin", arch: "x64" }, // fixture only ships darwin/arm64
      archRoot,
      onnxruntimeNodeDir,
      onnxruntimeCommonDir,
      licenseSrc,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(manifest.supported, false);
    assert.match(manifest.reason, /darwin\/x64/);
    const entries = await fs.readdir(archRoot);
    assert.deepEqual(entries, ["manifest.json"], "an unsupported target must contain nothing besides manifest.json — no empty package/ dir");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectTarget is idempotent: re-running for the same target replaces stale content rather than accumulating it", async () => {
  const root = await makeTempDir();
  try {
    const { onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc } = await makeFixturePackages(root);
    const archRoot = path.join(root, "out", "darwin-arm64");
    await collectTarget({ target: { platform: "darwin", arch: "arm64" }, archRoot, onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc });
    // simulate a stray leftover file from a previous, differently-shaped version
    await writeFile(archRoot, "package/stale-file-from-old-version.txt", "leftover");
    await collectTarget({ target: { platform: "darwin", arch: "arm64" }, archRoot, onnxruntimeNodeDir, onnxruntimeCommonDir, licenseSrc });
    await assert.rejects(fs.access(path.join(archRoot, "package/stale-file-from-old-version.txt")), "a re-collection must wipe the arch dir first, not merge into stale content");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveUpstreamPackages resolves the real, installed onnxruntime-node/onnxruntime-common from @huggingface/transformers' own dependency scope", async () => {
  // Regression test for a real bug found during implementation: onnxruntime-common ships
  // dist/cjs/package.json and dist/esm/package.json marker files ({"type":"commonjs"}, no
  // `name` field) closer to its resolved entry point than its real package root —
  // packageRootFromEntry() must walk past those, not stop at the first package.json found.
  const { onnxruntimeNodeDir, onnxruntimeCommonDir } = await resolveUpstreamPackages();
  const nodePkg = JSON.parse(await fs.readFile(path.join(onnxruntimeNodeDir, "package.json"), "utf8"));
  assert.equal(nodePkg.name, "onnxruntime-node");
  const commonPkg = JSON.parse(await fs.readFile(path.join(onnxruntimeCommonDir, "package.json"), "utf8"));
  assert.equal(commonPkg.name, "onnxruntime-common");
});

test("collectAll (against the real repo) produces exactly the declared electron-builder targets, each with a valid manifest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-collect-native-real-"));
  try {
    const results = await collectAll({ rootDir: root, log: () => {} });
    assert.equal(results.length, 3, "must cover every SUPPORTED_TARGETS entry, not just the build host's own platform/arch");
    const byDir = Object.fromEntries(results.map((m) => [`${m.platform}-${m.arch}`, m]));
    assert.equal(byDir["darwin-arm64"].supported, true);
    assert.equal(byDir["darwin-x64"].supported, false);
    assert.equal(byDir["win32-x64"].supported, true);
    for (const m of results) {
      const archRoot = path.join(root, "build/native/onnxruntime-node", `${m.platform}-${m.arch}`);
      const onDisk = JSON.parse(await fs.readFile(path.join(archRoot, "manifest.json"), "utf8"));
      assert.deepEqual(onDisk, m);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
