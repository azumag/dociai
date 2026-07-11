// 棒読みちゃん HTTP 連携 (issue #30)
// 標準の HTTP リスナー (既定 127.0.0.1:50080) の /Talk に読み上げを投入する。
// Electron 版では preload が公開する限定 API を優先し、ブラウザ版では直接 fetch する。

export class BouyomiError extends Error {
  constructor(message, kind = "unknown") {
    super(message);
    this.name = "BouyomiError";
    this.kind = kind;
  }
}

const finiteOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export class BouyomiClient {
  constructor({ baseUrl = "http://127.0.0.1:50080", timeoutMs = 5000, bridge = null, defaults = {} } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.timeoutMs = finiteOr(timeoutMs, 5000);
    this.bridge = bridge ?? globalThis.window?.dociai?.bouyomi ?? globalThis.window?.dociai?.speech?.bouyomi ?? null;
    this.defaults = defaults;
  }

  async talk(text, options = {}) {
    const request = {
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      text: String(text),
      voice: finiteOr(options.voice, finiteOr(this.defaults.voice, 0)),
      volume: finiteOr(options.volume, finiteOr(this.defaults.volume, -1)),
      speed: finiteOr(options.speed ?? options.rate, finiteOr(this.defaults.speed, -1)),
      tone: finiteOr(options.tone, finiteOr(this.defaults.tone, -1)),
      signal: options.signal ?? null,
    };
    if (!request.text.trim()) return { ok: true };
    if (this.bridge?.talk) {
      const { signal, ...bridgeRequest } = request;
      if (signal?.aborted) throw new BouyomiError("棒読みちゃん送信はキャンセルされました", "cancelled");
      const result = await this.bridge.talk(bridgeRequest);
      const value = result?.ok === true ? result.value : result;
      if (result?.ok === false || value?.ok === false) throw new BouyomiError(result?.error?.message || value?.error || "棒読みちゃんへの送信に失敗しました", result?.error?.code || value?.kind);
      return value;
    }
    return this.#request("Talk", request, request.signal);
  }

  async clear() {
    if (this.bridge?.clear) {
      const result = await this.bridge.clear({ baseUrl: this.baseUrl, timeoutMs: this.timeoutMs });
      const value = result?.ok === true ? result.value : result;
      if (result?.ok === false || value?.ok === false) throw new BouyomiError(result?.error?.message || value?.error || "棒読みちゃんのキュー消去に失敗しました", result?.error?.code || value?.kind);
      return value;
    }
    return this.#request("Clear", {});
  }

  async #request(command, params, parentSignal = null) {
    const url = new URL(`${this.baseUrl}/${command}`);
    for (const [key, value] of Object.entries(params)) {
      if (["baseUrl", "timeoutMs", "signal"].includes(key)) continue;
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const abortParent = () => controller.abort(parentSignal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (parentSignal?.aborted) abortParent();
    else parentSignal?.addEventListener("abort", abortParent, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), this.timeoutMs);
    let response;
    try {
      response = await fetch(url, { method: "GET", signal: controller.signal });
    } catch (error) {
      if (parentSignal?.aborted) throw new BouyomiError("棒読みちゃん送信はキャンセルされました", "cancelled");
      if (error.name === "AbortError" || controller.signal.aborted) throw new BouyomiError(`棒読みちゃんが${this.timeoutMs}ms以内に応答しませんでした`, "timeout");
      throw new BouyomiError(`棒読みちゃんに接続できません (${error.message})`, "network");
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    }
    if (!response.ok) {
      throw new BouyomiError(`棒読みちゃんがエラーを返しました (HTTP ${response.status})`, response.status >= 500 ? "server" : "bad_request");
    }
    return { ok: true };
  }
}
