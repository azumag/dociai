# Native module hook (asar 外への配置)

このディレクトリは #50 (`node-llama-cpp` native binary同梱) のための build-time hook です。
`node-llama-cpp`自体は依存パッケージとして既にこのリポジトリに存在し、Main側
(`electron/main/services/local-llm/native-loader.ts`)からも実際にimportされていますが、
#50本体(このディレクトリへのnative artifact配置 + packaged modeでの解決パス切り替え)は
まだ未着手のため、このディレクトリ自体は依然として空です。packaged buildでは
`electron-builder.yml`の`files`除外設定によりnode_modules全体(node-llama-cppを含む)が
asarから除外されるため、今のところLocal LLM機能はpackaged buildでは「利用不可」として
静かにreportされます(native-loader.tsのヘッダコメント参照)。

`electron-builder.yml`の`extraResources`は、packageのたびにこのディレクトリの中身を
`app.asar`の外、`<resources>/native/`へそのままコピーします。これにより:

- native module / shared library / backend は最初から asar 外に置かれる
- runtime pathはcwdやglobal installに依存せず、`process.resourcesPath`基準で解決できる
  (`electron/main/runtime-layout.ts`の`nativeDir`を参照)

#50が実装される際は、issue本文で定義された論理layoutに従い、このディレクトリ配下に
`node-llama-cpp/manifest.json`と`node-llama-cpp/<platform>-<arch>/`を配置してください。

```text
build/native/
  node-llama-cpp/
    manifest.json
    <platform>-<arch>/
      addon.node
      libraries/
      backends/
```

`scripts/release/verify-artifact.mjs`は`native/`配下のファイルを禁止patternの対象外として扱います
(native binaryは意図した同梱物であり、混入secretとは区別されます)。
