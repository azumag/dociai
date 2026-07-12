// build/entitlements.mac.plist / .inherit.plist (#73) must be valid plist XML and must carry
// exactly the entitlement keys docs/signing.md documents. This runs cross-platform (the `plist`
// package is pure JS) so it also exercises on the ubuntu-latest "quality" CI job, not only macOS
// — unlike scripts/test/release-setup-macos-keychain.test.mjs and
// release-verify-macos-signing.test.mjs, which need the real `security`/`codesign` tools and are
// macOS-only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import plist from "plist";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readPlist(relativePath) {
  const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  return plist.parse(raw);
}

test("build/entitlements.mac.plist parses as valid plist XML and holds the documented keys", async () => {
  const entitlements = await readPlist("build/entitlements.mac.plist");
  assert.deepEqual(entitlements, {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
    "com.apple.security.network.client": true,
    "com.apple.security.device.audio-input": true,
  });
});

test("build/entitlements.mac.inherit.plist parses as valid plist XML and holds only the three hardened-runtime keys", async () => {
  const entitlements = await readPlist("build/entitlements.mac.inherit.plist");
  assert.deepEqual(entitlements, {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
  assert.equal("com.apple.security.device.audio-input" in entitlements, false, "device entitlements belong on the main app only, not helper processes");
  assert.equal("com.apple.security.network.client" in entitlements, false, "network entitlement belongs on the main app only, not helper processes");
});

test("main entitlements are a strict superset of the inherited helper entitlements", async () => {
  const main = await readPlist("build/entitlements.mac.plist");
  const inherit = await readPlist("build/entitlements.mac.inherit.plist");
  for (const key of Object.keys(inherit)) assert.equal(main[key], inherit[key], `main entitlements missing/mismatched inherited key: ${key}`);
});

test("electron-builder.yml references both entitlements files at their real paths", async () => {
  const yamlText = await fs.readFile(path.join(repoRoot, "electron-builder.yml"), "utf8");
  assert.match(yamlText, /entitlements: build\/entitlements\.mac\.plist/);
  assert.match(yamlText, /entitlementsInherit: build\/entitlements\.mac\.inherit\.plist/);
  for (const relativePath of ["build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist"]) {
    await assert.doesNotReject(() => fs.access(path.join(repoRoot, relativePath)), `${relativePath} referenced by electron-builder.yml must exist`);
  }
});
