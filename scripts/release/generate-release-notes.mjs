#!/usr/bin/env node
// generate-release-notes.mjs (#74): 前回tagから対象ref (デフォルト HEAD) までのcommit logを
// 集め、squash-merge commit messageの "(#123)" やマージcommitの
// "Merge pull request #123 from ..." に現れるissue/PR番号を拾ってRelease Notes用Markdownを
// 生成する。末尾に手動追記用の見出しを必ず残す — 自動生成だけをそのまま公開しない運用を
// 前提にしている(publishする側がその見出し以下を埋めるかどうかは release.md のrunbook側の責務)。
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(args, { cwd, execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl("git", args, { cwd, maxBuffer: 1024 * 1024 * 32 });
  return stdout;
}

// `beforeRef` から辿れる直近のtag ("beforeRef自身"がタグ付けされていても、それより前の1つを
// 探すため `beforeRef^` から探索する)。tagが1つも無いrepository (この repo は #74 時点でまだ
// 一度もreleaseを切っていない) では git describe が失敗するので null を返す = 「初回release」。
export async function resolvePreviousTag(beforeRef, options = {}) {
  try {
    const stdout = await runGit(["describe", "--tags", "--abbrev=0", `${beforeRef}^`], options);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// record separator (\x1e) でcommitを、unit separator (\x1f) でfieldを区切る — commit subjectに
// 実際に現れる可能性が壊滅的に低い制御文字なので、subjectの中身をescapeせずそのまま扱える。
const COMMIT_LOG_FORMAT = "%H%x1f%h%x1f%s%x1e";

export async function collectCommitLog(range, options = {}) {
  const stdout = await runGit(["log", `--pretty=format:${COMMIT_LOG_FORMAT}`, range], options);
  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, shortSha, subject] = entry.split("\x1f");
      return { sha, shortSha, subject };
    });
}

const PR_REFERENCE_PATTERN = /#(\d+)/g;

// squash-merge commits ("feat: ... (#150)") とmerge commits ("Merge pull request #154 from ...")
// の両方が同じ "#123" 形式でsubjectに現れるので、1つの正規表現で両方を拾える。
export function extractReferencedNumbers(commits) {
  const numbers = new Set();
  for (const commit of commits) {
    for (const match of commit.subject.matchAll(PR_REFERENCE_PATTERN)) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

export function formatReleaseNotes({ version, previousTag, toRef, commits, referencedNumbers, repoSlug }) {
  const lines = [];
  lines.push(`# ${version}`);
  lines.push("");
  const rangeDescription = previousTag ? `${previousTag}..${toRef}` : `up to ${toRef} (first release, no previous tag)`;
  lines.push(`_Generated from ${rangeDescription}._`);
  lines.push("");
  lines.push("## Commits");
  if (commits.length === 0) {
    lines.push("");
    lines.push("_No commits in range._");
  } else {
    for (const commit of commits) lines.push(`- ${commit.subject} (${commit.shortSha})`);
  }
  lines.push("");
  lines.push("## Issues / PRs referenced");
  if (referencedNumbers.length === 0) {
    lines.push("");
    lines.push("_None found in commit subjects._");
  } else {
    for (const number of referencedNumbers) {
      const link = repoSlug ? `https://github.com/${repoSlug}/issues/${number}` : `#${number}`;
      lines.push(`- ${link}`);
    }
  }
  lines.push("");
  lines.push("## Manual notes");
  lines.push("");
  lines.push("_Add highlights, breaking changes, and upgrade guidance here before publishing._");
  lines.push("");
  return lines.join("\n");
}

export async function generateReleaseNotes({ version, toRef = "HEAD", repoRoot, repoSlug, fromTag } = {}) {
  if (!version) throw new Error("version is required");
  const options = { cwd: repoRoot };
  const previousTag = fromTag !== undefined ? fromTag : await resolvePreviousTag(toRef, options);
  const range = previousTag ? `${previousTag}..${toRef}` : toRef;
  const commits = await collectCommitLog(range, options);
  const referencedNumbers = extractReferencedNumbers(commits);
  const markdown = formatReleaseNotes({ version, previousTag, toRef, commits, referencedNumbers, repoSlug });
  return { version, previousTag, toRef, commits, referencedNumbers, markdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/release/generate-release-notes.mjs <version> [toRef] [repoSlug]");
    process.exit(2);
  }
  const toRef = process.argv[3] ?? "HEAD";
  const repoSlug = process.argv[4] ?? process.env.GITHUB_REPOSITORY;
  const result = await generateReleaseNotes({ version, toRef, repoRoot, repoSlug });
  console.log(result.markdown);
  console.error(
    `INFO | generate-release-notes | ${result.commits.length} commit(s), ${result.referencedNumbers.length} referenced issue/PR number(s), range base: ${result.previousTag ?? "(none, first release)"}`,
  );
}
