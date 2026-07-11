const secretPattern = /(?:api[-_]?key|token|secret|password|authorization|cookie)$/i;
export const isSecretConfigKey = (key) => secretPattern.test(key);
const sanitize = (value) => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !isSecretConfigKey(key)).map((key) => [key, sanitize(value[key])]));
};
export const CANONICAL_FORMAT_VERSION = 1;
export function canonicalizeConfig(config) { return JSON.stringify(sanitize(config)); }
export function canonicalConfigHash(config) {
  const text = `v${CANONICAL_FORMAT_VERSION}:${canonicalizeConfig(config)}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
