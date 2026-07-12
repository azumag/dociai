#!/usr/bin/env node
// generate-checksums.mjs (#72): dist/release配下の実artifact (zip/dmg/exe等) ごとにsha256を
// 書き出し、version/git SHA/build time/channel/platform/archとlicense manifestを束ねた
// release-manifest.jsonを生成する。
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_EXTENSIONS = new Set([".zip", ".dmg", ".exe", ".appimage", ".deb", ".rpm", ".msi"]);

export function isArtifactFile(fileName) {
  if (fileName.endsWith(".sha256")) return false;
  if (fileName === "release-manifest.json") return false;
  return ARTIFACT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

export async function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// artifactName: ${productName}-${version}-${os}-${arch}.${ext} (electron-builder.yml と一致させる)
const ARTIFACT_NAME_PATTERN = /^(?<product>[^-]+)-(?<version>.+)-(?<os>mac|win|linux)-(?<arch>arm64|x64|ia32|universal)\.(?<ext>[^.]+)$/i;

export function parseArtifactName(fileName) {
  const match = ARTIFACT_NAME_PATTERN.exec(fileName);
  if (!match?.groups) return { product: null, version: null, os: null, arch: null, ext: path.extname(fileName).replace(/^\./, "") };
  return { ...match.groups };
}

export function buildReleaseManifest({ buildInfo, artifacts, licenses = [], now = () => new Date() }) {
  if (!buildInfo?.version || !buildInfo?.gitSha) throw new Error("buildInfo with version/gitSha is required");
  return {
    formatVersion: 1,
    version: buildInfo.version,
    gitSha: buildInfo.gitSha,
    buildTime: buildInfo.buildTime,
    channel: buildInfo.channel,
    generatedAt: now().toISOString(),
    artifacts,
    licenses,
  };
}

export async function listArtifactFiles(outputDir) {
  let entries;
  try {
    entries = await fsp.readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isFile() && isArtifactFile(entry.name)).map((entry) => entry.name).sort();
}

export async function generateChecksums(outputDir, buildInfo, licenses = []) {
  const fileNames = await listArtifactFiles(outputDir);
  const artifacts = [];
  for (const fileName of fileNames) {
    const filePath = path.join(outputDir, fileName);
    const sha256 = await computeSha256(filePath);
    const { size } = await fsp.stat(filePath);
    await fsp.writeFile(`${filePath}.sha256`, `${sha256}  ${fileName}\n`, "utf8");
    const parsed = parseArtifactName(fileName);
    artifacts.push({ fileName, platform: parsed.os, arch: parsed.arch, sizeBytes: size, sha256 });
  }
  const manifest = buildReleaseManifest({ buildInfo, artifacts, licenses });
  const manifestPath = path.join(outputDir, "release-manifest.json");
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { artifacts, manifest, manifestPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, "dist/release");
  const buildInfoPath = path.join(repoRoot, "build/generated/build-info.json");
  if (!fs.existsSync(buildInfoPath)) {
    console.error(`FAIL | generate-checksums | build-info.json not found at ${buildInfoPath}. Run "npm run electron:build" first.`);
    process.exit(1);
  }
  const buildInfo = JSON.parse(await fsp.readFile(buildInfoPath, "utf8"));
  const licensesPath = path.join(repoRoot, "build/generated/licenses.json");
  const licenses = fs.existsSync(licensesPath) ? JSON.parse(await fsp.readFile(licensesPath, "utf8")).packages ?? [] : [];
  const { artifacts, manifestPath } = await generateChecksums(outputDir, buildInfo, licenses);
  if (artifacts.length === 0) console.log(`WARN | generate-checksums | no artifact files found in ${outputDir}`);
  console.log(`PASS | generate-checksums | ${artifacts.length} artifact(s) checksummed, manifest at ${manifestPath}`);
}
