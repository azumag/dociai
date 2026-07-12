import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseVersionTag,
  classifyChannel,
  validateVersionTag,
  validateVersionTagForRepo,
} from "../release/validate-version-tag.mjs";

test("parseVersionTag accepts vX.Y.Z and vX.Y.Z-<prerelease>, rejects malformed tags", () => {
  assert.deepEqual(parseVersionTag("v1.2.3"), { tag: "v1.2.3", version: "1.2.3", core: "1.2.3", prerelease: null });
  assert.deepEqual(parseVersionTag("v1.2.3-beta.1"), { tag: "v1.2.3-beta.1", version: "1.2.3-beta.1", core: "1.2.3", prerelease: "beta.1" });
  assert.deepEqual(parseVersionTag("v0.1.0-rc.2"), { tag: "v0.1.0-rc.2", version: "0.1.0-rc.2", core: "0.1.0", prerelease: "rc.2" });
  assert.equal(parseVersionTag("1.2.3"), null, "missing v prefix");
  assert.equal(parseVersionTag("v1.2"), null, "not a full dot-triple");
  assert.equal(parseVersionTag("v1.2.3.4"), null, "too many segments");
  assert.equal(parseVersionTag("v1.2.3+build5"), null, "build metadata not supported by this tag convention");
  assert.equal(parseVersionTag(""), null);
  assert.equal(parseVersionTag(undefined), null);
});

test("classifyChannel: no prerelease is stable, any prerelease is beta", () => {
  assert.equal(classifyChannel(parseVersionTag("v1.2.3")), "stable");
  assert.equal(classifyChannel(parseVersionTag("v1.2.3-beta.1")), "beta");
  assert.equal(classifyChannel(parseVersionTag("v1.2.3-rc.1")), "beta");
  assert.equal(classifyChannel(null), null);
});

test("validateVersionTag passes when tag version matches package.json version, and reports the channel", () => {
  const stable = validateVersionTag({ tag: "v0.1.0", packageVersion: "0.1.0" });
  assert.deepEqual(stable, { ok: true, tag: "v0.1.0", version: "0.1.0", channel: "stable" });

  const beta = validateVersionTag({ tag: "v0.1.0-beta.3", packageVersion: "0.1.0-beta.3" });
  assert.deepEqual(beta, { ok: true, tag: "v0.1.0-beta.3", version: "0.1.0-beta.3", channel: "beta" });
});

test("validateVersionTag fails on a malformed tag", () => {
  const result = validateVersionTag({ tag: "not-a-tag", packageVersion: "0.1.0" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /malformed tag/);
});

test("validateVersionTag fails when tag version does not match package.json version", () => {
  const result = validateVersionTag({ tag: "v9.9.9", packageVersion: "0.1.0" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match package\.json version/);
  assert.match(result.reason, /"9\.9\.9"/);
  assert.match(result.reason, /"0\.1\.0"/);
});

test("validateVersionTag fails when a prerelease tag's version core matches but the full prerelease string does not", () => {
  const result = validateVersionTag({ tag: "v0.1.0-beta.1", packageVersion: "0.1.0-beta.2" });
  assert.equal(result.ok, false, "beta.1 must not match package.json's beta.2 (exact string match required)");
});

test("validateVersionTagForRepo reads package.json from the given repo root end to end", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-validate-tag-"));
  try {
    await fs.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "fixture", version: "2.5.0" }));
    assert.deepEqual(await validateVersionTagForRepo(tmpRoot, "v2.5.0"), { ok: true, tag: "v2.5.0", version: "2.5.0", channel: "stable" });
    // package.json itself must carry the matching prerelease suffix for a beta tag to validate.
    const betaMismatch = await validateVersionTagForRepo(tmpRoot, "v2.5.0-beta.9");
    assert.equal(betaMismatch.ok, false);
    const mismatch = await validateVersionTagForRepo(tmpRoot, "v3.0.0");
    assert.equal(mismatch.ok, false);

    await fs.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "fixture", version: "2.5.0-beta.9" }));
    assert.deepEqual(await validateVersionTagForRepo(tmpRoot, "v2.5.0-beta.9"), { ok: true, tag: "v2.5.0-beta.9", version: "2.5.0-beta.9", channel: "beta" });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
