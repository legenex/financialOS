import { el } from '../lib/dom';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

/** A modal confirmation built on <dialog>. Resolves true only when the confirm button is used. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = el('button', {
      class: 'button button--secondary',
      text: options.cancel ?? 'Cancel',
      attrs: { type: 'button', value: 'cancel', 'data-action': 'dialog-cancel' },
    });
    const confirm = el('button', {
      class: `button ${options.danger ? 'button--danger-solid' : 'button--primary'}`,
      text: options.confirm,
      attrs: { type: 'button', value: 'confirm', 'data-action': 'dialog-confirm' },
    });
    const dialog = el(
      'dialog',
      { class: 'dialog', attrs: { 'aria-labelledby': 'dialog-title', 'aria-describedby': 'dialog-body' } },
      [
        el('h2', { class: 'dialog-title', text: options.title, attrs: { id: 'dialog-title' } }),
        el('p', { class: 'dialog-body', text: options.body, attrs: { id: 'dialog-body' } }),
        el('div', { class: 'dialog-actions' }, [cancel, confirm]),
      ],
    );
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
