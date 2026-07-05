import assert from "node:assert/strict";
import { validateConfig, applyDefaults } from "../src/config-loader.js";
import { createConnector } from "../src/connectors.js";

const config = {
  connectors: {
    ollama_local: {
      provider: "ollama",
      model: "llama3.2",
    },
  },
  personas: [
    {
      id: "local_ai",
      name: "ローカルAI",
      connector: "ollama_local",
      systemPrompt: "ローカルモデルで短く返します。",
    },
  ],
  triggers: {
    manual_local: { type: "manual" },
  },
  context: {
    screenCapture: {
      enabled: true,
      connector: "ollama_local",
    },
  },
};

const validation = validateConfig(config);
assert.deepEqual(validation.errors, []);
assert.deepEqual(validation.warnings, []);

const applied = applyDefaults(config);
const connector = createConnector("ollama_local", applied.connectors.ollama_local);
assert.deepEqual(connector.describe(), {
  id: "ollama_local",
  provider: "ollama",
  model: "llama3.2",
  apiKeyMasked: "(不要)",
});

let request;
globalThis.fetch = async (url, init) => {
  request = { url, init };
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "ローカル応答です。" } }],
      usage: { total_tokens: 3 },
    }),
  };
};

const result = await connector.chat([{ role: "user", content: "こんにちは" }], { maxTokens: 64 });
assert.equal(result.text, "ローカル応答です。");
assert.equal(request.url, "http://localhost:11434/v1/chat/completions");
assert.equal(request.init.headers.Authorization, undefined);

const body = JSON.parse(request.init.body);
assert.equal(body.model, "llama3.2");
assert.equal(body.max_tokens, 64);

const invalid = validateConfig({
  ...config,
  connectors: {
    broken: {
      provider: "ollama",
    },
  },
  personas: [{ ...config.personas[0], connector: "broken" }],
});
assert.ok(invalid.errors.some((e) => e.includes("connectors.broken.model")));

console.log("PASS | ollama provider config and connector");
