// dev/unpacked/packaged path解決 (#72)。electron/main/runtime-layout.tsは"生きているElectron
// process"の app.isPackaged / app.getAppPath() を入力に取るが、こちらはビルドtooling向けに、
// リポジトリ内の既知の出力directoryだけからpure(fs不要)に期待pathを計算する。
// print-runtime-layout.mjs / verify-artifact.mjs / smoke-packaged.mjs が共通で使う。
import path from "node:path";

export const SUPPORTED_TARGETS = [
  { platform: "darwin", arch: "arm64", os: "mac", dirName: "mac-arm64" },
  { platform: "darwin", arch: "x64", os: "mac", dirName: "mac" },
  { platform: "win32", arch: "x64", os: "win", dirName: "win-unpacked" },
];

export function targetFor(platform, arch) {
  const target = SUPPORTED_TARGETS.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!target) throw new Error(`Unsupported package target: ${platform}/${arch}. Supported: ${SUPPORTED_TARGETS.map((t) => `${t.platform}/${t.arch}`).join(", ")}`);
  return target;
}

export function resolveDevLayout(repoRoot) {
  const appDir = path.join(repoRoot, "dist/electron");
  return {
    mode: "dev",
    appDir,
    resourcesDir: null,
    asarPath: null,
    buildInfoFile: path.join(appDir, "build-info.json"),
    licensesFile: null,
    nativeDir: null,
    executable: null,
  };
}

// electron-builder --dir と 最終installer後のapp layoutは構造として同一 (どちらもapp.isPackaged
// === true の実行体)。"unpacked"/"packaged" はどちらもこの関数へ落ちる。
export function resolvePackagedLayout({ repoRoot, platform = process.platform, arch = process.arch, outputRoot, productName = "dociai", executableName = "dociai" }) {
  const target = targetFor(platform, arch);
  const root = outputRoot ?? path.join(repoRoot, "dist/release");
  if (platform === "darwin") {
    const appBundle = path.join(root, target.dirName, `${productName}.app`);
    const resourcesDir = path.join(appBundle, "Contents", "Resources");
    return {
      mode: "packaged",
      appDir: appBundle,
      resourcesDir,
      asarPath: path.join(resourcesDir, "app.asar"),
      buildInfoFile: path.join(resourcesDir, "build-info.json"),
      licensesFile: path.join(resourcesDir, "licenses.json"),
      nativeDir: path.join(resourcesDir, "native"),
      executable: path.join(appBundle, "Contents", "MacOS", executableName),
    };
  }
  if (platform === "win32") {
    const appDir = path.join(root, target.dirName);
    const resourcesDir = path.join(appDir, "resources");
    return {
      mode: "packaged",
      appDir,
      resourcesDir,
      asarPath: path.join(resourcesDir, "app.asar"),
      buildInfoFile: path.join(resourcesDir, "build-info.json"),
      licensesFile: path.join(resourcesDir, "licenses.json"),
      nativeDir: path.join(resourcesDir, "native"),
      executable: path.join(appDir, `${executableName}.exe`),
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export function resolveLayout({ mode, repoRoot, platform = process.platform, arch = process.arch, outputRoot, productName, executableName }) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (mode === "dev") return resolveDevLayout(repoRoot);
  if (mode === "unpacked" || mode === "packaged") return resolvePackagedLayout({ repoRoot, platform, arch, outputRoot, productName, executableName });
  throw new Error(`Unknown mode: ${mode}. Expected "dev", "unpacked", or "packaged".`);
}
