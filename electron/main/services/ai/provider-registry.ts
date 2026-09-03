import { ServiceError } from "../service-error";

const baseUrls: Record<string, string> = { openai: "https://api.openai.com/v1", openrouter: "https://openrouter.ai/api/v1", ollama: "http://localhost:11434/v1", minimax: "https://api.minimax.io/anthropic" };
const providers = new Set(["openai", "openrouter", "openai-compatible", "ollama", "minimax", "mock"]);

function isOpenCodeGoBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname === "opencode.ai" && /^\/zen\/go(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isOpenCodeProxyBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) && parsed.port === "8787";
  } catch {
    return false;
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
}

export function providerConfig(id: string, connector: Record<string, unknown>, apiKey: string | null) {
  const provider = String(connector.provider ?? "openai").trim();
  const model = String(connector.model ?? "").trim();
  if (!providers.has(provider)) throw new ServiceError("BAD_REQUEST", "connector provider is unsupported", { serviceId: id, retryable: false });
  if (!model && provider !== "mock") throw new ServiceError("BAD_REQUEST", "connector model is missing", { serviceId: id, retryable: false });
  if (!apiKey && !["mock", "ollama"].includes(provider)) throw new ServiceError("AUTH", "connector secret is not configured", { serviceId: id, retryable: false });
  const configuredBaseUrl = connector.baseUrl === undefined ? (baseUrls[provider] ?? baseUrls.openai) : String(connector.baseUrl).trim();
  if (provider !== "mock") {
    try {
      const parsed = new URL(configuredBaseUrl);
      if (!parsed.protocol.startsWith("http")) throw new Error("unsupported protocol");
    } catch {
      throw new ServiceError("BAD_REQUEST", "connector base URL is invalid", { serviceId: id, retryable: false });
    }
  }
  return {
    id,
    provider,
    model,
    baseUrl: configuredBaseUrl,
    apiKey: apiKey ?? undefined,
    retries: boundedInteger(connector.retries, 1, 0, 3),
    timeoutMs: boundedInteger(connector.timeoutMs, 30000, 1000, 120000),
    maxTokens: boundedInteger(connector.maxTokens, 2048, 1, 32768),
    // The bundled proxy has a fixed default port. Custom proxy endpoints can opt in
    // explicitly without sending the vendor-specific header to unrelated gateways.
    opencodeSession: connector.opencodeSession === true || isOpenCodeGoBaseUrl(configuredBaseUrl) || isOpenCodeProxyBaseUrl(configuredBaseUrl),
  };
}
