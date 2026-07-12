# ADR: Electron packager

## Decision

Use `electron-builder` (via `electron-builder.yml` at the repo root) to package the Electron app, driven by the existing `dist/electron` output from `scripts/electron/build.mjs` through the documented "two package.json" layout (`directories.app: dist/electron`).

## Rationale

`electron-builder` and `electron-forge` were considered. `electron-builder` has first-class, declarative support for exactly the primitives this issue needs — `asar`, `extraResources` (for a native-module hook and out-of-asar `build-info.json`), multi-target/multi-arch (`mac`: arm64+x64, `win`: x64), and per-target `artifactName` templating — without requiring a plugin-based config file (`forge.config.ts`) or additional maker packages per target. The repo already produces a self-contained `dist/electron` directory (Main/Preload bundled by esbuild, static Renderer assets copied, `electron` left external) via `scripts/electron/build.mjs`; electron-builder's two-package.json mode packages that directory directly without pulling root `devDependencies` into the app, keeping the artifact minimal. No prior packager config exists in this repo (`electron-builder`/`electron-forge`/`asar` do not appear anywhere before this change), so there is no migration cost either way — electron-builder is chosen for its maturity and closer fit to the resource-layout and artifact-verification requirements in #72 and #50.
