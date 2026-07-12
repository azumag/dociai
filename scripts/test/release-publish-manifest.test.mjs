import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REQUIRED_TARGETS,
  targetKey,
  findFilesRecursive,
  loadReleaseManifests,
  mergeReleaseManifests,
  verifyManifestCompleteness,
  buildPublishManifest,
  buildSha256Sums,
  publishManifest,
} from "../release/publish-manifest.mjs";

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Lays out a fixture tree that mimics what release.yml's `actions/download-artifact` step
// produces: one subdirectory per uploaded GitHub Actions artifact from package.yml's
// package-macos/package-windows jobs, each holding its own release-manifest.json (#72's
// generate-checksums.mjs output) plus the real artifact files and .sha256 sidecars.
async function buildFixtureTree({ root, includeWin = true, corruptWinSidecar = false, omitWinArtifactFile = false }) {
  const macDir = path.join(root, "package-macos-manifest-1");
  const macArtifactsDir = path.join(root, "package-macos-artifacts-1");
  const winDir = path.join(root, "package-windows-manifest-1");
  const winArtifactsDir = path.join(root, "package-windows-artifacts-1");
  await fs.mkdir(macDir, { recursive: true });
  await fs.mkdir(macArtifactsDir, { recursive: true });
  await fs.mkdir(winDir, { recursive: true });
  await fs.mkdir(winArtifactsDir, { recursive: true });

  const version = "0.1.0";
  const gitSha = "deadbeef";
  const buildTime = "2026-01-01T00:00:00.000Z";

  const macArm64Content = "mac-arm64-fixture-artifact";
  const macX64Content = "mac-x64-fixture-artifact";
  const winX64Content = "win-x64-fixture-artifact";

  const macArm64Name = "dociai-0.1.0-mac-arm64.zip";
  const macX64Name = "dociai-0.1.0-mac-x64.zip";
  const winX64Name = "dociai-0.1.0-win-x64.zip";

  await fs.writeFile(path.join(macArtifactsDir, macArm64Name), macArm64Content);
  await fs.writeFile(path.join(macArtifactsDir, macX64Name), macX64Content);
  await fs.writeFile(path.join(macDir, `${macArm64Name}.sha256`), `${sha256(macArm64Content)}  ${macArm64Name}\n`);
  await fs.writeFile(path.join(macDir, `${macX64Name}.sha256`), `${sha256(macX64Content)}  ${macX64Name}\n`);
  await fs.writeFile(
    path.join(macDir, "release-manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      version,
      gitSha,
      buildTime,
      channel: "stable",
      artifacts: [
        { fileName: macArm64Name, platform: "mac", arch: "arm64", sizeBytes: macArm64Content.length, sha256: sha256(macArm64Content) },
        { fileName: macX64Name, platform: "mac", arch: "x64", sizeBytes: macX64Content.length, sha256: sha256(macX64Content) },
      ],
      licenses: [{ name: "ws", version: "8.21.0", license: "MIT" }],
    }),
  );

  if (includeWin) {
    if (!omitWinArtifactFile) await fs.writeFile(path.join(winArtifactsDir, winX64Name), winX64Content);
    const sidecarHash = corruptWinSidecar ? "0".repeat(64) : sha256(winX64Content);
    await fs.writeFile(path.join(winDir, `${winX64Name}.sha256`), `${sidecarHash}  ${winX64Name}\n`);
    await fs.writeFile(
      path.join(winDir, "release-manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        version,
        gitSha,
        buildTime,
        channel: "stable",
        artifacts: [{ fileName: winX64Name, platform: "win", arch: "x64", sizeBytes: winX64Content.length, sha256: sha256(winX64Content) }],
        licenses: [{ name: "ws", version: "8.21.0", license: "MIT" }],
      }),
    );
  }

  return { version, gitSha, macArm64Name, macX64Name, winX64Name };
}

test("REQUIRED_TARGETS covers exactly mac arm64, mac x64, win x64", () => {
  assert.deepEqual(REQUIRED_TARGETS, [
    { platform: "mac", arch: "arm64" },
    { platform: "mac", arch: "x64" },
    { platform: "win", arch: "x64" },
  ]);
  assert.equal(targetKey({ platform: "mac", arch: "arm64" }), "mac/arm64");
});

test("mergeReleaseManifests concatenates artifacts and dedupes licenses by name, but rejects mismatched version/gitSha", () => {
  const a = { version: "1.0.0", gitSha: "sha1", buildTime: "t", channel: "stable", artifacts: [{ fileName: "a.zip" }], licenses: [{ name: "ws", version: "1", license: "MIT" }] };
  const b = { version: "1.0.0", gitSha: "sha1", buildTime: "t", channel: "stable", artifacts: [{ fileName: "b.zip" }], licenses: [{ name: "ws", version: "1", license: "MIT" }] };
  const merged = mergeReleaseManifests([a, b]);
  assert.equal(merged.artifacts.length, 2);
  assert.equal(merged.licenses.length, 1, "duplicate license entries across platform manifests must be deduped");

  const c = { ...b, version: "2.0.0" };
  assert.throws(() => mergeReleaseManifests([a, c]), /version mismatch/);
  const d = { ...b, gitSha: "other-sha" };
  assert.throws(() => mergeReleaseManifests([a, d]), /gitSha mismatch/);
  assert.throws(() => mergeReleaseManifests([]), /no release-manifest\.json files found/);
});

test("publishManifest succeeds and writes publish-manifest.json + SHA256SUMS when all required targets are present and consistent", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-complete-"));
  try {
    const fixture = await buildFixtureTree({ root: tmpRoot });
    const result = await publishManifest({ rootDir: tmpRoot, signingStatus: { mac: true, win: true }, now: () => new Date("2026-02-02T00:00:00.000Z") });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.publish.version, fixture.version);
    assert.equal(result.publish.gitSha, fixture.gitSha);
    assert.equal(result.publish.generatedAt, "2026-02-02T00:00:00.000Z");
    assert.equal(result.publish.targets.length, 3);
    assert.ok(result.publish.targets.every((t) => t.signed === true));
    assert.deepEqual(
      result.publish.targets.map((t) => targetKey(t)),
      ["mac/arm64", "mac/x64", "win/x64"],
    );

    const onDisk = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.deepEqual(onDisk, result.publish);

    const sums = await fs.readFile(result.sha256sumsPath, "utf8");
    assert.match(sums, new RegExp(`^${sha256("mac-arm64-fixture-artifact")}  dociai-0\\.1\\.0-mac-arm64\\.zip$`, "m"));
    assert.match(sums, new RegExp(`${sha256("win-x64-fixture-artifact")}  dociai-0\\.1\\.0-win-x64\\.zip$`, "m"));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when a required target's manifest entry is entirely missing, and writes nothing", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-missing-target-"));
  try {
    await buildFixtureTree({ root: tmpRoot, includeWin: false });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.deepEqual({ platform: result.missing[0].platform, arch: result.missing[0].arch }, { platform: "win", arch: "x64" });

    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "SHA256SUMS"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when a required target's artifact file is absent even though its manifest entry exists", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-missing-file-"));
  try {
    await buildFixtureTree({ root: tmpRoot, omitWinArtifactFile: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0].reason, /artifact file .* not found/);
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when a sidecar checksum does not match the real file bytes (stale/corrupt sidecar)", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-checksum-mismatch-"));
  try {
    await buildFixtureTree({ root: tmpRoot, corruptWinSidecar: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.mismatched.length, 1);
    assert.deepEqual({ platform: result.mismatched[0].platform, arch: result.mismatched[0].arch }, { platform: "win", arch: "x64" });
    assert.equal(result.mismatched[0].sidecarSha256, "0".repeat(64));
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest fails cleanly when there are no release-manifest.json files at all", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-empty-"));
  try {
    const result = await publishManifest({ rootDir: tmpRoot });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no release-manifest\.json files found/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("findFilesRecursive / loadReleaseManifests / verifyManifestCompleteness compose correctly against the fixture tree", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-compose-"));
  try {
    await buildFixtureTree({ root: tmpRoot });
    const files = await findFilesRecursive(tmpRoot);
    assert.ok(files.length >= 7, `expected at least 7 files across the fixture tree, got ${files.length}`);

    const manifests = await loadReleaseManifests(tmpRoot);
    assert.equal(manifests.length, 2);
    const merged = mergeReleaseManifests(manifests);
    assert.equal(merged.artifacts.length, 3);

    const verification = await verifyManifestCompleteness({ merged, rootDir: tmpRoot });
    assert.equal(verification.ok, true, JSON.stringify(verification));
    assert.equal(verification.targets.length, 3);

    const publish = buildPublishManifest({ merged, verification, signingStatus: { mac: true, win: false }, now: () => new Date("2026-03-03T00:00:00.000Z") });
    const macTarget = publish.targets.find((t) => t.platform === "mac" && t.arch === "arm64");
    const winTarget = publish.targets.find((t) => t.platform === "win");
    assert.equal(macTarget.signed, true);
    assert.equal(winTarget.signed, false);

    const sums = buildSha256Sums(verification.targets);
    assert.equal(sums.split("\n").filter(Boolean).length, 3);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
