// persona統合 (issue #191)。personaのsystemPrompt/voiceはそのまま再利用し、ニュース生成
// 専用の新しいpersonaフィールドは発明しない。

export function buildPersonaSystemBlock(persona) {
  const lines = [persona?.systemPrompt ?? ""];
  return lines.filter(Boolean).join("\n").trim();
}
