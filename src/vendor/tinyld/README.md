# tinyld (vendored)

- Source: https://github.com/komodojp/tinyld
- Package: `tinyld@1.3.4`
- File: `dist/tinyld.normal.browser.js` (copied verbatim, unmodified)
- License: MIT (see `LICENSE` in this directory)

## Why vendored instead of an npm dependency

`src/` is served to the renderer as raw ES modules with no bundler (`scripts/serve.py` is a
plain static file server, and `index.html` loads `src/app/boot.js` directly via
`<script type="module">`) — there is no import-map or build step that could resolve a bare
`"tinyld"` specifier from `node_modules` at runtime. `electron-builder.yml` also explicitly
excludes `node_modules/**` from the packaged app (see its own comment: "Root devDependencies
never enter the asar"), so nothing under `node_modules` is available at runtime in a packaged
build either.

`tinyld`'s "normal" browser build is a single self-contained ESM file with zero runtime
dependencies (confirmed: no `import`/`require` calls, no `window`/`document`/`navigator`
references), so it runs identically under plain Node (used by `scripts/test/*.test.mjs` via
`node --test`) and in the browser/Electron renderer. Vendoring one copy here and importing it
via a relative path from `src/comment-language-detector.js` keeps a single source of truth for
both environments instead of risking drift between an `npm`-installed copy and a separately
vendored one.

## Updating

To pick up a new tinyld release, replace `tinyld.normal.browser.js` with the new version's
`dist/tinyld.normal.browser.js` and update the version noted above. Re-run the language-detector
accuracy check recorded in issue #259 before shipping a version bump, since tinyld's internal
scoring behavior (see `src/comment-language-detector.js`'s own comment on confidence semantics)
is not guaranteed stable across releases.
