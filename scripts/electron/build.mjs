import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const outDir = path.join(repoRoot, "dist/electron");
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const bundleOptions = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: process.env.NODE_ENV === "development" };
await build({ ...bundleOptions, entryPoints: [path.join(repoRoot, "electron/main/index.ts")], outfile: path.join(outDir, "main.cjs") });
await build({ ...bundleOptions, entryPoints: [path.join(repoRoot, "electron/preload/index.ts")], outfile: path.join(outDir, "preload.cjs") });
for (const relativePath of ["index.html", "obs.html", "src", "styles", "config.local.example.json"]) {
  await fs.cp(path.join(repoRoot, relativePath), path.join(outDir, relativePath), { recursive: true, force: true });
}
console.log(`Electron build ready: ${outDir}`);
