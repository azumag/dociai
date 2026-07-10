import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_PATHS = [
  "index.html",
  "obs.html",
  "src",
  "styles",
  "scripts/serve.py",
  "config.local.example.json",
];
const WORKSPACE_PREFIX = "dociai-test-";

function assertDisposableWorkspace(root) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  if (!resolved.startsWith(`${temporaryRoot}${path.sep}`) || !path.basename(resolved).startsWith(WORKSPACE_PREFIX)) {
    throw new Error(`Refusing to clean a non-test workspace: ${resolved}`);
  }
}

export async function createTestWorkspace(repoRoot, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  const artifactsDir = path.join(root, "artifacts");
  const userDataDir = path.join(root, "user-data");
  const modelsDir = path.join(root, "models");
  const logsDir = path.join(root, "logs");
  await Promise.all([artifactsDir, userDataDir, modelsDir, logsDir].map((dir) => fs.mkdir(dir, { recursive: true })));

  for (const relativePath of APP_PATHS) {
    const source = path.join(repoRoot, relativePath);
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
  }

  const configFixture = options.configFixture
    ?? path.join(repoRoot, "e2e", "fixtures", "config.mock.json");
  await fs.copyFile(configFixture, path.join(root, "config.local.json"));

  return {
    root,
    artifactsDir,
    userDataDir,
    modelsDir,
    logsDir,
    async cleanup() {
      if (process.env.KEEP_TEST_WORKSPACE === "1") {
        console.log(`INFO | test workspace kept: ${root}`);
        return;
      }
      assertDisposableWorkspace(root);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
