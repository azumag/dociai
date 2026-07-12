import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isArtifactFile,
  parseArtifactName,
  buildReleaseManifest,
  computeSha256,
  generateChecksums,
} from "../release/generate-checksums.mjs";

test("isArtifactFile only matches known package extensions, not sidecar files", () => {
  assert.equal(isArtifactFile("dociai-0.1.0-mac-arm64.zip"), true);
  assert.equal(isArtifactFile("dociai-0.1.0-win-x64.exe"), true);
  assert.equal(isArtifactFile("dociai-0.1.0-mac-arm64.zip.sha256"), false);
  assert.equal(isArtifactFile("release-manifest.json"), false);
  assert.equal(isArtifactFile("builder-effective-config.yaml"), false);
});

test("parseArtifactName extracts version/os/arch from the fixed naming convention", () => {
  assert.deepEqual(parseArtifactName("dociai-0.1.0-mac-arm64.zip"), { product: "dociai", version: "0.1.0", os: "mac", arch: "arm64", ext: "zip" });
  assert.deepEqual(parseArtifactName("dociai-1.2.3-beta.1-win-x64.exe"), { product: "dociai", version: "1.2.3-beta.1", os: "win", arch: "x64", ext: "exe" });
  const unknown = parseArtifactName("totally-unexpected-name.bin");
  assert.equal(unknown.product, null);
  assert.equal(unknown.ext, "bin");
});

test("buildReleaseManifest embeds build info, artifacts, and licenses; requires version/gitSha", () => {
  const manifest = buildReleaseManifest({
    buildInfo: { version: "0.1.0", gitSha: "abc123", buildTime: "2026-01-01T00:00:00.000Z", channel: "dev" },
    artifacts: [{ fileName: "dociai-0.1.0-mac-arm64.zip", platform: "mac", arch: "arm64", sizeBytes: 10, sha256: "deadbeef" }],
    licenses: [{ name: "ws", version: "8.21.0", license: "MIT" }],
    now: () => new Date("2026-01-02T00:00:00.000Z"),
  });
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.gitSha, "abc123");
  assert.equal(manifest.generatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(manifest.artifacts.length, 1);
  assert.deepEqual(manifest.licenses, [{ name: "ws", version: "8.21.0", license: "MIT" }]);
  assert.throws(() => buildReleaseManifest({ buildInfo: {}, artifacts: [] }), /version\/gitSha is required/);
});

test("computeSha256 matches Node's crypto digest for a real file", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-checksum-"));
  try {
    const file = path.join(tmpRoot, "artifact.zip");
    const content = "dociai packaged artifact fixture\n".repeat(50);
    await fs.writeFile(file, content);
    const expected = crypto.createHash("sha256").update(content).digest("hex");
    assert.equal(await computeSha256(file), expected);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("generateChecksums writes a .sha256 sidecar per artifact and a consistent release-manifest.json", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-checksums-"));
  try {
    const macArtifact = path.join(tmpRoot, "dociai-0.1.0-mac-arm64.zip");
    const winArtifact = path.join(tmpRoot, "dociai-0.1.0-win-x64.zip");
    await fs.writeFile(macArtifact, "mac-artifact-fixture");
    await fs.writeFile(winArtifact, "win-artifact-fixture");
    await fs.writeFile(path.join(tmpRoot, "builder-effective-config.yaml"), "irrelevant: true");

    const buildInfo = { version: "0.1.0", gitSha: "deadbeef", buildTime: "2026-01-01T00:00:00.000Z", channel: "dev" };
    const { artifacts, manifest, manifestPath } = await generateChecksums(tmpRoot, buildInfo, [{ name: "ws", version: "8.21.0", license: "MIT" }]);

    assert.equal(artifacts.length, 2);
    const macEntry = artifacts.find((a) => a.fileName === "dociai-0.1.0-mac-arm64.zip");
    assert.equal(macEntry.platform, "mac");
    assert.equal(macEntry.arch, "arm64");
    assert.equal(macEntry.sha256, crypto.createHash("sha256").update("mac-artifact-fixture").digest("hex"));

    const sha256Sidecar = await fs.readFile(`${macArtifact}.sha256`, "utf8");
    assert.match(sha256Sidecar, new RegExp(`^${macEntry.sha256}  dociai-0.1.0-mac-arm64.zip\\n$`));

    const persisted = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    assert.deepEqual(persisted, manifest);
    assert.equal(persisted.version, "0.1.0");
    assert.equal(persisted.gitSha, "deadbeef");
    assert.equal(persisted.artifacts.length, 2);
    assert.deepEqual(persisted.licenses, [{ name: "ws", version: "8.21.0", license: "MIT" }]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
