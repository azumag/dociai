import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNotarytoolArgs,
  buildNotarytoolLogArgs,
  buildStapleArgs,
  buildStapleValidateArgs,
  locateAppBundle,
  notarizeAndStaple,
  default as afterSign,
} from "../release/notarize.mjs";

test("buildNotarytoolArgs builds the App Store Connect API key form", () => {
  const credentials = { mode: "app-store-connect-api-key", keyFile: "/path/key.p8", keyId: "KEYID", issuer: "ISSUER" };
  assert.deepEqual(buildNotarytoolArgs("/tmp/app.zip", credentials), [
    "notarytool", "submit", "/tmp/app.zip",
    "--key", "/path/key.p8", "--key-id", "KEYID", "--issuer", "ISSUER",
    "--wait", "--output-format", "json",
  ]);
});

test("buildNotarytoolArgs builds the Apple ID + app-specific-password form", () => {
  const credentials = { mode: "apple-id-password", appleId: "dev@example.com", appSpecificPassword: "pw", teamId: "TEAMID" };
  assert.deepEqual(buildNotarytoolArgs("/tmp/app.zip", credentials), [
    "notarytool", "submit", "/tmp/app.zip",
    "--apple-id", "dev@example.com", "--password", "pw", "--team-id", "TEAMID",
    "--wait", "--output-format", "json",
  ]);
});

test("buildNotarytoolArgs rejects an unknown credential mode rather than silently building a broken command", () => {
  assert.throws(() => buildNotarytoolArgs("/tmp/app.zip", { mode: "bogus" }), /Unknown notarization credential mode/);
});

test("buildNotarytoolLogArgs mirrors the auth args used for submit", () => {
  const apiKeyCreds = { mode: "app-store-connect-api-key", keyFile: "/path/key.p8", keyId: "KEYID", issuer: "ISSUER" };
  assert.deepEqual(buildNotarytoolLogArgs("submission-id", apiKeyCreds), [
    "notarytool", "log", "submission-id", "--output-format", "json",
    "--key", "/path/key.p8", "--key-id", "KEYID", "--issuer", "ISSUER",
  ]);
});

test("buildStapleArgs / buildStapleValidateArgs target the given app path", () => {
  assert.deepEqual(buildStapleArgs("/tmp/dociai.app"), ["stapler", "staple", "/tmp/dociai.app"]);
  assert.deepEqual(buildStapleValidateArgs("/tmp/dociai.app"), ["stapler", "validate", "/tmp/dociai.app"]);
});

test("locateAppBundle prefers the given productFilename when present", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-locate-app-"));
  try {
    await fs.mkdir(path.join(tmpRoot, "dociai.app"));
    await fs.mkdir(path.join(tmpRoot, "other.app"));
    assert.equal(await locateAppBundle(tmpRoot, "dociai"), path.join(tmpRoot, "dociai.app"));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("locateAppBundle falls back to scanning for any *.app directory when productFilename is absent or wrong", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-locate-app-"));
  try {
    await fs.mkdir(path.join(tmpRoot, "dociai.app"));
    assert.equal(await locateAppBundle(tmpRoot, undefined), path.join(tmpRoot, "dociai.app"));
    assert.equal(await locateAppBundle(tmpRoot, "nonexistent"), path.join(tmpRoot, "dociai.app"));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("locateAppBundle throws a clear error when no .app bundle exists", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-locate-app-"));
  try {
    await assert.rejects(() => locateAppBundle(tmpRoot, undefined), /No \.app bundle found/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("notarizeAndStaple skips gracefully (never throws) when no notarization credentials are present", async () => {
  const logs = [];
  const result = await notarizeAndStaple("/does/not/matter.app", { env: {}, log: (line) => logs.push(line) });
  assert.deepEqual(result.status, "skipped");
  assert.match(result.reason, /no Apple notarization credentials/);
  assert.ok(logs.some((line) => line.includes("skipped")), "should log a clear skip line");
});

test("notarizeAndStaple skips even when unrelated env vars are set (e.g. Windows signing secrets only)", async () => {
  const env = { WINDOWS_CERTIFICATE_PFX_BASE64: "abc", WINDOWS_CERTIFICATE_PASSWORD: "pw", PATH: process.env.PATH };
  const result = await notarizeAndStaple("/does/not/matter.app", { env, log: () => {} });
  assert.equal(result.status, "skipped");
});

test("afterSign no-ops immediately for non-macOS platforms without touching the filesystem", async () => {
  const result = await afterSign({ electronPlatformName: "win32", appOutDir: "/nonexistent/should-not-be-read" });
  assert.deepEqual(result, { status: "skipped", reason: "not macOS" });
});
