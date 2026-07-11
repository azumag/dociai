import { importConfig } from "./config-import.js";
export function processConfigText(text, source) {
  let result;
  try { result = importConfig(text); }
  catch (error) { return { ok: false, stage: "parse", source, issues: [{ path: [], code: "json.parse", severity: "error", source: "parse", message: error.message, meta: {} }] }; }
  return { ...result, source };
}
