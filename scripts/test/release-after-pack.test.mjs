import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { correctBuildInfoPlatformArch, pruneNativeOnnxruntimeDirs } from "../release/after-pack.mjs";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dociai-after-pack-test-"));
}

test("correctBuildInfoPlatformArch rewrites a mismatched platform/arch and no-ops when already correct", async () => {
  const tmpRoot = await makeTempDir();
  try {
    const buildInfoFile = path.join(tmpRoot, "build-info.json");
    await fs.writeFile(buildInfoFile, JSON.stringify({ platform: "darwin", arch: "arm64", version: "1.0.0" }));
    const first = await correctBuildInfoPlatformArch(tmpRoot, "darwin", "x64");
    assert.equal(first.updated, true);
    assert.deepEqual(JSON.parse(await fs.readFile(buildInfoFile, "utf8")), { platform: "darwin", arch: "x64", version: "1.0.0" });
    const second = await correctBuildInfoPlatformArch(tmpRoot, "darwin", "x64");
    assert.equal(second.updated, false);
    assert.equal(second.reason, "already correct");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

async function makeArchDir(nativeRoot, dirName) {
  const dir = path.join(nativeRoot, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ platform: dirName.split("-")[0], arch: dirName.split("-")[1] }));
  return dir;
}

test("pruneNativeOnnxruntimeDirs removes every non-matching arch directory and keeps the matching one", async () => {
  const tmpRoot = await makeTempDir();
  try {
    const nativeRoot = path.join(tmpRoot, "native/onnxruntime-node");
    await makeArchDir(nativeRoot, "darwin-arm64");
    await makeArchDir(nativeRoot, "darwin-x64");
    await makeArchDir(nativeRoot, "win32-x64");

    const result = await pruneNativeOnnxruntimeDirs(tmpRoot, "darwin", "x64");
    assert.deepEqual(result.pruned.sort(), ["darwin-arm64", "win32-x64"]);
    assert.equal(result.keptDirName, "darwin-x64");
    assert.equal(result.present, true);

    const remaining = await fs.readdir(nativeRoot);
    assert.deepEqual(remaining, ["darwin-x64"]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("pruneNativeOnnxruntimeDirs keeps a manifest-only {supported:false} directory too (it must not be treated as an empty/prunable leftover)", async () => {
  const tmpRoot = await makeTempDir();
  try {
    const nativeRoot = path.join(tmpRoot, "native/onnxruntime-node");
    await makeArchDir(nativeRoot, "darwin-arm64");
    await makeArchDir(nativeRoot, "darwin-x64"); // manifest-only, {supported:false} in real usage

    const result = await pruneNativeOnnxruntimeDirs(tmpRoot, "darwin", "x64");
    assert.deepEqual(result.pruned, ["darwin-arm64"]);
    const remaining = await fs.readdir(nativeRoot);
    assert.deepEqual(remaining, ["darwin-x64"]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("pruneNativeOnnxruntimeDirs throws when the target arch directory is missing after pruning (a collection regression)", async () => {
  const tmpRoot = await makeTempDir();
  try {
    const nativeRoot = path.join(tmpRoot, "native/onnxruntime-node");
    await makeArchDir(nativeRoot, "darwin-arm64");
    await makeArchDir(nativeRoot, "win32-x64");
    await assert.rejects(() => pruneNativeOnnxruntimeDirs(tmpRoot, "darwin", "x64"), /is missing after pruning/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("pruneNativeOnnxruntimeDirs throws when native/onnxruntime-node/ does not exist at all (collect-native.mjs was bypassed)", async () => {
  const tmpRoot = await makeTempDir();
  try {
    await assert.rejects(() => pruneNativeOnnxruntimeDirs(tmpRoot, "darwin", "x64"), /native\/onnxruntime-node\/ is missing/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
