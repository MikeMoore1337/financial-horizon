import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import {
  CategoryRenameDialog,
  createCategoryDialogController,
} from '../../src/react/CategoryDialog';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('React category rename form', () => {
  it('preserves native dialog form contract, accessible controls and exact field names', () => {
    render(
      <StrictMode>
        <CategoryRenameDialog />
      </StrictMode>,
    );
    const form = document.getElementById('rename-category-form') as HTMLFormElement;
    expect(form.getAttribute('method')).toBe('dialog');
    expect(form.noValidate).toBe(true);
    expect(screen.getByRole('heading', { name: 'Переименовать категорию' })).toBeTruthy();
    expect(form.querySelector('[name="old"]')).toBeTruthy();
    const input = form.querySelector<HTMLInputElement>('[name="newName"]')!;
    expect(input.maxLength).toBe(40);
    expect(input.required).toBe(true);
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeTruthy();
  });

  it('leaves uncontrolled inputs available to the existing delegated submit handler', () => {
    const host = document.createElement('dialog');
    document.body.append(host);
    const controller = createCategoryDialogController(host);
    controller.render();
    const form = document.getElementById('rename-category-form') as HTMLFormElement;
    const input = form.querySelector<HTMLInputElement>('[name="newName"]')!;
    input.value = 'Категория 1';
    controller.render();
    expect(input.value).toBe('Категория 1');
    expect(document.querySelectorAll('#rename-category-form')).toHaveLength(1);
    controller.dispose();
    expect(host.childElementCount).toBe(0);
  });
});
