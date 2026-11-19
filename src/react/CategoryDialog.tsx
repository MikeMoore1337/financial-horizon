import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Icon } from './Calendar';

/**
 * Uncontrolled fields preserve the native method="dialog" and the existing delegated
 * submit handler. React owns the form's DOM; domain mutations still belong to app.js.
 */
export function CategoryRenameDialog() {
  return (
    <form method="dialog" id="rename-category-form" className="dialog-body" noValidate>
      <div className="dialog-head">
        <h2 id="category-heading">Переименовать категорию</h2>
        <button className="tool-icon" value="cancel" aria-label="Закрыть">
          <Icon name="close" />
        </button>
      </div>
      <input type="hidden" name="old" />
      <label className="field">
        <span>Новое название</span>
        <input name="newName" maxLength={40} required />
      </label>
      <div className="dialog-actions">
        <button className="button-secondary" value="cancel">
          Отмена
        </button>
        <button className="button-primary" type="submit">
          Сохранить
        </button>
      </div>
    </form>
  );
}

export function createCategoryDialogController(dialog: HTMLDialogElement) {
  const root = createRoot(dialog);
  let disposed = false;
  return {
    render(): void {
      if (disposed) throw new Error('Форма переименования закрыта');
      flushSync(() =>
        root.render(
          <StrictMode>
            <CategoryRenameDialog />
          </StrictMode>,
        ),
      );
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (dialog.open) dialog.close();
      root.unmount();
    },
  };
}
