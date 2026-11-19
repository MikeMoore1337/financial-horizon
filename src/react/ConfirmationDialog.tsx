import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

export interface ConfirmationDialogProps {
  title: string;
  description: string;
  onChoose: (confirmed: boolean) => void;
}

/** View-only dialog. Existing action handlers retain ownership of financial mutations. */
export function ConfirmationDialog({ title, description, onChoose }: ConfirmationDialogProps) {
  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <h2 id="confirmation-title">{title}</h2>
      </div>
      <p className="form-note" id="confirmation-text">
        {description}
      </p>
      <div className="dialog-actions">
        <button
          type="button"
          className="button-secondary"
          id="confirm-cancel"
          onClick={() => onChoose(false)}
        >
          Отмена
        </button>
        <button
          type="button"
          className="button-primary danger-button"
          id="confirm-yes"
          onClick={() => onChoose(true)}
        >
          Подтвердить
        </button>
      </div>
    </div>
  );
}

/**
 * Owns only the contents of #confirmation-dialog. Esc/native close always resolve false.
 * The controller is disposable on logout/account revocation before legacy DOM is cleared.
 */
export function createConfirmationDialogController(dialog: HTMLDialogElement) {
  const root = createRoot(dialog);
  let disposed = false;
  let pending: ((result: boolean) => void) | null = null;
  let accepted = false;

  const onClose = () => {
    const settle = pending;
    if (!settle) return;
    pending = null;
    const result = accepted;
    accepted = false;
    flushSync(() => root.render(null));
    settle(result);
  };
  dialog.addEventListener('close', onClose);

  return {
    confirm(title: string, description: string): Promise<boolean> {
      if (disposed || pending || dialog.open) {
        return Promise.reject(new Error('Предыдущее подтверждение ещё не закрыто'));
      }
      return new Promise<boolean>((resolve, reject) => {
        pending = resolve;
        accepted = false;
        try {
          flushSync(() =>
            root.render(
              <StrictMode>
                <ConfirmationDialog
                  title={title}
                  description={description}
                  onChoose={(confirmed) => {
                    accepted = confirmed;
                    if (dialog.open) dialog.close();
                  }}
                />
              </StrictMode>,
            ),
          );
          dialog.showModal();
        } catch (error) {
          pending = null;
          accepted = false;
          flushSync(() => root.render(null));
          reject(error);
        }
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      const settle = pending;
      pending = null;
      accepted = false;
      root.unmount();
      settle?.(false);
    },
  };
}
