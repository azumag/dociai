// onnxruntime-node-shim.cjs (issue #267)
//
// scripts/electron/build.mjs はesbuildの `alias` で "onnxruntime-node" というbare specifierへの
// require/importを、外部packageの代わりにこのファイルへ差し替える (esbuildはこのファイル自体は
// bundleへinlineする — onnxruntime-node本体だけがネイティブbinaryを含むため相変わらずexternal
// 扱いのまま)。@huggingface/transformers内部の `require("onnxruntime-node")` がこのshimへ来る。
//
// packaged buildではnode_modulesがasarから除外されているため (electron-builder.yml)、実体は
// scripts/electron/collect-native.mjsが build/native/onnxruntime-node/ -> <resources>/native/
// (extraResources) 経由で配置したコピーを、process.resourcesPathから探して読み込む。
// dev/unpacked実行 (--dir含む) ではそのnative/ディレクトリ自体が存在しない (packaged build時だけ
// 生成される) ため、app.isPackagedではなくmanifest.jsonの有無で判定する — これによりdev/testの
// 両方で同じ分岐ロジックが素直に動く。
const fs = require("node:fs");
const path = require("node:path");

function packagedManifestPath() {
  if (!process.resourcesPath) return null;
  return path.join(process.resourcesPath, "native", "onnxruntime-node", `${process.platform}-${process.arch}`, "manifest.json");
}

function loadPackaged(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.supported) {
    // manifest.reasonはcollect-native.mjsが収集時に実際に観測した理由文字列 — このshim自体は
    // platform/arch固有の知識を持たない (issue #267 review指摘: 単一の情報源をmanifestに保つ)。
    throw new Error(manifest.reason || `onnxruntime-node has no bundled binary for ${process.platform}-${process.arch}`);
  }
  return require(path.join(path.dirname(manifestPath), "package"));
}

function loadFromNodeModules() {
  // 文字列連結で組み立てることで、esbuildの静的alias解決がこのrequire呼び出し自体を
  // 再び自分自身(このshim)へ差し替えてしまう無限ループを避ける — dev/unpacked実行では
  // このrequireがNodeの通常のnode_modules探索(このファイルがbundleされたdist/electron/から
  // 親directoryを遡る)で本物のonnxruntime-nodeへ解決される (#267 review: 実測で確認済み)。
  const specifier = ["onnxruntime", "node"].join("-");
  return require(specifier);
}

const manifestPath = packagedManifestPath();
module.exports = manifestPath && fs.existsSync(manifestPath) ? loadPackaged(manifestPath) : loadFromNodeModules();
