import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Settings, type SettingsProps } from '../../src/react/Settings';

const empty: SettingsProps = {
  currentDate: '2026-11-07',
  categories: [],
  archived: [],
  audit: [],
  storageMessage: 'Постоянное хранение не подтверждено.',
  formatDate: (date) => date,
};
afterEach(cleanup);

describe('React Settings - local data controls', () => {
  it('renders exactly seven approved cards and no duplicate account/theme controls', () => {
    render(
      <StrictMode>
        <Settings {...empty} />
      </StrictMode>,
    );
    expect(screen.getByRole('heading', { name: 'Настройки' })).toBeTruthy();
    const cards = document.querySelectorAll('[data-settings-card]');
    expect(cards.length).toBe(7);
    expect([...cards].map((card) => card.getAttribute('data-settings-card'))).toEqual([
      'security',
      'backup',
      'import',
      'categories',
      'archive',
      'history',
      'install',
    ]);
    expect(document.querySelector('.settings-install')).not.toBeNull();
    expect(document.querySelector('#storage-status')?.getAttribute('role')).toBe('status');
    expect(screen.getByText(empty.storageMessage)).toBeTruthy();
    expect(document.querySelector('[data-action="account-logout"]')).toBeNull();
    expect(document.querySelector('[data-action="theme"]')).toBeNull();
  });
  it('does not inject category or audit record names and preserves action attributes', () => {
    const props: SettingsProps = {
      ...empty,
      categories: ['<img src=x onerror=alert(1)>'],
      archived: [{ id: 'e1', entity: 'entry', title: '<script>alert(1)</script>' }],
      audit: [{ id: 'h1', date: '2026-11-07', description: '<iframe src=x>' }],
    };
    const original = structuredClone(props.categories);
    render(<Settings {...props} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(screen.getByText('<iframe src=x>')).toBeTruthy();
    expect(document.querySelector('img,script,iframe')).toBeNull();
    expect(
      document.querySelector('[data-action="restore-item"][data-entity="entry"][data-id="e1"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-action="delete-category"]')?.getAttribute('data-category'),
    ).toBe(props.categories[0]);
    expect(document.querySelector('[data-action="backup"]')).toBeTruthy();
    expect(document.querySelector('[data-action="excel-import"]')).toBeTruthy();
    expect(props.categories).toEqual(original);
  });
  it('supports native category submit through exactly one document handler under StrictMode', () => {
    const submissions: string[] = [];
    const handler = (event: Event) => {
      if ((event.target as Element).id === 'category-form') {
        event.preventDefault();
        submissions.push(
          (event.target as HTMLFormElement).elements.namedItem('name') instanceof HTMLInputElement
            ? ((event.target as HTMLFormElement).elements.namedItem('name') as HTMLInputElement)
                .value
            : '',
        );
      }
    };
    document.addEventListener('submit', handler);
    try {
      render(
        <StrictMode>
          <Settings {...empty} />
        </StrictMode>,
      );
      const form = document.querySelector<HTMLFormElement>('#category-form')!;
      const field = form.elements.namedItem('name') as HTMLInputElement;
      field.value = 'QA category';
      fireEvent.submit(form);
      expect(submissions).toEqual(['QA category']);
    } finally {
      document.removeEventListener('submit', handler);
    }
  });
});

it('optional server accounts entry is hidden by default and only routes on explicit opt-in', () => {
  render(<Settings {...empty} showFinanceAccounts />);
  const cards = document.querySelectorAll('[data-settings-card]');
  expect(cards).toHaveLength(8);
  const accountCard = document.querySelector('[data-settings-card="finance-accounts"]');
  expect(accountCard).not.toBeNull();
  expect(accountCard?.querySelector('[data-view="accounts-connected"]')).not.toBeNull();
  expect(screen.getByText('Счета и кошельки')).toBeTruthy();
  expect(document.querySelector('[data-action="account-logout"]')).toBeNull();
});
