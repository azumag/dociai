// license/resource manifestの生成 (#72)。esbuildのmetafileから実際にbundleへ含まれた
// node_modules配下のpackageを機械的に列挙し、各package.jsonのlicenseフィールドを引く。
// 手書きの許可listに頼らないため、依存が増減しても追従する。
import fs from "node:fs/promises";
import path from "node:path";

export function packageNameFromModulePath(modulePath) {
  const marker = "node_modules/";
  const idx = modulePath.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = modulePath.slice(idx + marker.length);
  const parts = rest.split("/");
  if (parts.length === 0) return null;
  if (parts[0].startsWith("@") && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

export function collectBundledPackageNames(metafiles) {
  const names = new Set();
  for (const metafile of metafiles) {
    for (const inputPath of Object.keys(metafile?.inputs ?? {})) {
      const name = packageNameFromModulePath(inputPath);
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

export async function resolvePackageLicense(repoRoot, packageName) {
  const packageJsonPath = path.join(repoRoot, "node_modules", packageName, "package.json");
  try {
    const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    const license = typeof raw.license === "string" ? raw.license : (Array.isArray(raw.licenses) && raw.licenses[0]?.type) || "UNKNOWN";
    return { name: packageName, version: typeof raw.version === "string" ? raw.version : "unknown", license };
  } catch {
    return { name: packageName, version: "unknown", license: "UNKNOWN" };
  }
}

// extraPackages (issue #267): onnxruntime-node/onnxruntime-common are esbuild `alias` targets
// (electron/main/native/*-shim.cjs), not literal `require("onnxruntime-node")` bundle inputs, so
// the metafile-based scan above never sees their real package names — yet their binaries are now
// genuinely redistributed via build/native/ -> extraResources. Callers pass those names explicitly
// so they still appear in licenses.json.
export async function buildLicenseManifest(repoRoot, metafiles, now = () => new Date(), extraPackages = []) {
  const names = new Set([...collectBundledPackageNames(metafiles), ...extraPackages]);
  const packages = await Promise.all([...names].sort().map((name) => resolvePackageLicense(repoRoot, name)));
  return { formatVersion: 1, generatedAt: now().toISOString(), packages };
}

export async function writeLicenseManifest(filePath, manifest) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
