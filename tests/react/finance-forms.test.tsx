import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createFinanceFormRoots } from '../../src/react/FinanceForms';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('React-owned legacy finance forms', () => {
  it('preserves native form IDs, field contracts, validation and encrypted backup inputs', () => {
    const ids = ['entry', 'loan', 'payment', 'settlement', 'password'] as const;
    const hosts = Object.fromEntries(
      ids.map((id) => {
        const dialog = document.createElement('dialog');
        dialog.id = id + '-dialog';
        document.body.append(dialog);
        return [id, dialog];
      }),
    ) as unknown as Parameters<typeof createFinanceFormRoots>[0];

    const roots = createFinanceFormRoots(hosts);
    roots.mount();
    for (const id of ids) {
      const form = document.getElementById(id + '-form') as HTMLFormElement;
      expect(form.getAttribute('method')).toBe('dialog');
      expect(form.noValidate).toBe(true);
      expect(form.closest('dialog')).toBe(hosts[id]);
      expect(form.querySelectorAll('[value="cancel"]').length).toBeGreaterThan(0);
    }
    expect(document.querySelector('#entry-form [name="category"]')).toBeTruthy();
    expect(document.querySelector('#payment-form [name="strategy"][value="term"]')).toBeTruthy();
    expect(document.querySelector('#settlement-form [name="occurrence"]')).toBeTruthy();
    const secret = document.querySelector<HTMLInputElement>('#password-form [name="password"]')!;
    expect(secret.type).toBe('password');
    expect(secret.minLength).toBe(12);
    expect(secret.autocomplete).toBe('new-password');
    const entryTitle = document.querySelector<HTMLInputElement>('#entry-form [name="title"]')!;
    entryTitle.value = 'Пример';
    roots.mount();
    expect(entryTitle.value).toBe('Пример');
    roots.dispose();
    for (const id of ids) expect(hosts[id].childElementCount).toBe(0);
  });
});
