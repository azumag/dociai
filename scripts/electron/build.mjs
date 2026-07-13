import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveBuildInfoForRepo, writeBuildInfo } from "../release/build-info.mjs";
import { buildLicenseManifest, writeLicenseManifest } from "../release/license-manifest.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const outDir = path.join(repoRoot, "dist/electron");
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

// node-llama-cpp (#45) is not wired into main/index.ts's import graph yet (that's a later issue),
// but it must stay external the moment it is: node-llama-cpp ships prebuilt native binaries and
// worker scripts it locates via paths relative to its own package directory, so esbuild inlining
// its JS would break that resolution (see node-llama-cpp's own Electron-bundling guidance, and
// electron/main/services/local-llm/native-loader.ts's header comment). Listing it here now is a
// no-op until then and avoids a silent footgun for whoever wires it in.
const bundleOptions = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "node-llama-cpp"], sourcemap: process.env.NODE_ENV === "development", metafile: true };
const mainResult = await build({ ...bundleOptions, entryPoints: [path.join(repoRoot, "electron/main/index.ts")], outfile: path.join(outDir, "main.cjs") });
const preloadResult = await build({ ...bundleOptions, entryPoints: [path.join(repoRoot, "electron/preload/index.ts")], outfile: path.join(outDir, "preload.cjs") });
for (const relativePath of ["index.html", "obs.html", "src", "styles", "config.local.example.json", "resources"]) {
  await fs.cp(path.join(repoRoot, relativePath), path.join(outDir, relativePath), { recursive: true, force: true });
}

// electron-builderの "two package.json" layout (directories.app: dist/electron) 用に、
// devDependency等を含まない最小package.jsonをapp directory直下へ生成する。
const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const appPackage = { name: rootPackage.name, version: rootPackage.version, main: "main.cjs", private: true };
await fs.writeFile(path.join(outDir, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`, "utf8");

// BuildInfoはdev/unpacked実行 (appPath直下) とpackager (build/generated → extraResources) の両方が
// 同じ内容を参照できるよう、ここで一度だけ計算して両方へ書き出す。
const buildInfo = await resolveBuildInfoForRepo(repoRoot);
await writeBuildInfo(path.join(outDir, "build-info.json"), buildInfo);
await writeBuildInfo(path.join(repoRoot, "build/generated/build-info.json"), buildInfo);

// license/resource manifest: 実際にMain/Preload bundleへ含まれたnode_modulesだけを機械的に列挙する。
const licenseManifest = await buildLicenseManifest(repoRoot, [mainResult.metafile, preloadResult.metafile]);
await writeLicenseManifest(path.join(repoRoot, "build/generated/licenses.json"), licenseManifest);

console.log(`Electron build ready: ${outDir} (build-info: ${buildInfo.version}@${buildInfo.gitSha.slice(0, 12)} ${buildInfo.channel}/${buildInfo.platform}/${buildInfo.arch}, licenses: ${licenseManifest.packages.length} package(s))`);
