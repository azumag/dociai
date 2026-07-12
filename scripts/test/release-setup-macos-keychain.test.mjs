// scripts/release/setup-macos-keychain.sh (#73) — macOS-only: exercises the real `security`
// keychain toolchain (create-keychain/import/delete-keychain), which only exists on darwin. Skips
// cleanly everywhere else (this repo's `test:unit` also runs on ubuntu-latest — see
// .github/workflows/ci.yml's `quality` job).
//
// This does NOT use a real Apple Developer ID certificate (none exists in this sandbox — see
// docs/signing.md). It generates a throwaway self-signed certificate with openssl purely to
// exercise create/import/cleanup end to end, which is genuinely observable without any Apple
// account.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/release/setup-macos-keychain.sh");
const skip = process.platform !== "darwin" ? "macOS-only: exercises the real `security` keychain toolchain" : false;

function run(args, env) {
  return spawnSync(scriptPath, args, { cwd: repoRoot, env, encoding: "utf8" });
}

function baseEnv(overrides) {
  // Inherit PATH/HOME/etc so `security`/`openssl`/`base64` resolve, but never inherit any real
  // signing secrets that might happen to be set in this shell.
  const { MACOS_CERTIFICATE_P12_BASE64, MACOS_CERTIFICATE_PASSWORD, MACOS_KEYCHAIN_PASSWORD, ...clean } = process.env;
  return { ...clean, ...overrides };
}

async function generateSelfSignedP12(dir) {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  const p12Path = path.join(dir, "test-cert.p12");
  const password = "dociai-test-p12-password";
  const commonName = "dociai signing test cert (not a real Apple certificate)";
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-nodes", "-subj", `/CN=${commonName}`, "-addext", "extendedKeyUsage=codeSigning",
  ]);
  execFileSync("openssl", ["pkcs12", "-export", "-out", p12Path, "-inkey", keyPath, "-in", certPath, "-passout", `pass:${password}`, "-legacy"]).toString();
  const base64 = (await fs.readFile(p12Path)).toString("base64");
  return { base64, password, commonName };
}

test("setup-macos-keychain.sh setup prints SKIP and exits 0 when no certificate secrets are present (fork PR fallback)", { skip }, async () => {
  const stateFile = path.join(os.tmpdir(), `dociai-keychain-state-skip-${process.pid}`);
  try {
    const result = run(["setup"], baseEnv({ DOCIAI_KEYCHAIN_STATE_FILE: stateFile }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SKIP \| setup-macos-keychain \|/m);
    assert.equal(fsSync.existsSync(stateFile), false, "no state file should be written when setup is skipped");
  } finally {
    await fs.rm(stateFile, { force: true });
  }
});

test("setup-macos-keychain.sh cleanup is a safe no-op when setup was never run", { skip }, () => {
  const stateFile = path.join(os.tmpdir(), `dociai-keychain-state-noop-${process.pid}`);
  assert.equal(fsSync.existsSync(stateFile), false);
  const result = run(["cleanup"], baseEnv({ DOCIAI_KEYCHAIN_STATE_FILE: stateFile }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^SKIP \| setup-macos-keychain \|/m);
});

test("setup-macos-keychain.sh rejects an unknown subcommand", { skip }, () => {
  const result = run(["bogus"], baseEnv({}));
  assert.notEqual(result.status, 0);
});

test("setup-macos-keychain.sh setup/cleanup genuinely create and destroy a temporary keychain with the imported identity", { skip }, async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-keychain-live-"));
  const stateFile = path.join(workDir, "state");
  const originalSearchList = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  let keychainPath;

  t.after(async () => {
    // Best-effort: if the test failed before its own cleanup ran, make sure the sandbox's real
    // keychain search list and any leftover temp keychain are not left modified.
    if (keychainPath && fsSync.existsSync(keychainPath)) {
      run(["cleanup"], baseEnv({ DOCIAI_KEYCHAIN_STATE_FILE: stateFile }));
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  const { base64, password, commonName } = await generateSelfSignedP12(workDir);

  const setupResult = run(["setup"], baseEnv({
    DOCIAI_KEYCHAIN_STATE_FILE: stateFile,
    MACOS_CERTIFICATE_P12_BASE64: base64,
    MACOS_CERTIFICATE_PASSWORD: password,
  }));
  assert.equal(setupResult.status, 0, `setup failed:\n${setupResult.stdout}\n${setupResult.stderr}`);
  assert.match(setupResult.stdout, /^PASS \| setup-macos-keychain \| temporary keychain created/m);
  assert.equal(fsSync.existsSync(stateFile), true, "setup must write a state file for cleanup to consume");

  keychainPath = (await fs.readFile(stateFile, "utf8")).trim();
  assert.equal(fsSync.existsSync(keychainPath), true, "the temporary keychain file must exist on disk after setup");

  // `security find-identity -v` filters to identities that pass full X.509 trust-chain
  // validation, which a throwaway self-signed cert can never satisfy (it has no trusted root) —
  // that's a property of the certificate, not of this script, and is exactly why a *real* Apple-
  // issued Developer ID certificate (which does chain to a trusted root already present in
  // macOS's System Roots by default) is required for the real signing path; see docs/signing.md.
  // `find-certificate` reports on keychain *contents* directly, independent of trust evaluation,
  // which is the right tool to confirm setup-macos-keychain.sh actually imported the certificate.
  const certLookup = spawnSync("security", ["find-certificate", "-c", commonName, keychainPath], { encoding: "utf8" });
  assert.equal(certLookup.status, 0, `imported certificate not found in the temporary keychain:\n${certLookup.stdout}\n${certLookup.stderr}`);
  assert.match(certLookup.stdout, /"labl"<blob>=/, "find-certificate should report the certificate's label attribute");

  const searchListAfterSetup = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  assert.match(searchListAfterSetup, new RegExp(keychainPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the temporary keychain must be on the user's keychain search list so CSC_IDENTITY_AUTO_DISCOVERY finds it");

  const cleanupResult = run(["cleanup"], baseEnv({ DOCIAI_KEYCHAIN_STATE_FILE: stateFile }));
  assert.equal(cleanupResult.status, 0, `cleanup failed:\n${cleanupResult.stdout}\n${cleanupResult.stderr}`);
  assert.match(cleanupResult.stdout, /^PASS \| setup-macos-keychain \| temporary keychain removed/m);

  assert.equal(fsSync.existsSync(keychainPath), false, "the temporary keychain file must be gone after cleanup");
  assert.equal(fsSync.existsSync(stateFile), false, "the state file must be removed after cleanup");

  const searchListAfterCleanup = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
  assert.equal(searchListAfterCleanup, originalSearchList, "the keychain search list must be restored to exactly what it was before setup ran");
  keychainPath = undefined; // cleanup already succeeded; skip the t.after() safety net
});
