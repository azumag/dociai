import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import {
  classifyRelativePath,
  scanRelativePaths,
  hasModelsOrUserDataDir,
  verifyArtifactTree,
  resolveResourcesDir,
} from "../release/verify-artifact.mjs";

test("classifyRelativePath flags known-forbidden files by exact name and pattern", () => {
  assert.equal(classifyRelativePath("config.local.json").forbidden, true);
  assert.equal(classifyRelativePath(".env").forbidden, true);
  assert.equal(classifyRelativePath(".env.production").forbidden, true);
  assert.equal(classifyRelativePath("secrets.enc.json").forbidden, true);
  assert.equal(classifyRelativePath("models/llama-7b.gguf").forbidden, true);
  assert.equal(classifyRelativePath("main.cjs.map").forbidden, true);
  assert.equal(classifyRelativePath("assets/id_rsa").forbidden, true);
  assert.equal(classifyRelativePath("nested/.git/HEAD").forbidden, true);
  assert.equal(classifyRelativePath("app.asar/node_modules/foo/index.js").forbidden, true);
});

test("classifyRelativePath does not flag legitimate shipped files", () => {
  assert.equal(classifyRelativePath("config.local.example.json").forbidden, false, "example template must not be flagged");
  assert.equal(classifyRelativePath("build-info.json").forbidden, false);
  assert.equal(classifyRelativePath("licenses.json").forbidden, false);
  assert.equal(classifyRelativePath("app.asar/main.cjs").forbidden, false);
  assert.equal(classifyRelativePath("app.asar/index.html").forbidden, false);
  assert.equal(classifyRelativePath("native/node-llama-cpp/manifest.json").forbidden, false);
});

test("scanRelativePaths aggregates only the forbidden entries with reasons", () => {
  const violations = scanRelativePaths(["build-info.json", ".env", "app.asar/index.html", "secrets.enc.json.bak"]);
  assert.deepEqual(violations.map((v) => v.path).sort(), [".env", "secrets.enc.json.bak"]);
  for (const violation of violations) assert.equal(typeof violation.reason, "string");
});

test("hasModelsOrUserDataDir detects a models/ or userData/ directory anywhere in the tree", () => {
  assert.equal(hasModelsOrUserDataDir(["app.asar/main.cjs", "build-info.json"]), false);
  assert.equal(hasModelsOrUserDataDir(["models/llama.gguf"]), true);
  assert.equal(hasModelsOrUserDataDir(["userData/config.json"]), true);
});

async function makeFixtureResources(tmpRoot, { extraResourceFiles = {}, asarFiles = {} } = {}) {
  const resourcesDir = path.join(tmpRoot, "Contents", "Resources");
  const asarSource = path.join(tmpRoot, "asar-src");
  await fs.mkdir(resourcesDir, { recursive: true });
  await fs.mkdir(asarSource, { recursive: true });
  for (const [relativePath, contents] of Object.entries(asarFiles)) {
    const file = path.join(asarSource, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  await createPackage(asarSource, path.join(resourcesDir, "app.asar"));
  for (const [relativePath, contents] of Object.entries(extraResourceFiles)) {
    const file = path.join(resourcesDir, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  return resourcesDir;
}

test("verifyArtifactTree passes a clean packaged fixture", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-clean-"));
  try {
    const resourcesDir = await makeFixtureResources(tmpRoot, {
      extraResourceFiles: { "build-info.json": "{}", "licenses.json": "{}" },
      asarFiles: { "main.cjs": "console.log('main')", "index.html": "<html></html>", "config.local.example.json": "{}" },
    });
    const result = await verifyArtifactTree(resourcesDir);
    assert.deepEqual(result.violations, []);
    assert.equal(result.hasAsar, true);
    assert.equal(result.hasBuildInfo, true);
    assert.equal(result.hasLicenses, true);
    assert.equal(result.hasModelsOrUserDataDir, false);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("verifyArtifactTree flags a fixture containing forbidden files inside and outside the asar", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-dirty-"));
  try {
    const resourcesDir = await makeFixtureResources(tmpRoot, {
      extraResourceFiles: { "build-info.json": "{}", "licenses.json": "{}", ".env": "SECRET=1", "models/local.bin": "binary" },
      asarFiles: { "main.cjs": "console.log('main')", "config.local.json": "{\"connectors\":{}}" },
    });
    const result = await verifyArtifactTree(resourcesDir);
    const violationPaths = result.violations.map((v) => v.path).sort();
    assert.deepEqual(violationPaths, [".env", "app.asar/config.local.json"], "models/local.bin is flagged separately via hasModelsOrUserDataDir, not the forbidden-file scan");
    assert.equal(result.hasModelsOrUserDataDir, true, "models/ directory must be detected");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveResourcesDir finds Contents/Resources from a mac .app root and from its parent directory", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-verify-resolve-"));
  try {
    const appBundle = path.join(tmpRoot, "dociai.app");
    const resourcesDir = await makeFixtureResources(appBundle, { extraResourceFiles: { "build-info.json": "{}" } });
    assert.equal(await resolveResourcesDir(appBundle), resourcesDir);
    assert.equal(await resolveResourcesDir(tmpRoot), resourcesDir, "should discover the .app bundle inside the given root");
    assert.equal(await resolveResourcesDir(resourcesDir), resourcesDir, "should be a no-op when already pointed at Resources");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
