const MINIMAX_SEARCH_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com"]);

export function isMiniMaxSearchConnector(connector) {
  if (!connector || typeof connector !== "object" || Array.isArray(connector)) return false;
  if (connector.provider !== "minimax" && connector.provider !== "openai-compatible") return false;
  const baseUrl = connector.baseUrl ?? (connector.provider === "minimax" ? "https://api.minimax.io/anthropic" : "");
  try {
    const parsed = new URL(String(baseUrl));
    return parsed.protocol === "https:" && MINIMAX_SEARCH_HOSTS.has(parsed.hostname);
  } catch { return false; }
}
