import { canonicalizeConfig } from "../config/config-canonicalize.js";
export const createSecretOperation = (op = "keep", value) => Object.freeze(op === "set" ? { op, value } : { op });
export class SettingsDirtyTracker {
  constructor(base) { this.reset(base); }
  reset(base) { this.baseCanonical = canonicalizeConfig(base); this.secretOperations = new Map(); }
  isDirty(draft) { return canonicalizeConfig(draft) !== this.baseCanonical || [...this.secretOperations.values()].some((entry) => entry.op !== "keep"); }
  setSecret(path, operation) { this.secretOperations.set(path, operation); }
}
