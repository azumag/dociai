# Native module hook (asar 外への配置)

`electron-builder.yml`の`extraResources`は、packageのたびにこのディレクトリの中身を
`app.asar`の外、`<resources>/native/`へそのままコピーします。これにより:

- native module / shared library / backend は最初から asar 外に置かれる
- runtime pathはcwdやglobal installに依存せず、`process.resourcesPath`基準で解決できる
  (`electron/main/runtime-layout.ts`の`nativeDir`を参照)

## onnxruntime-node (issue #267, 実装済み)

`onnxruntime-node/`配下は `scripts/electron/collect-native.mjs` が `npm run electron:package[:dir]`
のたびに機械的に生成する(gitignore対象・手動編集しない)。electron-builder.ymlが宣言する
全ターゲット (`darwin-arm64`, `darwin-x64`, `win32-x64`) ぶんのディレクトリを必ず作り、
対応するprebuiltバイナリが無いターゲット (現状`darwin-x64`) には `{supported:false, reason}`
のmanifest.jsonだけを置く。`scripts/release/after-pack.mjs`がpackage対象のarchだけを残して
他を刈り込み、`scripts/release/verify-artifact.mjs`が刈り込み後の形を検証する。

```text
build/native/onnxruntime-node/
  darwin-arm64/
    manifest.json                 # {supported:true, files:[...]}
    package/                      # onnxruntime-node本体 (map/d.ts除く) の verbatim subtree
      package.json
      dist/
      bin/napi-v6/darwin/arm64/
      node_modules/onnxruntime-common/   # nested — Nodeの通常解決で見つかる配置
      LICENSE.txt
  darwin-x64/
    manifest.json                 # {supported:false, reason:"..."} — バイナリ本体は無い
  win32-x64/
    manifest.json
    package/...
```

実行時は`electron/main/native/onnxruntime-node-shim.cjs`が(esbuildの`alias`経由で)
`require("onnxruntime-node")`をこの収集結果へ差し替える。dev/unpacked実行時はここに
manifestが無いため、通常のnode_modules解決へフォールバックする。

## node-llama-cpp (#50, 未着手)

`node-llama-cpp`自体は依存パッケージとして既にこのリポジトリに存在し、Main側
(`electron/main/services/local-llm/native-loader.ts`)からも実際にimportされていますが、
#50本体(このディレクトリへのnative artifact配置 + packaged modeでの解決パス切り替え)は
まだ未着手です。packaged buildでは`electron-builder.yml`の`files`除外設定によりnode_modules
全体(node-llama-cppを含む)がasarから除外されるため、今のところLocal LLM機能はpackaged
buildでは「利用不可」として静かにreportされます(native-loader.tsのヘッダコメント参照)。

#50が実装される際は、issue本文で定義された論理layoutに従い、このディレクトリ配下に
`node-llama-cpp/manifest.json`と`node-llama-cpp/<platform>-<arch>/`を配置してください
(onnxruntime-node/の実装が実質的な前例になる)。

```text
build/native/
  node-llama-cpp/
    manifest.json
    <platform>-<arch>/
      addon.node
      libraries/
      backends/
```

`scripts/release/verify-artifact.mjs`は`native/`配下のパスを一般に`node_modules`禁止規則から
除外してはいない — 唯一の例外は`native/onnxruntime-node/<arch>/package/node_modules/
onnxruntime-common/`という狭い1箇所だけで、それ以外(#50の`node-llama-cpp/`含む)は他の
場所と同じ規則が適用される。
