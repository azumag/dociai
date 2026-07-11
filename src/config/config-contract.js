export const CURRENT_SCHEMA_VERSION = 2;

export const issue = (path, code, message, { severity = "error", source = "schema", meta = {} } = {}) =>
  Object.freeze({ path: Object.freeze(Array.isArray(path) ? [...path] : String(path).split(".").filter(Boolean)), code, message, severity, source, meta: Object.freeze({ ...meta }) });

export const successResult = (config, issues = []) => Object.freeze({ ok: true, stage: "complete", config, issues: Object.freeze([...issues]) });
export const failureResult = (stage, issues, input = null) => Object.freeze({ ok: false, stage, input, issues: Object.freeze([...issues]) });
