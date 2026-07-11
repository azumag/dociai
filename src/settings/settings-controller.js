import { SettingsDirtyTracker } from "./settings-dirty.js";
import { createSettingsState } from "./settings-state.js";
export class SettingsController {
  constructor({ confirmDiscard = async () => "continue", save = async () => {} } = {}) { this.state = createSettingsState(); this.confirmDiscard = confirmDiscard; this.saveHandler = save; this.savePromise = null; }
  open(config) { this.state = { ...createSettingsState(), status: "editing", base: structuredClone(config), draft: structuredClone(config) }; this.dirty = new SettingsDirtyTracker(config); return this.state; }
  changed(draft) { this.state.draft = draft; this.state.dirty = this.dirty.isDirty(draft); return this.state.dirty; }
  async requestClose(reason) { if (!this.state.dirty || reason === "saved") { this.state.status = "closed"; return "closed"; } const choice = await this.confirmDiscard(reason); if (choice === "discard") { this.state.status = "closed"; return "closed"; } if (choice === "save") { await this.save(); return "saved"; } return "continued"; }
  save() { if (this.savePromise) return this.savePromise; this.state.status = "saving"; this.savePromise = Promise.resolve(this.saveHandler(this.state.draft)).then(() => { this.dirty.reset(this.state.draft); this.state.dirty = false; this.state.status = "saved"; }, (error) => { this.state.status = "save-error"; this.state.saveError = error; throw error; }).finally(() => { this.savePromise = null; }); return this.savePromise; }
}
