# Configuration

## `config.local.json`

ローカルPoCでは、APIキーやモデル設定を `config.local.json` に置きます。このファイルはGit管理しません。

```json
{
  "connectors": {
    "openai_main": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-4.1-mini"
    }
  }
}
```

## 設定の分離

ペルソナはAPIキーを直接持たず、`connector` を参照します。

```json
{
  "personas": [
    {
      "id": "partner_ai",
      "name": "相棒AI",
      "connector": "openai_main",
      "systemPrompt": "あなたは配信者の相棒AIです。短く自然に返答します。"
    }
  ]
}
```

この形にすると、同じAPIキーで複数ペルソナを動かしたり、ペルソナごとに別モデルを割り当てたりできます。

