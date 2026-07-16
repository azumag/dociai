// AIコネクタ抽象化 (issue #3)
// ペルソナはconnector IDだけを参照し、プロバイダ差分はこのモジュールに閉じ込める。
// インターフェース:
//   connector.chat(messages, { maxTokens?, temperature?, stream?, onToken? })
//     -> Promise<{ text, usage, finishReason? }>
//   connector.describe() -> { id, provider, model, apiKeyMasked }

import { maskApiKey } from "./security.js";
import { cancelElectronAiRequest, chatThroughElectron, hasElectronAiService, searchThroughElectron } from "./platform/electron-services.js";

const BASE_URLS = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  minimax: "https://api.minimax.io/anthropic",
};

const DEFAULT_MAX_TOKENS = 2048;
const MAX_MAX_TOKENS = 32768;

function boundedMaxTokens(value, fallback = DEFAULT_MAX_TOKENS) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_MAX_TOKENS, Math.floor(parsed))) : fallback;
}

// 秒未満のtimeoutMsをそのまま切り捨てると「0秒でタイムアウトしました」という
// 誤解を招く表示になる (例: ミリ秒のつもりで秒の値を入力した設定ミス)。
function formatTimeout(ms) {
  return ms < 1000 ? `${ms}ミリ秒` : `${Math.round(ms / 1000)}秒`;
}

export class ConnectorError extends Error {
  constructor(message, { kind = "unknown", retryAfter = null } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.kind = kind; // "auth" | "rate_limit" | "timeout" | "network" | "server" | "empty" | "bad_request"
    this.retryAfter = retryAfter;
  }
}

function cancelledError(id) { return new ConnectorError(`${id}: リクエストはキャンセルされました`, { kind: "cancelled" }); }

function requestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parent?.reason ?? new DOMException("Aborted", "AbortError"));
  if (parent?.aborted) abortParent();
  else parent?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
  return { signal: controller.signal, wasCancelled: () => Boolean(parent?.aborted), dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", abortParent); } };
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readSseChatResponse(response, { id, signal, onToken = () => {}, extract }) {
  if (!response.body) throw new ConnectorError(`${id}: ストリーム応答が空でした`, { kind: "empty" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  let usage = null;
  let finishReason = null;
  const processLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    const update = extract(event);
    if (typeof update.token === "string" && update.token) {
      text += update.token;
      onToken(update.token);
    }
    if (update.usage !== undefined) usage = update.usage;
    if (typeof update.finishReason === "string" && update.finishReason) finishReason = update.finishReason;
  };
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) processLine(line);
      if (done) {
        if (pending) processLine(pending);
        break;
      }
    }
  } finally { reader.releaseLock(); }
  const trimmed = text.trim();
  if (!trimmed) throw new ConnectorError(`${id}: 応答が空でした`, { kind: "empty" });
  return { text: trimmed, usage, ...(finishReason ? { finishReason } : {}) };
}

function readOpenAiStream(response, options) {
  return readSseChatResponse(response, {
    ...options,
    extract: (event) => ({
      token: event.choices?.[0]?.delta?.content,
      finishReason: event.choices?.[0]?.finish_reason,
      usage: event.usage,
    }),
  });
}

function readMiniMaxStream(response, options) {
  return readSseChatResponse(response, {
    ...options,
    extract: (event) => ({
      token: event.delta?.text ?? event.content_block?.text,
      finishReason: event.delta?.stop_reason,
      usage: event.usage,
    }),
  });
}

const SERVICE_ERROR_KINDS = {
  AUTH: "auth",
  RATE_LIMIT: "rate_limit",
  TIMEOUT: "timeout",
  NETWORK: "network",
  SERVER: "server",
  EMPTY: "empty",
  BAD_REQUEST: "bad_request",
  CANCELLED: "cancelled",
};

class ElectronMainConnector {
  #sequence = 0;

  constructor(id, cfg) {
    this.id = id;
    this.provider = cfg.provider;
    this.model = cfg.model ?? (cfg.provider === "mock" ? "mock-1" : "");
  }

  describe() {
    return { id: this.id, provider: this.provider, model: this.model, apiKeyMasked: this.provider === "mock" || this.provider === "ollama" ? "(不要)" : "(Main processで管理)" };
  }

  async chat(messages, opts = {}) {
    const requestId = opts.requestId ?? `renderer-${Date.now()}-${++this.#sequence}`;
    if (opts.signal?.aborted) throw cancelledError(this.id);
    const response = chatThroughElectron({
      connectorId: this.id,
      messages,
      requestId,
      ownerId: "console",
      options: {
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.stream === true ? { stream: true } : {}),
      },
    });
    const result = await new Promise((resolve, reject) => {
      const cancel = () => { void cancelElectronAiRequest(requestId); reject(cancelledError(this.id)); };
      opts.signal?.addEventListener("abort", cancel, { once: true });
      response.then(resolve, reject).finally(() => opts.signal?.removeEventListener("abort", cancel));
    });
    if (result?.ok) return result.value;
    const error = result?.error ?? { code: "UNKNOWN", message: "Main processから応答を取得できませんでした" };
    throw new ConnectorError(`${this.id}: ${error.message}`, {
      kind: SERVICE_ERROR_KINDS[error.code] ?? "unknown",
      retryAfter: Number.isFinite(error.retryAfterMs) ? Math.ceil(error.retryAfterMs / 1000) : null,
    });
  }

  async search(query, opts = {}) {
    const requestId = opts.requestId ?? `renderer-search-${Date.now()}-${++this.#sequence}`;
    if (opts.signal?.aborted) throw cancelledError(this.id);
    // Renderer AppRuntimeとMain AiServiceのgenerationは別系統。chat()と同様にMainへは
    // generationを送らず、Renderer側のAbortSignal/runtime.guard()でstale結果を破棄する。
    const response = searchThroughElectron({ connectorId: this.id, query, requestId, ownerId: "console" });
    const result = await new Promise((resolve, reject) => {
      const cancel = () => { void cancelElectronAiRequest(requestId); reject(cancelledError(this.id)); };
      opts.signal?.addEventListener("abort", cancel, { once: true });
      response.then(resolve, reject).finally(() => opts.signal?.removeEventListener("abort", cancel));
    });
    if (result?.ok) return result.value;
    const error = result?.error ?? { code: "UNKNOWN", message: "Main processから検索結果を取得できませんでした" };
    throw new ConnectorError(`${this.id}: ${error.message}`, { kind: SERVICE_ERROR_KINDS[error.code] ?? "unknown" });
  }

  async cancel(requestId) {
    const result = await cancelElectronAiRequest(requestId);
    return Boolean(result?.ok && result.value.cancelled);
  }
}

export function createConnector(id, cfg, { log = () => {} } = {}) {
  if (hasElectronAiService()) return new ElectronMainConnector(id, cfg);
  if (cfg.provider === "mock") return new MockConnector(id, cfg);
  if (cfg.provider === "minimax") return new MiniMaxConnector(id, cfg, { log });
  return new OpenAICompatibleConnector(id, cfg, { log });
}

// タイムアウトのみ即座に再試行する (issue #31)。認証/レート制限/不正リクエストは
// リトライしても結果が変わらないため対象外。cfg.retries が試行回数の上乗せ分。
async function chatWithRetry(id, retries, log, chatOnce, ...args) {
  const maxAttempts = 1 + (Number(retries) > 0 ? Number(retries) : 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chatOnce(...args);
    } catch (e) {
      if (e.kind !== "timeout" || attempt === maxAttempts) throw e;
      log(`${id}: タイムアウトのため再試行します (${attempt}/${maxAttempts - 1})`);
    }
  }
}

const MINIMAX_SEARCH_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com"]);

function miniMaxSearchUrl(baseUrl, id) {
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new ConnectorError(`${id}: MiniMax base URLが不正です`, { kind: "bad_request" }); }
  if (parsed.protocol !== "https:" || !MINIMAX_SEARCH_HOSTS.has(parsed.hostname)) throw new ConnectorError(`${id}: Web検索には公式MiniMax API hostを指定してください`, { kind: "bad_request" });
  return new URL("/v1/coding_plan/search", parsed.origin).toString();
}

async function miniMaxSearch(id, baseUrl, apiKey, timeoutMs, query, { signal: parentSignal } = {}) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery || normalizedQuery.length > 500) throw new ConnectorError(`${id}: 検索queryが不正です`, { kind: "bad_request" });
  const request = requestSignal(parentSignal, timeoutMs);
  let res;
  try {
    res = await fetch(miniMaxSearchUrl(baseUrl, id), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "MM-API-Source": "dociai" },
      body: JSON.stringify({ q: normalizedQuery }),
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted && request.wasCancelled()) throw cancelledError(id);
    if (error.name === "AbortError" || request.signal.aborted) throw new ConnectorError(`${id}: ${formatTimeout(timeoutMs)}でタイムアウトしました`, { kind: "timeout" });
    throw new ConnectorError(`${id}: MiniMax検索に接続できません (${error.message})`, { kind: "network" });
  } finally { request.dispose(); }
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : "bad_request";
    throw new ConnectorError(`${id}: MiniMax検索エラー (HTTP ${res.status})`, { kind });
  }
  const data = await res.json();
  if (data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) {
    throw new ConnectorError(`${id}: MiniMax検索エラー (${data.base_resp.status_code})`, { kind: data.base_resp.status_code === 1004 ? "auth" : "bad_request" });
  }
  const results = (Array.isArray(data?.organic) ? data.organic : []).flatMap((entry) => {
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    const link = typeof entry?.link === "string" ? entry.link.trim() : "";
    if (!title || !/^https?:\/\//i.test(link)) return [];
    return [{ title: title.slice(0, 300), link: link.slice(0, 2048), snippet: String(entry.snippet ?? "").trim().slice(0, 2000), ...(typeof entry.date === "string" && entry.date.trim() ? { date: entry.date.trim().slice(0, 100) } : {}) }];
  }).slice(0, 20);
  const relatedQueries = (Array.isArray(data?.related_searches) ? data.related_searches : []).map((entry) => String(entry?.query ?? "").trim()).filter(Boolean).slice(0, 10);
  return { results, relatedQueries };
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

  constructor(id, cfg, { log = () => {} } = {}) {
    this.id = id;
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? BASE_URLS[cfg.provider] ?? BASE_URLS.openai).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this.maxTokens = boundedMaxTokens(cfg.maxTokens);
    this.retries = cfg.retries ?? 1;
    this.log = log;
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

  async chat(messages, opts = {}) {
    return chatWithRetry(this.id, this.retries, this.log, (...args) => this.#chatOnce(...args), messages, opts);
  }

  async search(query, opts = {}) { return miniMaxSearch(this.id, this.baseUrl, this.#apiKey, this.timeoutMs, query, opts); }

  async #chatOnce(messages, { maxTokens, temperature, stream = false, onToken, signal: parentSignal } = {}) {
    const request = requestSignal(parentSignal, this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: boundedMaxTokens(maxTokens, this.maxTokens),
          // dociaiは内部思考を表示・読み上げない。OllamaのOpenAI互換APIでは
          // thinkingモデルに最終回答用の予算を残すため、reasoningを明示的に無効化する。
          ...(this.provider === "ollama" ? { reasoning_effort: "none" } : {}),
          ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
          ...(temperature != null ? { temperature } : {}),
        }),
        signal: request.signal,
      });
    } catch (e) {
      request.dispose();
      if (request.signal.aborted && request.wasCancelled()) throw cancelledError(this.id);
      if (e.name === "AbortError" || request.signal.aborted) {
        throw new ConnectorError(`${this.id}: ${formatTimeout(this.timeoutMs)}でタイムアウトしました`, { kind: "timeout" });
      }
      throw new ConnectorError(`${this.id}: 接続できません (${e.message})`, { kind: "network" });
    }
    try {
      if (!res.ok) throw await this.#httpError(res);
      if (stream) return await readOpenAiStream(res, { id: this.id, signal: request.signal, onToken });
      const data = await res.json();
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content.trim() : "";
      if (!text) throw new ConnectorError(`${this.id}: 応答が空でした`, { kind: "empty" });
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
      return { text, usage: data.usage ?? null, ...(finishReason ? { finishReason } : {}) };
    } catch (error) {
      if (request.signal.aborted && request.wasCancelled()) throw cancelledError(this.id);
      if (request.signal.aborted) throw new ConnectorError(`${this.id}: ${formatTimeout(this.timeoutMs)}でタイムアウトしました`, { kind: "timeout" });
      throw error;
    } finally { request.dispose(); }
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

  constructor(id, cfg, { log = () => {} } = {}) {
    this.id = id;
    this.provider = "minimax";
    this.model = cfg.model;
    this.baseUrl = (cfg.baseUrl ?? BASE_URLS.minimax).replace(/\/$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30000;
    this.maxTokens = boundedMaxTokens(cfg.maxTokens);
    this.retries = cfg.retries ?? 1;
    this.log = log;
    this.#apiKey = cfg.apiKey ?? "";
  }

  describe() {
    return { id: this.id, provider: this.provider, model: this.model, apiKeyMasked: maskApiKey(this.#apiKey) };
  }

  async chat(messages, opts = {}) {
    return chatWithRetry(this.id, this.retries, this.log, (...args) => this.#chatOnce(...args), messages, opts);
  }

  async search(query, opts = {}) { return miniMaxSearch(this.id, this.baseUrl, this.#apiKey, this.timeoutMs, query, opts); }

  async #chatOnce(messages, { maxTokens, temperature, stream = false, onToken, signal: parentSignal } = {}) {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const request = requestSignal(parentSignal, this.timeoutMs);
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
          max_tokens: boundedMaxTokens(maxTokens, this.maxTokens),
          ...(stream ? { stream: true } : {}),
          ...(system ? { system } : {}),
          ...(temperature != null ? { temperature } : {}),
        }),
        signal: request.signal,
      });
    } catch (e) {
      request.dispose();
      if (request.signal.aborted && request.wasCancelled()) throw cancelledError(this.id);
      if (e.name === "AbortError" || request.signal.aborted) {
        throw new ConnectorError(`${this.id}: ${formatTimeout(this.timeoutMs)}でタイムアウトしました`, { kind: "timeout" });
      }
      throw new ConnectorError(`${this.id}: 接続できません (${e.message})`, { kind: "network" });
    }
    try {
      if (!res.ok) throw await this.#httpError(res);
      if (stream) return await readMiniMaxStream(res, { id: this.id, signal: request.signal, onToken });
      const data = await res.json();
      const text = (data.content ?? [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (!text) throw new ConnectorError(`${this.id}: 応答が空でした`, { kind: "empty" });
      const finishReason = typeof data.stop_reason === "string" ? data.stop_reason : null;
      return { text, usage: data.usage ?? null, ...(finishReason ? { finishReason } : {}) };
    } catch (error) {
      if (request.signal.aborted && request.wasCancelled()) throw cancelledError(this.id);
      if (request.signal.aborted) throw new ConnectorError(`${this.id}: ${formatTimeout(this.timeoutMs)}でタイムアウトしました`, { kind: "timeout" });
      throw error;
    } finally { request.dispose(); }
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

  async chat(messages, { signal } = {}) {
    try { await abortableDelay(this.delayMs, signal); } catch { throw cancelledError(this.id); }
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
