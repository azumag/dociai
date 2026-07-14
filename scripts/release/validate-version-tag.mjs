#!/usr/bin/env node
// validate-version-tag.mjs (#74): tag `vX.Y.Z`(または `vX.Y.Z-<prerelease>`) と package.json の
// version が一致することを検証し、stable/beta channelを判定する。release.ymlのtag push起点で
// 一番最初に走り、不一致・不正な形式のtagはここでrelease workflow全体を安く落とす — 実際の
// packaging/signing (macOS/Windowsランナーを使う高価なjob) を一切実行する前に検出するのが目的。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPackageJson } from "./build-info.mjs";

// `v` prefix は tag の命名規約であり、semver比較そのもの (package.jsonのversion) には含めない。
// 例: v1.2.3, v1.2.3-beta.1, v1.2.3-rc.2 はマッチする。v1.2, 1.2.3, v1.2.3+build のような形式は
// 全て malformed 扱いにする(build metadataの `+` はこの repo のtag運用では使わない)。
const VERSION_TAG_PATTERN = /^v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function parseVersionTag(tag) {
  if (typeof tag !== "string") return null;
  const match = VERSION_TAG_PATTERN.exec(tag.trim());
  if (!match?.groups) return null;
  const { version } = match.groups;
  const dashIndex = version.indexOf("-");
  const core = dashIndex === -1 ? version : version.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? null : version.slice(dashIndex + 1);
  return { tag, version, core, prerelease };
}

// stable: prerelease接尾辞なし (vX.Y.Z)。beta: 何らかのprerelease接尾辞つき
// (vX.Y.Z-beta.N, vX.Y.Z-rc.1 等)。今のところprerelease channelは一種類 (beta) のみ — 将来
// rc等を別channelに分けたくなったらここを拡張する。
export function classifyChannel(parsedTag) {
  if (!parsedTag) return null;
  return parsedTag.prerelease ? "beta" : "stable";
}

export function validateVersionTag({ tag, packageVersion }) {
  const parsed = parseVersionTag(tag);
  if (!parsed) {
    return {
      ok: false,
      reason: `malformed tag "${tag}": expected vX.Y.Z or vX.Y.Z-<prerelease> (e.g. v1.2.3, v1.2.3-beta.1)`,
    };
  }
  if (parsed.version !== packageVersion) {
    return {
      ok: false,
      reason: `tag version "${parsed.version}" does not match package.json version "${packageVersion}"`,
    };
  }
  return { ok: true, tag, version: parsed.version, channel: classifyChannel(parsed) };
}

export async function validateVersionTagForRepo(repoRoot, tag) {
  const pkg = await readPackageJson(repoRoot);
  return validateVersionTag({ tag, packageVersion: pkg.version });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!tag) {
    console.error("Usage: node scripts/release/validate-version-tag.mjs <tag>");
    console.error("  (or set GITHUB_REF_NAME, as GitHub Actions does for a tag-push trigger)");
    process.exit(2);
  }
  const result = await validateVersionTagForRepo(repoRoot, tag);
  if (!result.ok) {
    console.error(`FAIL | validate-version-tag | ${result.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS | validate-version-tag | tag ${result.tag} -> version ${result.version}, channel ${result.channel}`);
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import("node:fs/promises");
      await fs.appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nchannel=${result.channel}\n`, "utf8");
    }
  }
}
