import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { AppShell, createAppShellRoots } from '../../src/react/AppShell';
import { Navigation } from '../../src/react/Navigation';
import { AuthBoundary, isAuthorized } from '../../src/react/AuthBoundary';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('React navigation shell and auth boundary', () => {
  it('renders five accessible navigation buttons with the original labels and current state', () => {
    render(
      <StrictMode>
        <Navigation variant="sidebar" view="calendar" />
      </StrictMode>,
    );
    expect(document.querySelectorAll('[data-view]')).toHaveLength(5);
    const selected = document.querySelector<HTMLButtonElement>('[data-view="calendar"]')!;
    expect(selected.className).toContain('active');
    expect(selected.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Обязательства' })).toBeTruthy();
    cleanup();
    render(<Navigation variant="bottom" view="settings" />);
    expect(screen.getByRole('button', { name: 'Ещё' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Платежи' })).toBeTruthy();
  });
  it('uses a single delegated action per click across both React-owned navigation hosts', () => {
    const sidebar = document.createElement('nav'),
      bottom = document.createElement('nav'),
      toolbar = document.createElement('header');
    sidebar.className = 'sidebar-nav';
    bottom.className = 'bottom-nav';
    toolbar.className = 'toolbar';
    document.body.append(sidebar, bottom, toolbar);
    const events: string[] = [];
    const callback = (event: MouseEvent) => {
      const el = (event.target as Element).closest('[data-view]');
      if (el) events.push(el.getAttribute('data-view')!);
    };
    document.addEventListener('click', callback);
    const roots = createAppShellRoots(sidebar, bottom, toolbar);
    try {
      roots.render('overview', { theme: 'light', signedIn: false, busy: false });
      roots.render('loans', { theme: 'dark', signedIn: true, busy: false });
      expect(sidebar.querySelectorAll('[data-view]')).toHaveLength(5);
      expect(bottom.querySelectorAll('[data-view]')).toHaveLength(5);
      expect(toolbar.querySelector('#toolbar-title')?.textContent).toBe('Кредиты');
      expect(sidebar.querySelector('[data-view="loans"]')?.getAttribute('aria-current')).toBe(
        'page',
      );
      expect(bottom.querySelector('[data-view="loans"]')?.className).toBe('active');
      fireEvent.click(sidebar.querySelector('[data-view="loans"]')!);
      expect(events).toEqual(['loans']);
    } finally {
      roots.unmount();
      document.removeEventListener('click', callback);
    }
    expect(sidebar.childElementCount).toBe(0);
    expect(bottom.childElementCount).toBe(0);
    expect(toolbar.childElementCount).toBe(0);
  });
  it('hides all user data until the verified account matches active storage scope', () => {
    const forbidden = {
      kind: 'account',
      accountId: 'one',
      verifiedUserId: 'two',
      sessionValid: true,
    } as const;
    expect(isAuthorized(forbidden)).toBe(false);
    const { rerender } = render(
      <AuthBoundary access={forbidden}>
        <strong>PRIVATE LEDGER</strong>
      </AuthBoundary>,
    );
    expect(screen.queryByText('PRIVATE LEDGER')).toBeNull();
    rerender(
      <AuthBoundary
        access={{ kind: 'account', accountId: 'one', verifiedUserId: 'one', sessionValid: false }}
      >
        <strong>PRIVATE LEDGER</strong>
      </AuthBoundary>,
    );
    expect(screen.queryByText('PRIVATE LEDGER')).toBeNull();
    rerender(
      <AuthBoundary access={{ kind: 'guest' }}>
        <strong>GUEST LEDGER</strong>
      </AuthBoundary>,
    );
    expect(screen.getByText('GUEST LEDGER')).toBeTruthy();
    rerender(
      <AuthBoundary access={{ kind: 'blocked' }}>
        <strong>GUEST LEDGER</strong>
      </AuthBoundary>,
    );
    expect(screen.queryByText('GUEST LEDGER')).toBeNull();
  });
});
