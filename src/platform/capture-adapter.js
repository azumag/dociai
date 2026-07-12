// Electronではdesktopキャプチャ対象の列挙・選択もpreloadが公開したIPCを通す (issue #117)。
// Browser版はgetDisplayMediaのピッカーに任せるため、この対象選択UIごと非表示になる。
export function hasElectronCaptureService() { return typeof globalThis.dociai?.capture?.listSources === "function"; }
export async function listCaptureSources() { return globalThis.dociai.capture.listSources(); }
export async function selectCaptureSource(input) { return globalThis.dociai.capture.selectSource(input); }
