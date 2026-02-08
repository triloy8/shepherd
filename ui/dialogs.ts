import { ui } from "./dom.js";
import type { ConfirmOptions } from "../core/types.js";

export function syncSystemPromptUI(systemPrompt: string): void {
  if (!systemPrompt) {
    ui.systemPromptButton.hidden = true;
    if (ui.systemPromptDialog.open) {
      ui.systemPromptDialog.close();
    }
    return;
  }

  ui.systemPromptButton.hidden = false;
  ui.systemPromptContent.textContent = systemPrompt;
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const { title, description, confirmLabel = "Confirm", cancelLabel = "Cancel" } = options;
  const dialog = ui.confirmDialog;
  const ok = ui.confirmOkButton;
  const cancel = ui.confirmCancelButton;

  ui.confirmTitle.textContent = title;
  ui.confirmDescription.textContent = description;
  ok.textContent = confirmLabel;
  cancel.textContent = cancelLabel;

  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onClose = () => cleanup(false);

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onClose);

    dialog.showModal();
  });
}
