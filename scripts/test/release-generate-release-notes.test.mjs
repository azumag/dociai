import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  resolvePreviousTag,
  collectCommitLog,
  extractReferencedNumbers,
  formatReleaseNotes,
  generateReleaseNotes,
} from "../release/generate-release-notes.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("extractReferencedNumbers picks up squash-merge '(#123)' and 'Merge pull request #123' subjects, dedupes and sorts", () => {
  const commits = [
    { sha: "a", shortSha: "a", subject: "feat: add thing (#150)" },
    { sha: "b", shortSha: "b", subject: "Merge pull request #154 from azumag/codex/issue-73-code-signing" },
    { sha: "c", shortSha: "c", subject: "fix: unrelated commit with no reference" },
    { sha: "d", shortSha: "d", subject: "feat: touches #150 and #12 in one message" },
  ];
  assert.deepEqual(extractReferencedNumbers(commits), [12, 150, 154]);
});

test("formatReleaseNotes always includes a trailing Manual notes heading for hand-written additions", () => {
  const markdown = formatReleaseNotes({
    version: "1.0.0",
    previousTag: "v0.9.0",
    toRef: "HEAD",
    commits: [{ sha: "aaa", shortSha: "aaa1234", subject: "feat: thing (#1)" }],
    referencedNumbers: [1],
    repoSlug: "azumag/dociai",
  });
  assert.match(markdown, /^# 1\.0\.0/);
  assert.match(markdown, /_Generated from v0\.9\.0\.\.HEAD\._/);
  assert.match(markdown, /- feat: thing \(#1\) \(aaa1234\)/);
  assert.match(markdown, /https:\/\/github\.com\/azumag\/dociai\/issues\/1/);
  assert.match(markdown, /## Manual notes\n\n_Add highlights, breaking changes, and upgrade guidance here before publishing\._/);
});

test("formatReleaseNotes describes an unbounded range as a first release when there is no previous tag", () => {
  const markdown = formatReleaseNotes({ version: "0.1.0", previousTag: null, toRef: "HEAD", commits: [], referencedNumbers: [] });
  assert.match(markdown, /first release, no previous tag/);
  assert.match(markdown, /_No commits in range\._/);
  assert.match(markdown, /_None found in commit subjects\._/);
});

test("generateReleaseNotes against this repository's real git log: no tags exist yet, so it falls back to full history", async () => {
  // CI's checkout runs with the default shallow fetch-depth (1 commit), while a normal
  // developer clone has full history — assert only what's true in both: the fixture-repo
  // test above already proves the exact commit-range/reference-extraction logic in detail.
  const { stdout } = await execFileAsync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repoRoot });
  const isShallow = stdout.trim() === "true";

  const result = await generateReleaseNotes({ version: "0.1.0", toRef: "HEAD", repoRoot, repoSlug: "azumag/dociai" });
  assert.equal(result.previousTag, null, "this repository has never cut a tag as of #74");
  assert.ok(result.commits.length >= 1, `expected at least the current commit, got ${result.commits.length}`);
  if (!isShallow) {
    assert.ok(result.commits.length > 50, `expected a substantial real commit history, got ${result.commits.length}`);
    assert.ok(result.referencedNumbers.includes(150), "PR #150 should be discoverable in this repo's real commit log");
  }
  assert.match(result.markdown, /^# 0\.1\.0/);
  assert.match(result.markdown, /## Manual notes/);
});

async function initFixtureRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-release-notes-fixture-"));
  const git = async (...args) => execFileAsync("git", args, { cwd: dir });
  await git("init", "-q");
  await git("config", "user.email", "fixture@example.com");
  await git("config", "user.name", "Fixture");
  await fs.writeFile(path.join(dir, "a.txt"), "1");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "feat: initial commit (#1)");
  await git("tag", "v1.0.0");
  await fs.writeFile(path.join(dir, "a.txt"), "2");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "fix: second commit (#2)");
  await fs.writeFile(path.join(dir, "a.txt"), "3");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "feat: third commit, no reference here");
  return dir;
}

test("resolvePreviousTag / generateReleaseNotes narrow the range to commits after the last real tag in a throwaway fixture repo", async () => {
  const dir = await initFixtureRepo();
  try {
    const previousTag = await resolvePreviousTag("HEAD", { cwd: dir });
    assert.equal(previousTag, "v1.0.0");

    const result = await generateReleaseNotes({ version: "1.1.0", toRef: "HEAD", repoRoot: dir });
    assert.equal(result.previousTag, "v1.0.0");
    assert.equal(result.commits.length, 2, "only the two commits after v1.0.0 should be included");
    assert.deepEqual(result.commits.map((c) => c.subject), ["feat: third commit, no reference here", "fix: second commit (#2)"]);
    assert.deepEqual(result.referencedNumbers, [2], "commit #1 predates the tag and must not appear in this release's notes");
    assert.match(result.markdown, /_Generated from v1\.0\.0\.\.HEAD\._/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("collectCommitLog on an unbounded ref returns every commit reachable from it, in reverse-chronological order", async () => {
  const dir = await initFixtureRepo();
  try {
    const commits = await collectCommitLog("HEAD", { cwd: dir });
    assert.equal(commits.length, 3);
    assert.equal(commits[0].subject, "feat: third commit, no reference here");
    assert.equal(commits[2].subject, "feat: initial commit (#1)");
    for (const commit of commits) {
      assert.match(commit.sha, /^[0-9a-f]{40}$/);
      assert.match(commit.shortSha, /^[0-9a-f]{4,}$/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("generateReleaseNotes requires a version", async () => {
  await assert.rejects(() => generateReleaseNotes({ toRef: "HEAD", repoRoot }), /version is required/);
});
