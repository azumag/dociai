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

// node-llama-cpp (#45) is wired into the Local LLM service's import graph
// (electron/main/services/local-llm/native-loader.ts's single dynamic `import("node-llama-cpp")`)
// and must stay external: it ships prebuilt native binaries and worker scripts it locates via
// paths relative to its own package directory, so esbuild inlining its JS would break that
// resolution (see node-llama-cpp's own Electron-bundling guidance). Note this doesn't currently
// make it *work* in a packaged build either way — see native-loader.ts's header comment and #50 —
// only that esbuild must never silently inline it once it's imported at all.
//
// onnxruntime-node (issue #257 Phase 2, translation-runtime.ts's `@huggingface/transformers`
// pipeline) was the exact same situation until issue #267: it ships a platform/arch-specific
// prebuilt `onnxruntime_binding.node` it locates relative to its own package directory. Rather
// than leaving it external+broken like node-llama-cpp, #267 aliases the bare "onnxruntime-node"
// specifier to electron/main/native/onnxruntime-node-shim.cjs (bundled/inlined like any other
// first-party file) — the shim redirects to collect-native.mjs's packaged-build copy under
// extraResources, or falls back to a real node_modules lookup in dev. `sharp` is
// `@huggingface/transformers`' optional image-processing dependency (unused by the text-only
// translation pipeline here) and ships prebuilt binaries the same way; it's aliased to
// electron/main/native/sharp-stub.cjs instead, since dociai never needs a working sharp, only a
// truthy import (see that file's header comment for why). `@huggingface/transformers` itself IS
// bundled (pure JS, no native binary of its own).
const NATIVE_DIR = path.join(repoRoot, "electron/main/native");
const bundleOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "node-llama-cpp"],
  alias: {
    "onnxruntime-node": path.join(NATIVE_DIR, "onnxruntime-node-shim.cjs"),
    sharp: path.join(NATIVE_DIR, "sharp-stub.cjs"),
  },
  sourcemap: process.env.NODE_ENV === "development",
  metafile: true,
};
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
// onnxruntime-node/onnxruntime-common (issue #267) はaliasされておりmetafileに現れないため
// 明示的に追加する — 実体はcollect-native.mjsがbuild/native/ -> extraResources経由で同梱する。
const licenseManifest = await buildLicenseManifest(repoRoot, [mainResult.metafile, preloadResult.metafile], () => new Date(), ["onnxruntime-node", "onnxruntime-common"]);
await writeLicenseManifest(path.join(repoRoot, "build/generated/licenses.json"), licenseManifest);

console.log(`Electron build ready: ${outDir} (build-info: ${buildInfo.version}@${buildInfo.gitSha.slice(0, 12)} ${buildInfo.channel}/${buildInfo.platform}/${buildInfo.arch}, licenses: ${licenseManifest.packages.length} package(s))`);
