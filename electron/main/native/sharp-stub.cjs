// sharp-stub.cjs (issue #267)
//
// @huggingface/transformers imports `sharp` at module scope purely for its optional
// image-processing pipeline (dist/transformers.node.cjs: `var import_sharp = __toESM(require("sharp"), 1)`,
// followed by `else if (import_sharp.default) {...} else { throw new Error("Unable to load
// image processing library.") }`). dociai's translation pipeline is text-only and never
// exercises that code path, but transformers.js still throws at *import* time if the value is
// falsy — sharp ships its own platform-specific prebuilt native binary (libvips), which this
// repo deliberately never bundles, for the same reason onnxruntime-node's binary isn't bundled
// via a plain node_modules copy (see scripts/electron/build.mjs).
//
// module.exports must be truthy (any non-nullish value satisfies `import_sharp.default`), so a
// function that only throws if actually called is used — a clear error if this assumption is
// ever wrong, instead of a silent no-op.
module.exports = function sharpStub() {
  throw new Error("sharp is not available in this build — dociai's translation pipeline is text-only and never invokes it");
};
