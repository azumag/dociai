// Issue #95: Channel Points reward selector, backed by the Main-process "Get Custom Rewards" Helix
// call wired in electron/main/services/twitch/custom-rewards-client.ts + twitch-composition.ts, and
// reached over IPC via twitch-ui-client.js's `rewardsList()`.
//
// Two explicit requirements this file exists to satisfy:
//   - "unknown/deleted rewardを設定から消さず警告表示": if the currently-saved `value` (a reward id)
//     is not present in the freshly-fetched reward list (the broadcaster renamed/deleted it on
//     Twitch's side, or the list simply hasn't loaded yet), the select keeps that id SELECTED via a
//     synthetic "⚠ unknown" option — never silently resets/strips the saved reference — with a
//     visible warning badge next to the control.
//   - "reward scope不足・fetch失敗へactionを表示": a `rewardsState.status === "error"` (missing
//     scope / wrong broadcaster / network / rate limited / server / unknown) renders a specific,
//     actionable message (never a silently-empty dropdown) plus a manual reward-id fallback input so
//     a rule can still be authored while the fetch is broken, and a "再取得" retry button.
const ERROR_MESSAGE = {
  missing_scope: "channel:read:redemptions のscopeが不足しています。認可タブで追加認可を行ってください",
  wrong_broadcaster: "配信者本人のTwitchアカウントでの認可が必要です (Get Custom Rewardsは他チャンネルのrewardを取得できません)",
  unauthorized: "認可が無効です。認可タブで再認可してください",
  rate_limited: "Twitch APIのレート制限に達しました。しばらくしてから再試行してください",
  network: "ネットワークエラーでreward一覧を取得できませんでした",
  server: "Twitch側のエラーでreward一覧を取得できませんでした",
  unknown: "reward一覧の取得に失敗しました",
};

/** Human-readable text for a `rewardsState.errorCode` — exported standalone so rule-summary.js /
 * event-rules.js can reuse the exact same wording in a validation-issue list. */
export function describeRewardsError(errorCode) {
  return ERROR_MESSAGE[errorCode] ?? ERROR_MESSAGE.unknown;
}

/** True when `rewardId` was saved on a rule but is absent from the currently-fetched reward list —
 * "unknown/deleted reward" detection, usable standalone (e.g. by rule-summary.js's warning badge)
 * without rendering anything. Always `false` while the list hasn't successfully loaded yet (nothing
 * to compare against, so we cannot yet call it "unknown" — only "not verified"). */
export function isUnknownReward(rewardId, rewardsState) {
  if (!rewardId) return false;
  if (rewardsState?.status !== "loaded") return false;
  return !(rewardsState.rewards ?? []).some((reward) => reward.id === rewardId);
}

/**
 * Renders a single reward `<select>` (for the `eq` operator's value control). `props`:
 *   `{ value, rewardsState, onRefresh, dataPath }` — `rewardsState`:
 *   `{ status: "idle"|"loading"|"loaded"|"error", rewards, errorCode, message }`.
 * `callbacks.onChange(rewardId)` fires on selection; the select itself never resets `value` just
 * because the list doesn't (yet) contain it.
 */
export function renderRewardSelector(root, props = {}, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const { value = "", rewardsState = { status: "idle", rewards: [] }, onRefresh, dataPath } = props;

  const row = document.createElement("div");
  row.className = "reward-selector-row";

  if (rewardsState.status === "error") {
    const errorBox = document.createElement("div");
    errorBox.className = "reward-selector-error";
    const message = document.createElement("span");
    message.className = "reward-selector-error-message";
    message.textContent = describeRewardsError(rewardsState.errorCode);
    errorBox.append(message);
    const fallbackInput = document.createElement("input");
    fallbackInput.type = "text";
    fallbackInput.placeholder = "reward ID を直接入力 (一覧が取得できるようになるまでの代替)";
    fallbackInput.value = value ?? "";
    if (dataPath) fallbackInput.dataset.configPath = dataPath;
    fallbackInput.addEventListener("input", () => callbacks.onChange?.(fallbackInput.value));
    errorBox.append(fallbackInput);
    row.append(errorBox);
  } else {
    const select = document.createElement("select");
    if (dataPath) select.dataset.configPath = dataPath;
    select.disabled = rewardsState.status === "loading";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = rewardsState.status === "loading" ? "reward一覧を取得中…" : "-- rewardを選択 --";
    placeholder.selected = !value;
    select.append(placeholder);
    for (const reward of rewardsState.rewards ?? []) {
      const option = document.createElement("option");
      option.value = reward.id;
      const badges = [!reward.isEnabled ? "無効" : null, reward.isPaused ? "一時停止中" : null].filter(Boolean);
      option.textContent = `${reward.title} (${reward.cost}pt)${badges.length ? ` [${badges.join("/")}]` : ""}`;
      option.selected = reward.id === value;
      select.append(option);
    }
    if (isUnknownReward(value, rewardsState)) {
      const unknownOption = document.createElement("option");
      unknownOption.value = value;
      unknownOption.textContent = `⚠ 不明なreward (ID: ${value}) — 一覧に見つかりません`;
      unknownOption.selected = true;
      select.append(unknownOption);
    } else if (value && rewardsState.status !== "loaded") {
      // Not yet confirmed either way (list still loading/idle) — keep the saved id selectable
      // without a warning badge (nothing to warn about yet).
      const pendingOption = document.createElement("option");
      pendingOption.value = value;
      pendingOption.textContent = `${value} (確認中…)`;
      pendingOption.selected = true;
      select.append(pendingOption);
    }
    select.addEventListener("change", () => callbacks.onChange?.(select.value));
    row.append(select);

    if (isUnknownReward(value, rewardsState)) {
      const badge = document.createElement("span");
      badge.className = "reward-selector-warning-badge";
      badge.textContent = "⚠ 現在の一覧に存在しません (削除/変更された可能性)";
      row.append(badge);
    }
  }

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "btn-ghost reward-selector-refresh";
  refreshButton.textContent = rewardsState.status === "loading" ? "取得中…" : "更新";
  refreshButton.disabled = rewardsState.status === "loading";
  refreshButton.addEventListener("click", () => onRefresh?.());
  row.append(refreshButton);

  root.append(row);
}
