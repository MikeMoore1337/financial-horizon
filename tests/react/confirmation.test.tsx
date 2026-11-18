import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { createConfirmationDialogController } from '../../src/react/ConfirmationDialog';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function createDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = 'confirmation-dialog';
  dialog.setAttribute('aria-labelledby', 'confirmation-title');
  document.body.append(dialog);
  let isOpen = false;
  Object.defineProperty(dialog, 'open', { get: () => isOpen, configurable: true });
  dialog.showModal = vi.fn(() => {
    if (isOpen) throw new Error('Already open');
    isOpen = true;
  });
  dialog.close = vi.fn(() => {
    isOpen = false;
    dialog.dispatchEvent(new Event('close'));
  });
  return dialog;
}

describe('React confirmation dialog', () => {
  it('accepts once and cancels without stale state', async () => {
    const dialog = createDialog();
    const controller = createConfirmationDialogController(dialog);
    const accepted = controller.confirm('Удалить запись?', 'Только синтетическая запись');
    expect(dialog.open).toBe(true);
    expect(screen.getByRole('heading', { name: 'Удалить запись?' })).toBeTruthy();
    expect(screen.getByText('Только синтетическая запись')).toBeTruthy();
    await expect(controller.confirm('Нельзя', 'Повторная форма')).rejects.toThrow(
      'Предыдущее подтверждение',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await expect(accepted).resolves.toBe(true);

    const cancelled = controller.confirm('Очистить?', 'Старые данные');
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await expect(cancelled).resolves.toBe(false);
    expect(dialog.close).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('rejects native Escape close and pending confirmation on scope revocation', async () => {
    const dialog = createDialog();
    const controller = createConfirmationDialogController(dialog);
    const byEscape = controller.confirm('Удалить?', 'Проверка клавиатуры');
    dialog.close();
    await expect(byEscape).resolves.toBe(false);

    const pending = controller.confirm('Подтвердить?', 'Другой пользователь');
    controller.dispose();
    await expect(pending).resolves.toBe(false);
    await expect(controller.confirm('Нельзя', 'После отзыва')).rejects.toThrow(
      'Предыдущее подтверждение',
    );
  });

  it('renders user-provided text as plain text, not executable markup', async () => {
    const dialog = createDialog();
    const controller = createConfirmationDialogController(dialog);
    const response = controller.confirm(
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
    );
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.querySelector('#confirmation-title')?.textContent).toContain('<img');
    controller.dispose();
    await expect(response).resolves.toBe(false);
  });
});
