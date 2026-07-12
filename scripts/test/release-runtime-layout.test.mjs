import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveLayout, resolvePackagedLayout, targetFor } from "../release/runtime-layout.mjs";

const repoRoot = "/repo";

test("dev layout resolves build-info.json inside dist/electron and has no resources dir", () => {
  const layout = resolveLayout({ mode: "dev", repoRoot });
  assert.equal(layout.mode, "dev");
  assert.equal(layout.appDir, path.join(repoRoot, "dist/electron"));
  assert.equal(layout.buildInfoFile, path.join(repoRoot, "dist/electron/build-info.json"));
  assert.equal(layout.resourcesDir, null);
  assert.equal(layout.asarPath, null);
  assert.equal(layout.executable, null);
});

test("packaged/unpacked mac layout resolves Contents/Resources and the .app executable", () => {
  for (const mode of ["packaged", "unpacked"]) {
    const layout = resolveLayout({ mode, repoRoot, platform: "darwin", arch: "arm64" });
    assert.equal(layout.mode, "packaged");
    assert.equal(layout.appDir, path.join(repoRoot, "dist/release/mac-arm64/dociai.app"));
    assert.equal(layout.resourcesDir, path.join(repoRoot, "dist/release/mac-arm64/dociai.app/Contents/Resources"));
    assert.equal(layout.asarPath, path.join(layout.resourcesDir, "app.asar"));
    assert.equal(layout.buildInfoFile, path.join(layout.resourcesDir, "build-info.json"));
    assert.equal(layout.nativeDir, path.join(layout.resourcesDir, "native"));
    assert.equal(layout.executable, path.join(layout.appDir, "Contents/MacOS/dociai"));
  }
});

test("mac x64 uses electron-builder's un-suffixed 'mac' output directory", () => {
  const layout = resolvePackagedLayout({ repoRoot, platform: "darwin", arch: "x64" });
  assert.equal(layout.appDir, path.join(repoRoot, "dist/release/mac/dociai.app"));
});

test("windows layout resolves resources/ and the .exe executable", () => {
  const layout = resolveLayout({ mode: "packaged", repoRoot, platform: "win32", arch: "x64" });
  assert.equal(layout.appDir, path.join(repoRoot, "dist/release/win-unpacked"));
  assert.equal(layout.resourcesDir, path.join(repoRoot, "dist/release/win-unpacked/resources"));
  assert.equal(layout.asarPath, path.join(layout.resourcesDir, "app.asar"));
  assert.equal(layout.executable, path.join(layout.appDir, "dociai.exe"));
});

test("custom productName/executableName/outputRoot are honored", () => {
  const layout = resolvePackagedLayout({ repoRoot, platform: "darwin", arch: "arm64", productName: "DociAI Beta", executableName: "dociai-beta", outputRoot: "/custom/out" });
  assert.equal(layout.appDir, "/custom/out/mac-arm64/DociAI Beta.app");
  assert.equal(layout.executable, "/custom/out/mac-arm64/DociAI Beta.app/Contents/MacOS/dociai-beta");
});

test("unsupported target and mode raise clear errors", () => {
  assert.throws(() => targetFor("linux", "arm64"), /Unsupported package target/);
  assert.throws(() => resolveLayout({ mode: "bogus", repoRoot }), /Unknown mode/);
  assert.throws(() => resolveLayout({ mode: "dev" }), /repoRoot is required/);
});
