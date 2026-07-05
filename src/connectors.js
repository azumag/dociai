// AIコネクタ抽象化 (issue #3)
// ペルソナはconnector IDだけを参照し、プロバイダ差分はこのモジュールに閉じ込める。
// インターフェース:
//   connector.chat(messages, { maxTokens?, temperature? }) -> Promise<{ text, usage }>
//   connector.describe() -> { id, provider, model, apiKeyMasked }

import { maskApiKey } from "./security.js";

const BASE_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  minimax: "https://api.minimax.io/anthropic",
};

export class ConnectorError extends Error {
  constructor(message, { kind = "unknown", retryAfter = null } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.kind = kind; // "auth" | "rate_limit" | "timeout" | "network" | "server" | "empty" | "bad_request"
    this.retryAfter = retryAfter;
  }
}

export function createConnector(id, cfg) {
  if (cfg.provider === "mock") return new MockConnector(id, cfg);
  if (cfg.provider === "minimax") return new MiniMaxConnector(id, cfg);
  return new OpenAICompatibleConnector(id, cfg);
}

function dataUrlToAnthropicSource(url) {
  const match = String(url ?? "").match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) throw new ConnectorError("画像URLはdata URL形式である必要があります", { kind: "bad_request" });
  return { type: "base64", media_type: match[1], data: match[2] };
}

function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  return content.map((part) => {
    if (part?.type === "text") return { type: "text", text: String(part.text ?? "") };
    if (part?.type === "image_url") {
      return { type: "image", source: dataUrlToAnthropicSource(part.image_url?.url) };
    }
    return { type: "text", text: String(part?.text ?? "") };
  });
}

function toAnthropicMessages(messages) {
  const out = [];
  let system = "";
  for (const msg of messages) {
    if (msg.role === "system") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      system = system ? `${system}\n\n${content}` : content;
      continue;
    }
    out.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: toAnthropicContent(msg.content),
    });
  }
  return { system, messages: out };
}

// OpenAI Chat Completions互換。openai / openrouter / ollama / baseUrl指定のローカルLLMをカバーする。
class OpenAICompatibleConnector {
  // APIキーはprivateフィールドに閉じ、describe()やJSON化で漏れないようにする
  #apiKey;

  constructor(id, cfg) {
    this.id = id;
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? BASE_URLS[cfg.provider] ?? BASE_URLS.openai).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this.#apiKey = cfg.apiKey ?? "";
  }

  describe() {
    const apiKeyMasked = this.provider === "ollama" ? "(不要)" : maskApiKey(this.#apiKey);
    return { id: this.id, provider: this.provider, model: this.model, apiKeyMasked };
  }

  #headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.#apiKey) headers["Authorization"] = `Bearer ${this.#apiKey}`;
    if (this.provider === "openrouter") {
      headers["HTTP-Referer"] = location.origin;
      headers["X-Title"] = "dociai";
    }
    return headers;
  }

  async chat(messages, { maxTokens = 300, temperature } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          ...(temperature != null ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new ConnectorError(`${this.id}: ${Math.round(this.timeoutMs / 1000)}秒でタイムアウトしました`, { kind: "timeout" });
      }
      throw new ConnectorError(`${this.id}: 接続できません (${e.message})`, { kind: "network" });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw await this.#httpError(res);

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) throw new ConnectorError(`${this.id}: 応答が空でした`, { kind: "empty" });
    return { text, usage: data.usage ?? null };
  }

  async #httpError(res) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message ?? "";
    } catch {
      // 本文がJSONでない場合は詳細なし
    }
    detail = detail ? ` — ${String(detail).slice(0, 200)}` : "";
    if (res.status === 401 || res.status === 403) {
      return new ConnectorError(`${this.id}: APIキーが無効か権限がありません (HTTP ${res.status})${detail}`, { kind: "auth" });
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || null;
      const hint = retryAfter ? `${retryAfter}秒後に再試行してください` : "しばらく待って再試行してください";
      return new ConnectorError(`${this.id}: レート制限中です。${hint}${detail}`, { kind: "rate_limit", retryAfter });
    }
    if (res.status >= 500) {
      return new ConnectorError(`${this.id}: プロバイダ側エラー (HTTP ${res.status})${detail}`, { kind: "server" });
    }
    return new ConnectorError(`${this.id}: リクエストエラー (HTTP ${res.status})${detail}`, { kind: "bad_request" });
  }
}

class MiniMaxConnector {
  #apiKey;

  constructor(id, cfg) {
    this.id = id;
    this.provider = "minimax";
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? BASE_URLS.minimax).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this.#apiKey = cfg.apiKey ?? "";
  }

  describe() {
    return { id: this.id, provider: this.provider, model: this.model, apiKeyMasked: maskApiKey(this.#apiKey) };
  }

  async chat(messages, { maxTokens = 300, temperature } = {}) {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          messages: anthropicMessages,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          ...(temperature != null ? { temperature } : {}),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new ConnectorError(`${this.id}: ${Math.round(this.timeoutMs / 1000)}秒でタイムアウトしました`, { kind: "timeout" });
      }
      throw new ConnectorError(`${this.id}: 接続できません (${e.message})`, { kind: "network" });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw await this.#httpError(res);

    const data = await res.json();
    const text = (data.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (!text) throw new ConnectorError(`${this.id}: 応答が空でした`, { kind: "empty" });
    return { text, usage: data.usage ?? null };
  }

  async #httpError(res) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message ?? body?.base_resp?.status_msg ?? body?.message ?? "";
    } catch {
      // 本文がJSONでない場合は詳細なし
    }
    detail = detail ? ` — ${String(detail).slice(0, 200)}` : "";
    if (res.status === 401 || res.status === 403) {
      return new ConnectorError(`${this.id}: MiniMax APIキーが無効か権限がありません (HTTP ${res.status})${detail}`, { kind: "auth" });
    }
    if (res.status === 429) {
      return new ConnectorError(`${this.id}: MiniMaxのレート制限中です${detail}`, { kind: "rate_limit" });
    }
    if (res.status >= 500) {
      return new ConnectorError(`${this.id}: MiniMax側エラー (HTTP ${res.status})${detail}`, { kind: "server" });
    }
    return new ConnectorError(`${this.id}: MiniMaxリクエストエラー (HTTP ${res.status})${detail}`, { kind: "bad_request" });
  }
}

// APIキーなしで動作確認するためのモック (issue #3 受け入れ条件)
const MOCK_REPLIES = [
  "なるほど、それは面白い流れですね。",
  "ふふ、そのコメントは拾わざるを得ません。",
  "いい質問です。配信的にはおいしい展開ですね。",
  "はいはい、ツッコミどころ満載ですね。",
];

class MockConnector {
  #i = 0;

  constructor(id, cfg) {
    this.id = id;
    this.provider = "mock";
    this.model = cfg.model ?? "mock-1";
    this.delayMs = cfg.delayMs ?? 400;
  }

  describe() {
    return { id: this.id, provider: this.provider, model: this.model, apiKeyMasked: "(不要)" };
  }

  async chat(messages) {
    await new Promise((r) => setTimeout(r, this.delayMs));
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (Array.isArray(last?.content) && last.content.some((p) => p.type === "image_url")) {
      return { text: "モック画面認識: エディタらしき画面が映っています。コードを書いている様子です。", usage: null };
    }
    const content = typeof last?.content === "string" ? last.content : "";
    if (content.includes("ニュース")) {
      return { text: "モックニュースです。本日、ローカルPoCが無事に動いたそうです。開発は次の段階へ進みます。", usage: null };
    }
    const line = MOCK_REPLIES[this.#i++ % MOCK_REPLIES.length];
    return { text: `${line}(モック応答)`, usage: null };
  }
}
