// current mode (issue #191): 800〜1600字既定、背景・複数視点・今後の論点・考察を含める。
export function buildCurrentInstructions(policy) {
  return [
    `${policy.targetChars.min}〜${policy.targetChars.max}字程度で書いてください。`,
    "何が起きたか、背景、複数の見方、今後の論点、あなた自身の短い考察を含めてください。",
    "事実・推測・あなたの意見を言葉遣いで区別してください。",
    "調査結果にある具体的な日付・数値・固有名詞を活用してください。",
    "単なる冷笑や見出しの言い換えだけで終わらせないでください。",
  ].join("\n");
}
