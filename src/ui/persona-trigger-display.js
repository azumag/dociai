// メイン画面のペルソナ表示は、設定エディタのチェックボックスと同じ
// triggers定義順に揃える。config normalize後のpersona.triggersは検索安定性のため
// ソート済みなので、そのまま表示すると設定画面と順序が食い違う。
export function personaTriggerIdsForDisplay(personaTriggerIds = [], triggers = {}) {
  const selected = new Set(personaTriggerIds ?? []);
  const configured = Object.keys(triggers ?? {});
  const configuredSet = new Set(configured);
  return [
    ...configured.filter((id) => selected.has(id)),
    ...(personaTriggerIds ?? []).filter((id) => !configuredSet.has(id)),
  ];
}
