import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Toolbar } from '../../src/react/Toolbar';

afterEach(cleanup);

describe('React toolbar presentation and delegated actions', () => {
  it('hides account actions from guests and disables logout during a request', () => {
    const { rerender } = render(
      <StrictMode>
        <Toolbar
          title="Обзор"
          theme="light"
          signedIn={false}
          busy={false}
          serverAccounts={false}
        />
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
        <Toolbar title="Счета и кошельки" theme="dark" signedIn busy serverAccounts />
      </StrictMode>,
    );
    expect(screen.getByText('Счета и кошельки')).toBeTruthy();
    expect(document.getElementById('storage-context-chip')?.textContent).toBe('На сервере');
    expect((document.getElementById('top-add') as HTMLButtonElement).hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Включить светлую тему' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Управление аккаунтом' })).toBe(account);
    expect(account.hidden).toBe(false);
    expect(logout.hidden).toBe(false);
    expect(logout.disabled).toBe(true);

    rerender(
      <StrictMode>
        <Toolbar
          title="Настройки"
          theme="dark"
          signedIn
          busy={false}
          serverAccounts={false}
        />
      </StrictMode>,
    );
    expect(screen.getByText('Настройки')).toBeTruthy();
    expect(logout.disabled).toBe(false);
    expect(document.getElementById('storage-context-chip')?.textContent).toBe('Локально');
    expect((document.getElementById('top-add') as HTMLButtonElement).hidden).toBe(false);
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
          <Toolbar
          title="Календарь"
          theme="light"
          signedIn
          busy={false}
          serverAccounts={false}
        />
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
