// AIプロンプト組み立て (issue #6)
// コメント履歴・画面文脈・ニュース文脈を設定に応じて出し分け、1箇所でまとめる。
// build() の戻り値 debugText をUIのデバッグパネルにそのまま表示できる。

const COMMON_RULES = [
  "あなたはライブ配信に出演するAIです。",
  "返答は音声読み上げ前提。話し言葉で2文以内、80文字程度までにする。",
  "絵文字、顔文字、記号の羅列、URLは使わない。",
  "配信者や視聴者を不快にさせる発言はしない。",
].join("\n");

function hhmmss(date) {
  return new Date(date).toTimeString().slice(0, 8);
}

export class ContextBuilder {
  constructor({ commentStore, screenContext = null, config }) {
    this.commentStore = commentStore;
    this.screenContext = screenContext;
    this.config = config;
  }

  // persona: 応答するペルソナ
  // comment: 返答対象のコメント (nullなら「流れへの反応」)
  // includeScreen: "auto" (新鮮なら入れる) | "never"
  // news: ニュース読み上げ時の対象アイテム { title, description }
  // task: comment/news がない場合の依頼文の上書き
  build({ persona, comment = null, includeScreen = "auto", news = null, task = null }) {
    const ctx = this.config.context ?? {};
    const maxChars = ctx.maxPromptChars ?? 4000;

    const system = `${persona.systemPrompt ?? ""}\n\n# 共通ルール\n${COMMON_RULES}`.trim();

    let recentCount = news ? 0 : (ctx.includeRecentComments ?? 20);
    let userContent = this.#compose({ recentCount, includeScreen, news, comment, task });

    // 長すぎる場合はコメント履歴を古い側から削って収める
    while (userContent.length > maxChars && recentCount > 3) {
      recentCount = Math.max(3, Math.floor(recentCount / 2));
      userContent = this.#compose({ recentCount, includeScreen, news, comment, task });
    }
    if (userContent.length > maxChars) {
      userContent = userContent.slice(0, maxChars) + "\n(文脈を切り詰めました)";
    }

    const messages = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    const debugText = `--- system ---\n${system}\n\n--- user ---\n${userContent}`;
    return { messages, debugText };
  }

  #compose({ recentCount, includeScreen, news, comment, task }) {
    const ctx = this.config.context ?? {};
    const parts = [];

    if (this.commentStore.streamSummary) {
      parts.push(`# 配信のこれまでの流れ\n${this.commentStore.streamSummary}`);
    }

    if (recentCount > 0) {
      const recent = this.commentStore.recent(recentCount);
      if (recent.length) {
        const lines = recent.map((c) => `[${hhmmss(c.timestamp)}] ${c.author}: ${c.text}`);
        parts.push(`# 直近のコメント\n${lines.join("\n")}`);
      }
    }

    if (includeScreen !== "never" && this.screenContext) {
      const maxAge = ctx.screenCapture?.maxAgeSeconds ?? 120;
      const fresh = this.screenContext.getFresh(maxAge);
      if (fresh) {
        parts.push(`# 現在の配信画面 (${fresh.ageSeconds}秒前に取得)\n${fresh.summary}`);
      }
    }

    if (news) {
      parts.push(`# 読み上げるニュース\nタイトル: ${news.title}\n概要: ${news.description || "(概要なし)"}`);
    }

    let instruction;
    if (news) {
      const style = this.config.news?.style ?? "配信の合間に自然に読める短いニュース紹介にする";
      instruction = `上のニュースを、あなたのキャラクターとして視聴者に紹介してください。方針: ${style}`;
    } else if (comment) {
      instruction = `次のコメントに、あなたのキャラクターとして返答してください。\n${comment.author}: ${comment.text}`;
    } else {
      instruction = task ?? "最近の配信の流れに、あなたのキャラクターとしてひとこと反応してください。";
    }
    parts.push(`# 依頼\n${instruction}`);

    return parts.join("\n\n");
  }
}
