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

export async function createTestWorkspace(repoRoot) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-test-"));
  const artifactsDir = path.join(root, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  for (const relativePath of APP_PATHS) {
    const source = path.join(repoRoot, relativePath);
    const destination = path.join(root, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
  }

  await fs.copyFile(
    path.join(root, "config.local.example.json"),
    path.join(root, "config.local.json"),
  );

  return {
    root,
    artifactsDir,
    async cleanup() {
      if (process.env.KEEP_TEST_WORKSPACE === "1") {
        console.log(`INFO | test workspace kept: ${root}`);
        return;
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
