// scripts/release/verify-macos-signing.sh (#73) — macOS-only: exercises real `codesign`/`spctl`.
// Skips cleanly on non-darwin (see release-setup-macos-keychain.test.mjs for the same rationale).
//
// No real Apple Developer ID certificate exists in this sandbox (see docs/signing.md), so these
// fixtures use ad-hoc signing (`codesign --sign -`) — genuinely exercisable without any Apple
// account, and exactly what the script's "no Authority= line -> informational, not a failure"
// branch exists to handle.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/release/verify-macos-signing.sh");
const entitlementsPath = path.join(repoRoot, "build/entitlements.mac.plist");
const skip = process.platform !== "darwin" ? "macOS-only: exercises real `codesign`/`spctl`" : false;

async function makeAppSkeleton(root) {
  const appPath = path.join(root, "dociai.app");
  const macOsDir = path.join(appPath, "Contents", "MacOS");
  await fs.mkdir(macOsDir, { recursive: true });
  await fs.copyFile("/bin/echo", path.join(macOsDir, "dociai"));
  await fs.chmod(path.join(macOsDir, "dociai"), 0o755);
  await fs.writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>dociai</string><key>CFBundleIdentifier</key><string>com.dociai.desktop</string></dict></plist>\n',
  );
  return appPath;
}

function adHocSign(appPath) {
  execFileSync("codesign", ["--sign", "-", "--force", "--entitlements", entitlementsPath, appPath]);
}

function runVerify(appPath) {
  return spawnSync(scriptPath, [appPath], { encoding: "utf8" });
}

test("verify-macos-signing.sh passes an ad-hoc-signed bundle and treats the missing Gatekeeper trust as informational", { skip }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-signing-"));
  try {
    const appPath = await makeAppSkeleton(root);
    adHocSign(appPath);

    // Sanity: codesign itself agrees this is a valid ad-hoc signature before we assert on our script.
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath]);

    const result = runVerify(appPath);
    assert.equal(result.status, 0, `expected PASS, got:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ad-hoc signature.*Gatekeeper.*skipped/s);
    assert.match(result.stdout, /PASS \| verify-macos-signing \|/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify-macos-signing.sh fails a completely unsigned bundle rather than passing vacuously", { skip }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-signing-unsigned-"));
  try {
    const appPath = await makeAppSkeleton(root);
    // Deliberately not signed at all.
    const result = runVerify(appPath);
    assert.notEqual(result.status, 0, "an unsigned bundle must not pass verify-macos-signing.sh");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verify-macos-signing.sh fails when a native binary is added to the bundle after signing (package後にfileを書き換えない工程順)", { skip }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-signing-native-"));
  try {
    const appPath = await makeAppSkeleton(root);
    adHocSign(appPath);

    // Confirmed empirically (see PR description): on this codesign version, a Mach-O file present
    // *before* signing gets auto-signed as part of the bundle's Resources walk even without
    // `--deep` on the sign command itself — so the realistic gap this repo's build ordering must
    // guard against isn't "a nested binary codesign forgot to sign", it's "something added a file
    // to the bundle after codesign already sealed it" (exactly the #73 acceptance criterion
    // "package後にfileを書き換えない工程順を固定"). Simulate a build step doing that.
    const nativeDir = path.join(appPath, "Contents", "Resources", "native");
    await fs.mkdir(nativeDir, { recursive: true });
    await fs.copyFile("/bin/echo", path.join(nativeDir, "helper"));
    await fs.chmod(path.join(nativeDir, "helper"), 0o755);

    const result = runVerify(appPath);
    assert.notEqual(result.status, 0, "a file added to the bundle after signing must fail verification");
    assert.match(result.stdout + result.stderr, /codesign --verify --deep --strict rejected/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
