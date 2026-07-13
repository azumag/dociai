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
// generate-checksums.mjs output) plus the real artifact files and .sha256 sidecars. win/x64 ships
// two artifacts (zip + nsis exe, per electron-builder.yml's `win.target`) — omitWinZip/omitWinExe
// control the artifact FILE (not the manifest entry), corruptWinZipSidecar/corruptWinExeSidecar
// the checksum sidecar, mirroring publishManifest's own missing-file vs. mismatched-checksum
// distinction.
async function buildFixtureTree({
  root,
  includeWin = true,
  corruptWinZipSidecar = false,
  omitWinZipArtifactFile = false,
  omitWinExeManifestEntry = false,
  duplicateWinExeManifestEntry = false,
  extraUnexpectedArtifact = false,
}) {
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
  const winX64ZipContent = "win-x64-zip-fixture-artifact";
  const winX64ExeContent = "win-x64-exe-fixture-artifact";

  const macArm64Name = "dociai-0.1.0-mac-arm64.zip";
  const macX64Name = "dociai-0.1.0-mac-x64.zip";
  const winX64ZipName = "dociai-0.1.0-win-x64.zip";
  const winX64ExeName = "dociai-0.1.0-win-x64.exe";

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
    if (!omitWinZipArtifactFile) await fs.writeFile(path.join(winArtifactsDir, winX64ZipName), winX64ZipContent);
    await fs.writeFile(path.join(winArtifactsDir, winX64ExeName), winX64ExeContent);
    const zipSidecarHash = corruptWinZipSidecar ? "0".repeat(64) : sha256(winX64ZipContent);
    await fs.writeFile(path.join(winDir, `${winX64ZipName}.sha256`), `${zipSidecarHash}  ${winX64ZipName}\n`);
    await fs.writeFile(path.join(winDir, `${winX64ExeName}.sha256`), `${sha256(winX64ExeContent)}  ${winX64ExeName}\n`);
    if (extraUnexpectedArtifact) await fs.writeFile(path.join(winArtifactsDir, "dociai-0.1.0-win-x64.msi"), "unexpected-msi-fixture");
    const winArtifacts = [{ fileName: winX64ZipName, platform: "win", arch: "x64", sizeBytes: winX64ZipContent.length, sha256: sha256(winX64ZipContent) }];
    if (!omitWinExeManifestEntry) winArtifacts.push({ fileName: winX64ExeName, platform: "win", arch: "x64", sizeBytes: winX64ExeContent.length, sha256: sha256(winX64ExeContent) });
    if (duplicateWinExeManifestEntry) winArtifacts.push({ fileName: winX64ExeName, platform: "win", arch: "x64", sizeBytes: winX64ExeContent.length, sha256: sha256(winX64ExeContent) });
    if (extraUnexpectedArtifact) winArtifacts.push({ fileName: "dociai-0.1.0-win-x64.msi", platform: "win", arch: "x64", sizeBytes: 23, sha256: sha256("unexpected-msi-fixture") });
    await fs.writeFile(
      path.join(winDir, "release-manifest.json"),
      JSON.stringify({ formatVersion: 1, version, gitSha, buildTime, channel: "stable", artifacts: winArtifacts, licenses: [{ name: "ws", version: "8.21.0", license: "MIT" }] }),
    );
  }

  return { version, gitSha, macArm64Name, macX64Name, winX64ZipName, winX64ExeName };
}

test("REQUIRED_TARGETS covers exactly mac arm64 zip, mac x64 zip, win x64 zip, win x64 exe", () => {
  assert.deepEqual(REQUIRED_TARGETS, [
    { platform: "mac", arch: "arm64", ext: ".zip" },
    { platform: "mac", arch: "x64", ext: ".zip" },
    { platform: "win", arch: "x64", ext: ".zip" },
    { platform: "win", arch: "x64", ext: ".exe" },
  ]);
  assert.equal(targetKey({ platform: "mac", arch: "arm64", ext: ".zip" }), "mac/arm64.zip");
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

test("publishManifest succeeds and writes publish-manifest.json + SHA256SUMS when all required targets (including both win/x64 artifacts) are present and consistent", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-complete-"));
  try {
    const fixture = await buildFixtureTree({ root: tmpRoot });
    const result = await publishManifest({ rootDir: tmpRoot, signingStatus: { mac: true, win: true }, now: () => new Date("2026-02-02T00:00:00.000Z") });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.publish.version, fixture.version);
    assert.equal(result.publish.gitSha, fixture.gitSha);
    assert.equal(result.publish.generatedAt, "2026-02-02T00:00:00.000Z");
    assert.equal(result.publish.targets.length, 4);
    assert.ok(result.publish.targets.every((t) => t.signed === true));
    assert.deepEqual(
      result.publish.targets.map((t) => targetKey(t)),
      ["mac/arm64.zip", "mac/x64.zip", "win/x64.exe", "win/x64.zip"],
    );

    const onDisk = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.deepEqual(onDisk, result.publish);

    const sums = await fs.readFile(result.sha256sumsPath, "utf8");
    assert.match(sums, new RegExp(`^${sha256("mac-arm64-fixture-artifact")}  dociai-0\\.1\\.0-mac-arm64\\.zip$`, "m"));
    assert.match(sums, new RegExp(`${sha256("win-x64-zip-fixture-artifact")}  dociai-0\\.1\\.0-win-x64\\.zip$`, "m"));
    assert.match(sums, new RegExp(`${sha256("win-x64-exe-fixture-artifact")}  dociai-0\\.1\\.0-win-x64\\.exe$`, "m"));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when required targets' manifest entries are entirely missing, and writes nothing", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-missing-target-"));
  try {
    await buildFixtureTree({ root: tmpRoot, includeWin: false });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    // Omitting the whole win release-manifest.json is missing BOTH win/x64 targets (zip and exe
    // are two independent required entries now), not just one.
    assert.equal(result.missing.length, 2);
    assert.deepEqual(
      result.missing.map((m) => ({ platform: m.platform, arch: m.arch, ext: m.ext })).sort((a, b) => a.ext.localeCompare(b.ext)),
      [
        { platform: "win", arch: "x64", ext: ".exe" },
        { platform: "win", arch: "x64", ext: ".zip" },
      ],
    );

    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "SHA256SUMS"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when just the win/x64 exe's manifest entry is missing, even though the zip is fine", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-missing-exe-entry-"));
  try {
    await buildFixtureTree({ root: tmpRoot, omitWinExeManifestEntry: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 1);
    assert.deepEqual({ platform: result.missing[0].platform, arch: result.missing[0].arch, ext: result.missing[0].ext }, { platform: "win", arch: "x64", ext: ".exe" });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when a required target's artifact file is absent even though its manifest entry exists", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-missing-file-"));
  try {
    await buildFixtureTree({ root: tmpRoot, omitWinZipArtifactFile: true });
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
    await buildFixtureTree({ root: tmpRoot, corruptWinZipSidecar: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.mismatched.length, 1);
    assert.deepEqual({ platform: result.mismatched[0].platform, arch: result.mismatched[0].arch, ext: result.mismatched[0].ext }, { platform: "win", arch: "x64", ext: ".zip" });
    assert.equal(result.mismatched[0].sidecarSha256, "0".repeat(64));
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when a required target has two matching manifest entries (duplicate/stale merge)", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-duplicate-"));
  try {
    await buildFixtureTree({ root: tmpRoot, duplicateWinExeManifestEntry: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.duplicate.length, 1);
    assert.deepEqual({ platform: result.duplicate[0].platform, arch: result.duplicate[0].arch, ext: result.duplicate[0].ext }, { platform: "win", arch: "x64", ext: ".exe" });
    assert.match(result.duplicate[0].reason, /2 artifact entries/);
    // The two duplicate entries must be reported once, as `duplicate` — not a second time as
    // `unexpected` just because nothing "consumed" them.
    assert.equal(result.unexpected.length, 0);
    await assert.rejects(() => fs.readFile(path.join(tmpRoot, "publish-manifest.json"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("publishManifest refuses to publish when an artifact exists that no required target covers, instead of silently letting it ride along unverified", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-publish-manifest-unexpected-"));
  try {
    await buildFixtureTree({ root: tmpRoot, extraUnexpectedArtifact: true });
    const result = await publishManifest({ rootDir: tmpRoot });

    assert.equal(result.ok, false);
    assert.equal(result.unexpected.length, 1);
    assert.equal(result.unexpected[0].fileName, "dociai-0.1.0-win-x64.msi");
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
    assert.ok(files.length >= 9, `expected at least 9 files across the fixture tree, got ${files.length}`);

    const manifests = await loadReleaseManifests(tmpRoot);
    assert.equal(manifests.length, 2);
    const merged = mergeReleaseManifests(manifests);
    assert.equal(merged.artifacts.length, 4);

    const verification = await verifyManifestCompleteness({ merged, rootDir: tmpRoot });
    assert.equal(verification.ok, true, JSON.stringify(verification));
    assert.equal(verification.targets.length, 4);

    const publish = buildPublishManifest({ merged, verification, signingStatus: { mac: true, win: false }, now: () => new Date("2026-03-03T00:00:00.000Z") });
    const macTarget = publish.targets.find((t) => t.platform === "mac" && t.arch === "arm64");
    const winTarget = publish.targets.find((t) => t.platform === "win" && t.ext === ".zip");
    assert.equal(macTarget.signed, true);
    assert.equal(winTarget.signed, false);

    const sums = buildSha256Sums(verification.targets);
    assert.equal(sums.split("\n").filter(Boolean).length, 4);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
