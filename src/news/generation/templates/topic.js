// topic mode (issue #191): 200〜500字既定、意見可、背景の水増しをしない。
export function buildTopicInstructions(policy) {
  return [
    `${policy.targetChars.min}〜${policy.targetChars.max}字程度で書いてください。`,
    "タイトルと記事本文の要点を、あなたのキャラクターとして視聴者に自然に紹介してください。",
    "短い感想やツッコミは構いませんが、背景情報を水増ししないでください。",
  ].join("\n");
}
