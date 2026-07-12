import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import {
  computeBuildInfo,
  resolveGitSha,
  resolveChannel,
  resolveBuildTime,
  resolveBuildInfoForRepo,
  writeBuildInfo,
} from "../release/build-info.mjs";
import {
  packageNameFromModulePath,
  collectBundledPackageNames,
  resolvePackageLicense,
  buildLicenseManifest,
} from "../release/license-manifest.mjs";
import { archName, correctBuildInfoPlatformArch } from "../release/after-pack.mjs";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("computeBuildInfo requires version/gitSha/buildTime/channel and defaults platform/arch to the host", () => {
  const info = computeBuildInfo({ version: "0.1.0", gitSha: "abc", buildTime: "2026-01-01T00:00:00.000Z", channel: "dev" });
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.throws(() => computeBuildInfo({ gitSha: "abc", buildTime: "t", channel: "dev" }), /version is required/);
  assert.throws(() => computeBuildInfo({ version: "0.1.0", buildTime: "t", channel: "dev" }), /gitSha is required/);
  assert.throws(() => computeBuildInfo({ version: "0.1.0", gitSha: "abc", channel: "dev" }), /buildTime is required/);
  assert.throws(() => computeBuildInfo({ version: "0.1.0", gitSha: "abc", buildTime: "t" }), /channel is required/);
});

test("resolveChannel defaults to dev and honors DOCIAI_RELEASE_CHANNEL", () => {
  assert.equal(resolveChannel({}), "dev");
  assert.equal(resolveChannel({ DOCIAI_RELEASE_CHANNEL: "" }), "dev");
  assert.equal(resolveChannel({ DOCIAI_RELEASE_CHANNEL: "stable" }), "stable");
});

test("resolveBuildTime honors DOCIAI_BUILD_TIME override, otherwise uses the injected clock", () => {
  assert.equal(resolveBuildTime({ DOCIAI_BUILD_TIME: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
  assert.equal(resolveBuildTime({}, () => new Date("2026-02-02T00:00:00.000Z")), "2026-02-02T00:00:00.000Z");
});

test("resolveGitSha prefers explicit env overrides, then falls back to `git rev-parse HEAD`", () => {
  assert.equal(resolveGitSha(repoRoot, { DOCIAI_BUILD_GIT_SHA: "override-sha" }), "override-sha");
  assert.equal(resolveGitSha(repoRoot, { GITHUB_SHA: "gh-sha" }), "gh-sha");
  const fromGit = resolveGitSha(repoRoot, {});
  assert.match(fromGit, /^[0-9a-f]{40}$/, "should resolve the repo's real HEAD sha");
});

test("resolveGitSha falls back to 'unknown' outside a git repository", async () => {
  const nonRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-non-git-"));
  try {
    assert.equal(resolveGitSha(nonRepoDir, {}), "unknown");
  } finally {
    await fs.rm(nonRepoDir, { recursive: true, force: true });
  }
});

test("resolveBuildInfoForRepo reads package.json version and honors env overrides end to end", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-buildinfo-repo-"));
  try {
    await fs.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "fixture", version: "9.9.9" }));
    const info = await resolveBuildInfoForRepo(tmpRoot, { DOCIAI_BUILD_GIT_SHA: "fixture-sha", DOCIAI_BUILD_TIME: "2026-03-03T00:00:00.000Z", DOCIAI_RELEASE_CHANNEL: "beta" });
    assert.deepEqual(info, { version: "9.9.9", gitSha: "fixture-sha", buildTime: "2026-03-03T00:00:00.000Z", channel: "beta", platform: process.platform, arch: process.arch });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("writeBuildInfo persists formatted JSON that round-trips", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-write-buildinfo-"));
  try {
    const file = path.join(tmpRoot, "nested", "build-info.json");
    const info = { version: "1.0.0", gitSha: "sha", buildTime: "t", channel: "dev", platform: "darwin", arch: "arm64" };
    await writeBuildInfo(file, info);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), info);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("packageNameFromModulePath extracts scoped and unscoped package names, ignores non-package paths", () => {
  assert.equal(packageNameFromModulePath("node_modules/ws/index.js"), "ws");
  assert.equal(packageNameFromModulePath("node_modules/@electron/asar/lib/index.js"), "@electron/asar");
  assert.equal(packageNameFromModulePath("node_modules/foo/node_modules/bar/index.js"), "bar");
  assert.equal(packageNameFromModulePath("electron/main/index.ts"), null);
});

test("collectBundledPackageNames dedupes and sorts across multiple esbuild metafiles", () => {
  const metafiles = [
    { inputs: { "node_modules/ws/index.js": {}, "electron/main/index.ts": {} } },
    { inputs: { "node_modules/ws/lib/sender.js": {}, "node_modules/@scope/pkg/index.js": {} } },
  ];
  assert.deepEqual(collectBundledPackageNames(metafiles), ["@scope/pkg", "ws"]);
});

test("resolvePackageLicense reads a real package.json and falls back gracefully when missing", async () => {
  const ws = await resolvePackageLicense(repoRoot, "ws");
  assert.equal(ws.name, "ws");
  assert.equal(ws.license, "MIT");
  assert.match(ws.version, /^\d+\.\d+\.\d+/);
  const missing = await resolvePackageLicense(repoRoot, "does-not-exist-package");
  assert.deepEqual(missing, { name: "does-not-exist-package", version: "unknown", license: "UNKNOWN" });
});

test("buildLicenseManifest produces a stable, timestamped package list", async () => {
  const manifest = await buildLicenseManifest(repoRoot, [{ inputs: { "node_modules/ws/index.js": {} } }], () => new Date("2026-04-04T00:00:00.000Z"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.generatedAt, "2026-04-04T00:00:00.000Z");
  assert.deepEqual(manifest.packages, [{ name: "ws", version: manifest.packages[0].version, license: "MIT" }]);
});

async function loadMainRuntimeLayoutModules() {
  const result = await build({
    stdin: {
      contents: `export { resolveRuntimeLayout, readBuildInfo } from "./electron/main/runtime-layout.ts";`,
      resolveDir: repoRoot,
      sourcefile: "runtime-layout-test.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-runtime-layout-"));
  const file = path.join(directory, "modules.mjs");
  await fs.writeFile(file, result.outputFiles[0].text);
  return { modules: await import(file), directory };
}

test("Main process resolveRuntimeLayout: dev reads build-info.json from appPath, packaged reads it (and native/) from resourcesPath", async () => {
  const { modules, directory } = await loadMainRuntimeLayoutModules();
  try {
    const dev = modules.resolveRuntimeLayout({ isPackaged: false, appPath: "/app", resourcesPath: "/resources" });
    assert.deepEqual(dev, { mode: "dev", buildInfoFile: "/app/build-info.json", nativeDir: null });
    const packaged = modules.resolveRuntimeLayout({ isPackaged: true, appPath: "/app/app.asar", resourcesPath: "/resources" });
    assert.deepEqual(packaged, { mode: "packaged", buildInfoFile: "/resources/build-info.json", nativeDir: "/resources/native" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Main process readBuildInfo normalizes a valid file and falls back safely when missing or malformed", async () => {
  const { modules, directory } = await loadMainRuntimeLayoutModules();
  try {
    const validFile = path.join(directory, "build-info.json");
    const info = { version: "0.1.0", gitSha: "abc123", buildTime: "2026-01-01T00:00:00.000Z", channel: "stable", platform: "darwin", arch: "arm64" };
    await fs.writeFile(validFile, JSON.stringify(info));
    assert.deepEqual(modules.readBuildInfo(validFile), info);

    const missingFile = path.join(directory, "missing.json");
    const fallback = modules.readBuildInfo(missingFile);
    assert.equal(fallback.version, "0.0.0-dev");
    assert.equal(fallback.gitSha, "unknown");
    assert.equal(fallback.platform, process.platform);
    assert.equal(fallback.arch, process.arch);

    const malformedFile = path.join(directory, "malformed.json");
    await fs.writeFile(malformedFile, "{not json");
    assert.deepEqual(modules.readBuildInfo(malformedFile), fallback);

    const partialFile = path.join(directory, "partial.json");
    await fs.writeFile(partialFile, JSON.stringify({ version: "2.0.0" }));
    const partial = modules.readBuildInfo(partialFile);
    assert.equal(partial.version, "2.0.0");
    assert.equal(partial.gitSha, "unknown");
    assert.equal(partial.channel, "dev");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("archName maps electron-builder's numeric Arch enum to the string used by BuildInfo", () => {
  assert.equal(archName(0), "ia32");
  assert.equal(archName(1), "x64");
  assert.equal(archName(2), "armv7l");
  assert.equal(archName(3), "arm64");
  assert.equal(archName(4), "universal");
  assert.equal(archName(99), "99");
});

test("correctBuildInfoPlatformArch rewrites a cross-built target's platform/arch and is a no-op when already correct", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-afterpack-"));
  try {
    const original = { version: "0.1.0", gitSha: "abc123", buildTime: "2026-01-01T00:00:00.000Z", channel: "dev", platform: "darwin", arch: "arm64" };
    await fs.writeFile(path.join(tmpRoot, "build-info.json"), JSON.stringify(original));

    // Simulate cross-building mac x64 from an arm64 host (mac.target.arch: [arm64, x64]).
    const first = await correctBuildInfoPlatformArch(tmpRoot, "darwin", "x64");
    assert.equal(first.updated, true);
    assert.deepEqual(first.buildInfo, { ...original, platform: "darwin", arch: "x64" });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmpRoot, "build-info.json"), "utf8")), first.buildInfo);

    // Re-running for the same already-corrected target must be a no-op.
    const second = await correctBuildInfoPlatformArch(tmpRoot, "darwin", "x64");
    assert.equal(second.updated, false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("correctBuildInfoPlatformArch tolerates a missing build-info.json instead of throwing", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-afterpack-missing-"));
  try {
    const result = await correctBuildInfoPlatformArch(tmpRoot, "win32", "x64");
    assert.equal(result.updated, false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
