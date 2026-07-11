const PERMANENT_NOTICE_IDS = new Set(["msg_banned", "msg_channel_suspended", "msg_bad_channel", "msg_channel_blocked"]);

export function classifyNotice(event) {
  const messageId = event?.messageId ?? "unknown";
  return {
    code: messageId,
    message: event?.message || "Twitch channel notice",
    permanent: PERMANENT_NOTICE_IDS.has(messageId),
    retryable: !PERMANENT_NOTICE_IDS.has(messageId),
  };
}
