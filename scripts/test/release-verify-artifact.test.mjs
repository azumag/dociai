import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import {
  classifyRelativePath,
  scanRelativePaths,
  hasModelsOrUserDataDir,
  verifyArtifactTree,
  resolveResourcesDir,
  verifyNativeOnnxruntimeLayout,
} from "../release/verify-artifact.mjs";

test("classifyRelativePath flags known-forbidden files by exact name and pattern", () => {
  assert.equal(classifyRelativePath("config.local.json").forbidden, true);
  assert.equal(classifyRelativePath(".env").forbidden, true);
  assert.equal(classifyRelativePath(".env.production").forbidden, true);
  assert.equal(classifyRelativePath("secrets.enc.json").forbidden, true);
  assert.equal(classifyRelativePath("models/llama-7b.gguf").forbidden, true);
  assert.equal(classifyRelativePath("main.cjs.map").forbidden, true);
  assert.equal(classifyRelativePath("assets/id_rsa").forbidden, true);
  assert.equal(classifyRelativePath("nested/.git/HEAD").forbidden, true);
  assert.equal(classifyRelativePath("app.asar/node_modules/foo/index.js").forbidden, true);
});

test("classifyRelativePath does not flag legitimate shipped files", () => {
  assert.equal(classifyRelativePath("config.local.example.json").forbidden, false, "example template must not be flagged");
  assert.equal(classifyRelativePath("build-info.json").forbidden, false);
  assert.equal(classifyRelativePath("licenses.json").forbidden, false);
  assert.equal(classifyRelativePath("app.asar/main.cjs").forbidden, false);
  assert.equal(classifyRelativePath("app.asar/index.html").forbidden, false);
  assert.equal(classifyRelativePath("native/node-llama-cpp/manifest.json").forbidden, false);
  // issue #267: collect-native.mjs synthesizes a nested node_modules/onnxruntime-common/ so
  // Node's normal module resolution can find it — this one exact location is exempt.
  assert.equal(classifyRelativePath("native/onnxruntime-node/darwin-arm64/package/node_modules/onnxruntime-common/dist/index.js").forbidden, false);
  assert.equal(classifyRelativePath("native/onnxruntime-node/darwin-arm64/package/dist/index.js").forbidden, false);
});

test("classifyRelativePath does NOT broaden the node_modules exemption beyond onnxruntime-common's exact nested location", () => {
  assert.equal(classifyRelativePath("native/onnxruntime-node/darwin-arm64/package/node_modules/some-other-package/index.js").forbidden, true, "only onnxruntime-common may sit under the collected package's node_modules/");
  assert.equal(classifyRelativePath("node_modules/onnxruntime-node/index.js").forbidden, true, "a real top-level node_modules/ must still be forbidden everywhere else");
  assert.equal(classifyRelativePath("app.asar/node_modules/onnxruntime-common/index.js").forbidden, true, "the exemption must not apply inside the asar");
});

test("scanRelativePaths aggregates only the forbidden entries with reasons", () => {
  const violations = scanRelativePaths(["build-info.json", ".env", "app.asar/index.html", "secrets.enc.json.bak"]);
  assert.deepEqual(violations.map((v) => v.path).sort(), [".env", "secrets.enc.json.bak"]);
  for (const violation of violations) assert.equal(typeof violation.reason, "string");
});

test("hasModelsOrUserDataDir detects a models/ or userData/ directory anywhere in the tree", () => {
  assert.equal(hasModelsOrUserDataDir(["app.asar/main.cjs", "build-info.json"]), false);
  assert.equal(hasModelsOrUserDataDir(["models/llama.gguf"]), true);
  assert.equal(hasModelsOrUserDataDir(["userData/config.json"]), true);
});

async function makeFixtureResources(tmpRoot, { extraResourceFiles = {}, asarFiles = {} } = {}) {
  const resourcesDir = path.join(tmpRoot, "Contents", "Resources");
  const asarSource = path.join(tmpRoot, "asar-src");
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.mkdir(asarSource, { recursive: true });
  for (const [relativePath, contents] of Object.entries(asarFiles)) {
    const file = path.join(asarSource, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  await createPackage(asarSource, path.join(resourcesDir, "app.asar"));
  for (const [relativePath, contents] of Object.entries(extraResourceFiles)) {
    const file = path.join(resourcesDir, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return resourcesDir;
}

test("verifyArtifactTree passes a clean packaged fixture", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-clean-"));
  try {
    const resourcesDir = await makeFixtureResources(tmpRoot, {
      extraResourceFiles: { "build-info.json": "{}", "licenses.json": "{}" },
      asarFiles: { "main.cjs": "console.log('main')", "index.html": "<html></html>", "config.local.example.json": "{}" },
    });
    const result = await verifyArtifactTree(resourcesDir);
    assert.deepEqual(result.violations, []);
    assert.equal(result.hasAsar, true);
    assert.equal(result.hasBuildInfo, true);
    assert.equal(result.hasLicenses, true);
    assert.equal(result.hasModelsOrUserDataDir, false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyArtifactTree flags a fixture containing forbidden files inside and outside the asar", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-dirty-"));
  try {
    const resourcesDir = await makeFixtureResources(tmpRoot, {
      extraResourceFiles: { "build-info.json": "{}", "licenses.json": "{}", ".env": "SECRET=1", "models/local.bin": "binary" },
      asarFiles: { "main.cjs": "console.log('main')", "config.local.json": "{\"connectors\":{}}" },
    });
    const result = await verifyArtifactTree(resourcesDir);
    const violationPaths = result.violations.map((v) => v.path).sort();
    assert.deepEqual(violationPaths, [".env", "app.asar/config.local.json"], "models/local.bin is flagged separately via hasModelsOrUserDataDir, not the forbidden-file scan");
    assert.equal(result.hasModelsOrUserDataDir, true, "models/ directory must be detected");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveResourcesDir finds Contents/Resources from a mac .app root and from its parent directory", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-resolve-"));
  try {
    const appBundle = path.join(tmpRoot, "dociai.app");
    const resourcesDir = await makeFixtureResources(appBundle, { extraResourceFiles: { "build-info.json": "{}" } });
    assert.equal(await resolveResourcesDir(appBundle), resourcesDir);
    assert.equal(await resolveResourcesDir(tmpRoot), resourcesDir, "should discover the .app bundle inside the given root");
    assert.equal(await resolveResourcesDir(resourcesDir), resourcesDir, "should be a no-op when already pointed at Resources");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

// issue #267: verifyNativeOnnxruntimeLayout fixtures. Deliberately hand-built rather than routed
// through collect-native.mjs, so these tests catch a regression in either module independently.
async function writeNativeFile(root, relPath, contents) {
  const file = path.join(root, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return (await fs.stat(file)).size;
}

async function makeSupportedNativeFixture(resourcesDir, dirName = "darwin-arm64") {
  const archDir = path.join(resourcesDir, "native/onnxruntime-node", dirName);
  const size1 = await writeNativeFile(archDir, "package/package.json", '{"name":"onnxruntime-node"}');
  const size2 = await writeNativeFile(archDir, "package/dist/index.js", "module.exports = {};");
  const size3 = await writeNativeFile(archDir, "package/bin/napi-v6/darwin/arm64/onnxruntime_binding.node", "fake-native-binary-content");
  const [platform, arch] = dirName.split("-");
  const manifest = {
    formatVersion: 1,
    package: "onnxruntime-node",
    version: "1.24.3",
    platform,
    arch,
    supported: true,
    collectedAt: "2026-01-01T00:00:00.000Z",
    files: [
      { path: "package.json", size: size1 },
      { path: "dist/index.js", size: size2 },
      { path: "bin/napi-v6/darwin/arm64/onnxruntime_binding.node", size: size3 },
    ],
  };
  await fs.writeFile(path.join(archDir, "manifest.json"), JSON.stringify(manifest));
  return { archDir, manifest };
}

test("verifyNativeOnnxruntimeLayout passes a clean {supported:true} fixture", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-clean-"));
  try {
    await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.deepEqual(problems, []);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout fails when native/onnxruntime-node/ is missing entirely, regardless of platform/arch", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-missing-"));
  try {
    for (const target of [{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }, { platform: "win32", arch: "x64" }]) {
      const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, target);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /is missing under/);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout fails when the arch directory name does not match build-info.json", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-mismatch-"));
  try {
    await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "win32", arch: "x64" });
    assert.ok(problems.some((p) => p.includes("does not match build-info.json")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout flags a native binary smaller than its collected size as possibly truncated", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-truncated-"));
  try {
    const { archDir } = await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    await fs.writeFile(path.join(archDir, "package/bin/napi-v6/darwin/arm64/onnxruntime_binding.node"), "x");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("possibly truncated")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout flags a non-native file whose size drifted from the manifest", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-sizedrift-"));
  try {
    const { archDir } = await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    await fs.writeFile(path.join(archDir, "package/dist/index.js"), "module.exports = { changed: true };");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("size mismatch")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout flags a file present on disk but not listed in the manifest", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-unlisted-"));
  try {
    const { archDir } = await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    await writeNativeFile(archDir, "package/stray-unlisted-file.txt", "surprise");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("stray-unlisted-file.txt") && p.includes("not listed in manifest.json")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout passes a clean {supported:false} manifest-only fixture, and rejects extra entries alongside it", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-unsupported-"));
  try {
    const archDir = path.join(tmpRoot, "native/onnxruntime-node/darwin-x64");
    await fs.mkdir(archDir, { recursive: true });
    const manifest = { formatVersion: 1, package: "onnxruntime-node", version: "1.24.3", platform: "darwin", arch: "x64", supported: false, reason: "onnxruntime-node@1.24.3 ships no darwin/x64 binary", collectedAt: "2026-01-01T00:00:00.000Z" };
    await fs.writeFile(path.join(archDir, "manifest.json"), JSON.stringify(manifest));
    assert.deepEqual(await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "x64" }), []);

    await fs.writeFile(path.join(archDir, "unexpected.txt"), "should not be here");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "x64" });
    assert.ok(problems.some((p) => p.includes("unexpected entries")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout fails when more than one arch directory is present (a stale cross-build leftover)", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-multi-"));
  try {
    await makeSupportedNativeFixture(tmpRoot, "darwin-arm64");
    await makeSupportedNativeFixture(tmpRoot, "win32-x64");
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("expected exactly one arch directory")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout fails a {supported:true} manifest whose files[] is empty or missing, instead of silently passing an entirely-missing package/", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-emptyfiles-"));
  try {
    const archDir = path.join(tmpRoot, "native/onnxruntime-node/darwin-arm64");
    await fs.mkdir(archDir, { recursive: true });
    // package/ is deliberately never created — this is the exact "collection produced nothing"
    // failure verifyNativeOnnxruntimeLayout exists to catch; without the files.length guard,
    // walkDirectory() swallows package/'s ENOENT into [] and the loop below just never runs.
    const manifest = { formatVersion: 1, package: "onnxruntime-node", version: "1.24.3", platform: "darwin", arch: "arm64", supported: true, collectedAt: "2026-01-01T00:00:00.000Z", files: [] };
    await fs.writeFile(path.join(archDir, "manifest.json"), JSON.stringify(manifest));
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("lists no native binary file")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyNativeOnnxruntimeLayout fails a {supported:true} manifest whose files[] contains only non-binary entries (e.g. package.json but no .node/.dylib/.dll)", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-native-nobinary-"));
  try {
    const archDir = path.join(tmpRoot, "native/onnxruntime-node/darwin-arm64");
    const size = await writeNativeFile(archDir, "package/package.json", '{"name":"onnxruntime-node"}');
    const manifest = { formatVersion: 1, package: "onnxruntime-node", version: "1.24.3", platform: "darwin", arch: "arm64", supported: true, collectedAt: "2026-01-01T00:00:00.000Z", files: [{ path: "package.json", size }] };
    await fs.writeFile(path.join(archDir, "manifest.json"), JSON.stringify(manifest));
    const problems = await verifyNativeOnnxruntimeLayout(tmpRoot, { platform: "darwin", arch: "arm64" });
    assert.ok(problems.some((p) => p.includes("lists no native binary file")));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
