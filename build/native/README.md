# Native module hook (asar 外への配置)

このディレクトリは #50 (`node-llama-cpp` native binary同梱) のための build-time hook です。
`node-llama-cpp`自体はこのリポジトリにまだ存在しないため、実native artifactは含みません。

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
