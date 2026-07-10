import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "./browser-executable.mjs";
import { ManagedProcess } from "./process-manager.mjs";
import { createTestWorkspace } from "./test-workspace.mjs";
import { waitForHttpReady } from "./wait-for-ready.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const port = Number(process.env.TEST_PORT ?? 18080);
const baseUrl = `http://127.0.0.1:${port}`;
const workspace = await createTestWorkspace(repoRoot);
const browserExecutable = resolveBrowserExecutable();

const server = new ManagedProcess(
  "dociai-server",
  process.env.PYTHON_BIN ?? "python3",
  ["scripts/serve.py", String(port)],
  { cwd: workspace.root },
).start();

let testProcess;
try {
  await waitForHttpReady(`${baseUrl}/`, { timeoutMs: 15_000 });

  testProcess = new ManagedProcess(
    "browser-e2e",
    process.execPath,
    [path.join(repoRoot, "e2e/test.mjs")],
    {
      cwd: repoRoot,
      env: {
        BASE_URL: baseUrl,
        CHROME_BIN: browserExecutable,
        SHOT_DIR: workspace.artifactsDir,
      },
    },
  ).start();

  const result = await testProcess.waitForExit();
  if (result.code !== 0) {
    throw new Error(`Browser E2E failed with code ${result.code ?? "null"}${result.signal ? ` (${result.signal})` : ""}`);
  }

  console.log(`PASS | Browser E2E artifacts: ${workspace.artifactsDir}`);
} catch (error) {
  console.error(error?.stack ?? error);
  console.error("--- server logs ---");
  console.error(server.logs());
  if (testProcess) {
    console.error("--- test logs ---");
    console.error(testProcess.logs());
  }
  if (process.env.KEEP_TEST_WORKSPACE !== "1") {
    console.error(`INFO | Re-run with KEEP_TEST_WORKSPACE=1 to preserve ${workspace.root}`);
  }
  process.exitCode = 1;
} finally {
  await testProcess?.stop();
  await server.stop();
  await workspace.cleanup();
}
