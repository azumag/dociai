import type { AiMessage } from "../../../../shared/services/ai-contract";

const replies = ["なるほど、それは面白い流れですね。", "ふふ、そのコメントは拾わざるを得ません。", "いい質問です。配信的にはおいしい展開ですね。", "はいはい、ツッコミどころ満載ですね。"];
let index = 0;
export async function mockChat(messages: AiMessage[], options: { stream: boolean; onToken(text: string): void }): Promise<{ text: string; usage: null }> {
  const last = [...messages].reverse().find((message) => message.role === "user");
  const text = Array.isArray(last?.content) && last.content.some((part) => part?.type === "image_url")
    ? "モック画面認識: エディタらしき画面が映っています。コードを書いている様子です。"
    : typeof last?.content === "string" && last.content.includes("ニュース")
      ? "モックニュースです。本日、ローカルPoCが無事に動いたそうです。開発は次の段階へ進みます。"
      : `${replies[index++ % replies.length]}(モック応答)`;
  if (options.stream) options.onToken(text);
  return { text, usage: null };
}
