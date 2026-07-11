export function hasElectronCaptureService() { return typeof globalThis.dociai?.capture?.listSources === "function"; }
export async function listCaptureSources() { return globalThis.dociai.capture.listSources(); }
export async function selectCaptureSource(input) { return globalThis.dociai.capture.selectSource(input); }
