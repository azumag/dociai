// RendererはElectron APIを直接参照せず、この小さなadapterだけを通す。
export function getElectronPlatform(api = globalThis.dociai) {
  if (!api?.platform?.getInfo) return null;
  return api.platform;
}
