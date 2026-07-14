export function showDiscardChangesDialog(document, { canSave = true } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog"); dialog.className = "discard-changes-dialog"; dialog.setAttribute("aria-labelledby", "discard-changes-title");
    const title = document.createElement("h2"); title.id = "discard-changes-title"; title.textContent = "未保存の変更があります";
    const detail = document.createElement("p"); detail.textContent = "変更を保存して適用するか、破棄するか選択してください。";
    const actions = document.createElement("div"); actions.className = "settings-actions";
    const finish = (choice) => { dialog.close(); dialog.remove(); resolve(choice); };
    const continued = document.createElement("button"); continued.type = "button"; continued.className = "btn-ghost"; continued.textContent = "編集を続ける"; continued.autofocus = true; continued.onclick = () => finish("continue");
    const discard = document.createElement("button"); discard.type = "button"; discard.className = "btn-ghost"; discard.textContent = "変更を破棄"; discard.onclick = () => finish("discard");
    const save = document.createElement("button"); save.type = "button"; save.className = "btn-primary"; save.textContent = "保存して適用"; save.disabled = !canSave; save.onclick = () => finish("save");
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish("continue"); });
    actions.append(continued, discard, save); dialog.append(title, detail, actions); document.body.append(dialog); dialog.showModal(); continued.focus();
  });
}
