// research stage (issue #187) — headline-onlyニュースの根拠調査。
// Phase 1にはgrounding実装がまだなく (issue #190で追加)、常にnullを返す no-op。
// stage境界だけを先に固定しておき、#190がacquire/select/generateへ触れずにここへ
// 複数ソース調査を差し込めるようにする。

export function createResearchStage() {
  return {
    id: "research",
    async run(_input, _context) {
      return null;
    },
  };
}
