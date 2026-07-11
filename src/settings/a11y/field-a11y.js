export function fieldIds(path) {
  const safe = String(path).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "field";
  return { input: `settings-field-${safe}`, label: `settings-label-${safe}`, error: `settings-error-${safe}` };
}
