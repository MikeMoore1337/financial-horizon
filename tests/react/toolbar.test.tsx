import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Toolbar } from '../../src/react/Toolbar';

afterEach(cleanup);

describe('React toolbar presentation and delegated actions', () => {
  it('hides account actions from guests and disables logout during a request', () => {
    const { rerender } = render(
      <StrictMode>
        <Toolbar view="overview" theme="light" signedIn={false} busy={false} />
      </StrictMode>,
    );
    const account = document.getElementById('account-entry-toolbar') as HTMLAnchorElement;
    const logout = document.getElementById('account-logout-toolbar') as HTMLButtonElement;
    expect(screen.getByText('Обзор')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Добавить запись' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Включить тёмную тему' })).toBeTruthy();
    expect(account.hidden).toBe(true);
    expect(logout.hidden).toBe(true);

    rerender(
      <StrictMode>
        <Toolbar view="loans" theme="dark" signedIn busy />
      </StrictMode>,
    );
    expect(screen.getByText('Кредиты')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Включить светлую тему' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Управление аккаунтом' })).toBe(account);
    expect(account.hidden).toBe(false);
    expect(logout.hidden).toBe(false);
    expect(logout.disabled).toBe(true);

    rerender(
      <StrictMode>
        <Toolbar view="settings" theme="dark" signedIn busy={false} />
      </StrictMode>,
    );
    expect(screen.getByText('Настройки')).toBeTruthy();
    expect(logout.disabled).toBe(false);
  });

  it('delegates toolbar actions exactly once even under React StrictMode', () => {
    const actions: string[] = [];
    const listener = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action =
        target.closest<HTMLElement>('[data-action]')?.dataset.action ??
        target.closest<HTMLElement>('#top-add, #theme-toggle')?.id;
      if (action) actions.push(action);
    };
    document.addEventListener('click', listener);
    try {
      render(
        <StrictMode>
          <Toolbar view="calendar" theme="light" signedIn busy={false} />
        </StrictMode>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Добавить запись' }));
      fireEvent.click(screen.getByRole('button', { name: 'Включить тёмную тему' }));
      fireEvent.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
      expect(actions).toEqual(['top-add', 'theme-toggle', 'account-logout']);
    } finally {
      document.removeEventListener('click', listener);
    }
  });
});
