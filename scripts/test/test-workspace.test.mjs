import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestWorkspace } from "./test-workspace.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("test workspace uses the mock fixture and cleans every isolated directory", async () => {
  const workspace = await createTestWorkspace(repoRoot);
  const config = JSON.parse(await fs.readFile(path.join(workspace.root, "config.local.json"), "utf8"));
  assert.equal(config.connectors.mock_main.provider, "mock");
  for (const dir of [workspace.artifactsDir, workspace.userDataDir, workspace.modelsDir, workspace.logsDir]) {
    assert.equal((await fs.stat(dir)).isDirectory(), true);
  }
  const root = workspace.root;
  await workspace.cleanup();
  await assert.rejects(fs.access(root));
});
