import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createAuxiliaryDialogRoots } from '../../src/react/AuxiliaryDialogs';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('React auxiliary payment and import dialogs', () => {
  it('preserves payment method fields, file safety and cloud import consent gates', () => {
    const hosts = {
      paymentMethods: document.createElement('dialog'),
      excelImport: document.createElement('dialog'),
      cloudImport: document.createElement('dialog'),
    };
    document.body.append(...Object.values(hosts));
    const roots = createAuxiliaryDialogRoots(hosts);
    roots.mount();
    const method = document.querySelector<HTMLFormElement>('#payment-method-form')!;
    expect(method.getAttribute('method')).toBe('dialog');
    expect(method.noValidate).toBe(true);
    expect(method.querySelectorAll('#payment-method-type option')).toHaveLength(5);
    expect(method.querySelector<HTMLInputElement>('[name="qrFile"]')?.type).toBe('file');
    expect(method.querySelector<HTMLInputElement>('[name="primary"]')?.type).toBe('checkbox');
    expect(document.querySelector('#excel-import-items[role="region"]')).toBeTruthy();
    expect(document.querySelector('#excel-import-warnings[role="region"]')).toBeTruthy();
    const consent = document.querySelector<HTMLInputElement>('#cloud-import-final-consent')!;
    const preserve = document.querySelector<HTMLInputElement>(
      '#cloud-import-preserve-zero-account',
    )!;
    expect(consent.checked).toBe(false);
    expect(preserve.checked).toBe(false);
    roots.mount();
    expect(document.querySelectorAll('#payment-method-form')).toHaveLength(1);
    roots.dispose();
    for (const host of Object.values(hosts)) expect(host.childElementCount).toBe(0);
  });
});
