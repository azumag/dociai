#!/usr/bin/env node
// publish-manifest.mjs (#74): release.ymlのpublish jobが、REQUIRED_TARGETS (mac arm64 zip /
// mac x64 zip / win x64 zip / win x64 nsis exe) 分のartifact + checksum + release-manifest.json
// (#72のgenerate-checksums.mjsが各OS jobで書き出したもの) が「ちょうど1件ずつ」揃っていることを
// 確認してから、公開用の publish-manifest.json (1本にまとめたmanifest) と SHA256SUMS を書き出す。
// 1つでも欠落・重複・想定外artifact混入・checksum不一致があれば何も書き出さずexit 1で落ちる —
// 「失敗releaseが部分的なstable配布を残さない」を実装する場所。
import fsp from "node:fs/promises";
import path from "node:path";
import { computeSha256 } from "./generate-checksums.mjs";

// `ext` (not just platform/arch) matters now that win/x64 legitimately ships two artifacts (zip +
// nsis .exe, both needed — see electron-builder.yml's `win.target`) with the SAME platform/arch: a
// platform/arch-only key can't tell "the exe is here twice, the zip never uploaded" apart from
// "both present", which is exactly the failure mode #74's "never publish a partial release"
// contract exists to catch. Each entry below must match EXACTLY ONE artifact — zero is missing,
// two or more is a duplicate/stale-merge bug — and every artifact in the merged manifest must be
// consumed by some required target, so an unexpected/unlisted artifact fails loudly instead of
// silently riding along unverified in the release.
export const REQUIRED_TARGETS = [
  { platform: "mac", arch: "arm64", ext: ".zip" },
  { platform: "mac", arch: "x64", ext: ".zip" },
  { platform: "win", arch: "x64", ext: ".zip" },
  { platform: "win", arch: "x64", ext: ".exe" },
];

export function targetKey({ platform, arch, ext }) {
  return `${platform}/${arch}${ext ?? ""}`;
}

export async function findFilesRecursive(root) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findFilesRecursive(absolute)));
    else out.push({ absolute, name: entry.name });
  }
  return out;
}

// release-manifest.json は各OS packaging job (package-macos/package-windows) がそれぞれ独立に
// 書き出す。release.ymlはそれらを別々のGitHub Actions artifactとしてdownloadしてrootDir配下に
// 展開するので、ここではファイル名で再帰的に探す(どのサブディレクトリに落ちるかは
// actions/download-artifactの挙動に委ねる)。
export async function loadReleaseManifests(rootDir) {
  const files = (await findFilesRecursive(rootDir)).filter((file) => file.name === "release-manifest.json");
  const manifests = [];
  for (const file of files) manifests.push(JSON.parse(await fsp.readFile(file.absolute, "utf8")));
  return manifests;
}

export function mergeReleaseManifests(manifests) {
  if (manifests.length === 0) throw new Error("no release-manifest.json files found");
  const [first, ...rest] = manifests;
  for (const manifest of rest) {
    if (manifest.version !== first.version) throw new Error(`version mismatch across manifests: "${first.version}" vs "${manifest.version}"`);
    if (manifest.gitSha !== first.gitSha) throw new Error(`gitSha mismatch across manifests: "${first.gitSha}" vs "${manifest.gitSha}"`);
  }
  const artifacts = manifests.flatMap((manifest) => manifest.artifacts ?? []);
  const licensesByName = new Map();
  for (const manifest of manifests) for (const license of manifest.licenses ?? []) licensesByName.set(license.name, license);
  return {
    version: first.version,
    gitSha: first.gitSha,
    buildTime: first.buildTime,
    channel: first.channel,
    artifacts,
    licenses: [...licensesByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function artifactExt(fileName) {
  return path.extname(fileName).toLowerCase();
}

// 必須targetそれぞれについて、mergeした manifest 上のartifact entry(platform/arch/ext全て一致)を
// 探し、実fileと.sha256 sidecarの両方がrootDir配下に存在し、かつ実fileの実際のsha256がmanifest
// 記載値とsidecar記載値の両方に一致することを確認する(sidecarだけ・manifestだけの一致では
// 「stale copyが片方だけ更新された」ケースを見逃す)。ちょうど1件の一致を要求する: 0件は
// missing、2件以上は重複/stale mergeとしてduplicateへ。どのrequiredTargetsにも一致しない
// artifactが残っていたら(=検証を一切通らずreleaseへ混入するfile) unexpectedへ回す。
export async function verifyManifestCompleteness({ merged, rootDir, requiredTargets = REQUIRED_TARGETS, computeSha256Impl = computeSha256 }) {
  const allFiles = await findFilesRecursive(rootDir);
  const filesByName = new Map();
  for (const file of allFiles) if (!filesByName.has(file.name)) filesByName.set(file.name, file.absolute);

  const missing = [];
  const mismatched = [];
  const duplicate = [];
  const targets = [];
  const consumed = new Set();

  for (const required of requiredTargets) {
    const matches = merged.artifacts.filter((entry) => entry.platform === required.platform && entry.arch === required.arch && artifactExt(entry.fileName) === required.ext);
    if (matches.length === 0) {
      missing.push({ ...required, reason: "no artifact entry in merged release-manifest.json" });
      continue;
    }
    if (matches.length > 1) {
      // Marked consumed too, not just recorded in `duplicate` — otherwise these same entries would
      // ALSO show up in `unexpected` below (nothing else claims them), reporting one real problem
      // as two separate-looking failures in the output.
      for (const entry of matches) consumed.add(entry);
      duplicate.push({ ...required, fileNames: matches.map((entry) => entry.fileName), reason: `${matches.length} artifact entries match this target (expected exactly 1) — stale/duplicate merge?` });
      continue;
    }
    const [artifact] = matches;
    consumed.add(artifact);
    const artifactPath = filesByName.get(artifact.fileName);
    if (!artifactPath) {
      missing.push({ ...required, fileName: artifact.fileName, reason: `artifact file "${artifact.fileName}" not found under ${rootDir}` });
      continue;
    }
    const sidecarPath = filesByName.get(`${artifact.fileName}.sha256`);
    if (!sidecarPath) {
      missing.push({ ...required, fileName: artifact.fileName, reason: `checksum sidecar "${artifact.fileName}.sha256" not found under ${rootDir}` });
      continue;
    }
    const actualSha256 = await computeSha256Impl(artifactPath);
    const sidecarSha256 = (await fsp.readFile(sidecarPath, "utf8")).trim().split(/\s+/)[0];
    if (actualSha256 !== artifact.sha256 || actualSha256 !== sidecarSha256) {
      mismatched.push({ ...required, fileName: artifact.fileName, manifestSha256: artifact.sha256, sidecarSha256, actualSha256 });
      continue;
    }
    targets.push({ ...required, fileName: artifact.fileName, sha256: actualSha256, sizeBytes: artifact.sizeBytes });
  }

  const unexpected = merged.artifacts.filter((entry) => !consumed.has(entry)).map((entry) => ({ fileName: entry.fileName, platform: entry.platform, arch: entry.arch, reason: "artifact present in merged release-manifest.json but not covered by any required target" }));

  return { ok: missing.length === 0 && mismatched.length === 0 && duplicate.length === 0 && unexpected.length === 0, missing, mismatched, duplicate, unexpected, targets };
}

export function buildPublishManifest({ merged, verification, signingStatus = {}, now = () => new Date() }) {
  return {
    formatVersion: 1,
    version: merged.version,
    gitSha: merged.gitSha,
    buildTime: merged.buildTime,
    channel: merged.channel,
    generatedAt: now().toISOString(),
    targets: verification.targets
      .slice()
      .sort((a, b) => targetKey(a).localeCompare(targetKey(b)))
      .map((target) => ({ ...target, signed: signingStatus[target.platform] ?? false })),
    licenses: merged.licenses,
  };
}

export function buildSha256Sums(targets) {
  return (
    targets
      .slice()
      .sort((a, b) => a.fileName.localeCompare(b.fileName))
      .map((target) => `${target.sha256}  ${target.fileName}`)
      .join("\n") + "\n"
  );
}

// 検証を通ったときだけ publish-manifest.json / SHA256SUMS を書き出す。失敗時は何も書かない
// (呼び出し元がstaleな既存fileを誤ってuploadすることも無い — CLIは既存fileを消しもしない代わりに
// 「新しく書いた」という主張を一切しない)。
export async function publishManifest({
  rootDir,
  outDir = rootDir,
  requiredTargets = REQUIRED_TARGETS,
  signingStatus = {},
  now = () => new Date(),
  computeSha256Impl = computeSha256,
}) {
  const manifests = await loadReleaseManifests(rootDir);
  if (manifests.length === 0) return { ok: false, reason: `no release-manifest.json files found under ${rootDir}` };

  let merged;
  try {
    merged = mergeReleaseManifests(manifests);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const verification = await verifyManifestCompleteness({ merged, rootDir, requiredTargets, computeSha256Impl });
  if (!verification.ok) {
    return { ok: false, reason: "incomplete or inconsistent target set", missing: verification.missing, mismatched: verification.mismatched, duplicate: verification.duplicate, unexpected: verification.unexpected };
  }

  const publish = buildPublishManifest({ merged, verification, signingStatus, now });
  const manifestPath = path.join(outDir, "publish-manifest.json");
  const sha256sumsPath = path.join(outDir, "SHA256SUMS");
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(manifestPath, `${JSON.stringify(publish, null, 2)}\n`, "utf8");
  await fsp.writeFile(sha256sumsPath, buildSha256Sums(verification.targets), "utf8");
  return { ok: true, publish, manifestPath, sha256sumsPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!rootDir) {
    console.error("Usage: node scripts/release/publish-manifest.mjs <rootDir> [outDir]");
    process.exit(2);
  }
  const outDir = process.argv[3] ? path.resolve(process.argv[3]) : rootDir;
  const signingStatus = {
    mac: process.env.DOCIAI_MACOS_SIGNED === "true",
    win: process.env.DOCIAI_WINDOWS_SIGNED === "true",
  };
  const result = await publishManifest({ rootDir, outDir, signingStatus });
  if (!result.ok) {
    console.error(`FAIL | publish-manifest | ${result.reason}`);
    for (const entry of result.missing ?? []) console.error(`  - missing ${targetKey(entry)}: ${entry.reason}`);
    for (const entry of result.mismatched ?? [])
      console.error(`  - checksum mismatch ${targetKey(entry)}: manifest=${entry.manifestSha256} sidecar=${entry.sidecarSha256} actual=${entry.actualSha256}`);
    for (const entry of result.duplicate ?? []) console.error(`  - duplicate ${targetKey(entry)}: ${entry.reason} (${entry.fileNames?.join(", ")})`);
    for (const entry of result.unexpected ?? []) console.error(`  - unexpected artifact ${entry.fileName} (${entry.platform}/${entry.arch}): ${entry.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS | publish-manifest | ${result.publish.targets.length} target(s) verified, manifest at ${result.manifestPath}`);
  }
}
