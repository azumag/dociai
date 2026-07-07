// AIプロンプト組み立て (issue #6)
// コメント履歴・画面文脈・ニュース文脈を設定に応じて出し分け、1箇所でまとめる。
// build() の戻り値 debugText をUIのデバッグパネルにそのまま表示できる。

const COMMON_RULES = [
  "あなたはライブ配信に出演するAIです。",
  "返答は音声読み上げ前提。話し言葉で2文以内、80文字程度までにする。",
  "絵文字、顔文字、記号の羅列、URLは使わない。",
  "配信者や視聴者を不快にさせる発言はしない。",
].join("\n");

const NEWS_MODE_INSTRUCTIONS = {
  topic: "トピックモード: 現状の配信トピックとして自然に紹介し、配信の流れに接続してください。",
  current: "時事モード: ニュースの背景や意味を一段深く読み解き、あなた自身の短い考察を添えてください。",
  simple: "シンプルモード: 独自の考察や推測は足さず、提示された事実だけを短く伝えてください。",
};

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
  // topic: Todoist 等から拾った話題 { title, description }
  // task: comment/news/topic がない場合の依頼文の上書き
  build({ persona, comment = null, includeScreen = "auto", news = null, topic = null, task = null }) {
    const ctx = this.config.context ?? {};
    const maxChars = ctx.maxPromptChars ?? 4000;

    const system = `${persona.systemPrompt ?? ""}\n\n# 共通ルール\n${COMMON_RULES}`.trim();

    let recentCount = news || topic ? 0 : (ctx.includeRecentComments ?? 20);
    let userContent = this.#compose({ recentCount, includeScreen, news, topic, comment, task });

    // 長すぎる場合はコメント履歴を古い側から削って収める
    while (userContent.length > maxChars && recentCount > 3) {
      recentCount = Math.max(3, Math.floor(recentCount / 2));
      userContent = this.#compose({ recentCount, includeScreen, news, topic, comment, task });
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

  #compose({ recentCount, includeScreen, news, topic, comment, task }) {
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

    const topicItem = topic ?? (news?.kind === "topic" ? news : null);
    const newsItem = topicItem ? null : news;

    if (topicItem) {
      const meta = [
        `話題: ${topicItem.title}`,
        topicItem.description ? `メモ: ${topicItem.description}` : null,
        topicItem.sourceName ? `ソース: ${topicItem.sourceName}` : null,
      ].filter(Boolean);
      parts.push(`# 拾った話題\n${meta.join("\n")}`);
    } else if (newsItem) {
      const meta = [
        `タイトル: ${newsItem.title}`,
        newsItem.sourceName ? `ソース: ${newsItem.sourceName}` : null,
        newsItem.publishedAt ? `日時: ${newsItem.publishedAt}` : null,
        newsItem.link ? `URL: ${newsItem.link}` : null,
        `概要: ${newsItem.description || "(概要なし)"}`,
      ].filter(Boolean);
      parts.push(`# 読み上げるニュース\n${meta.join("\n")}`);
    }

    let instruction;
    if (topicItem) {
      const intro = this.config.topics?.intro ?? "上のお題について、あなたのキャラクターとして自由にコメントしてください。";
      const style = this.config.topics?.style ?? "雑談のお題として、自然な自分の言葉で自由にコメントする";
      instruction = [intro, `方針: ${style}`].join("\n");
    } else if (newsItem) {
      const mode = this.config.news?.mode ?? "topic";
      const modeInstruction = NEWS_MODE_INSTRUCTIONS[mode] ?? NEWS_MODE_INSTRUCTIONS.topic;
      const style = this.config.news?.style ?? "配信の合間に自然に読める短いニュース紹介にする";
      instruction = [
        "上のニュースを、あなたのキャラクターとして視聴者に紹介してください。",
        modeInstruction,
        `方針: ${style}`,
      ].join("\n");
    } else if (comment) {
      instruction = `次のコメントに、あなたのキャラクターとして返答してください。\n${comment.author}: ${comment.text}`;
    } else {
      instruction = task ?? "最近の配信の流れに、あなたのキャラクターとしてひとこと反応してください。";
    }
    parts.push(`# 依頼\n${instruction}`);

    return parts.join("\n\n");
  }
}
