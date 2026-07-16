// generate stage (issue #187) — ContextBuilder+AIConnectorによる読み上げ文生成。
// Phase 1では legacy adapter の generate() (prompt build + connector.chat + 空文字/出力上限
// 検査) をそのまま呼ぶ。issue #191 がニュース専用prompt/prepass/構造化出力へ差し替える。

export function createGenerateStage({ adapter }) {
  return {
    id: "generate",
    async run({ item, persona, connector, research, requestId }, context) {
      return adapter.generate({ item, persona, connector, research, requestId, context });
    },
  };
}
