export class SpeechBackend {
  constructor(id, capabilities = {}) {
    this.id = id;
    this.capabilities = Object.freeze({
      reportsPlaybackCompletion: true,
      supportsCancel: true,
      supportsClear: false,
      supportsPrepare: false,
      ...capabilities,
    });
  }
  available() { return true; }
  async prepare() { return null; }
  async play() { throw new Error(`${this.id}.play is not implemented`); }
  cancel() {}
  async clear() { throw new Error(`${this.id} does not support clear`); }
  dispose() { this.cancel(); }
}

export const speechResult = (state, details = {}) => Object.freeze({ state, ...details });
