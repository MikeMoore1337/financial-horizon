import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { GoalsPreview } from '../../../src/react/goals/GoalsPreview.tsx';
import { buildGoalsScreenModel, createGoal } from '../../../src/domain/goals/index.ts';

function data() {
  const a = createGoal({ id:'a', eventId:'ea', title:'Подушка',
    category:'emergency', on:'2026-01-01', targetCents:12_000_000,
    openingCents:3_000_000, targetDate:'2027-01-01' });
  const b = createGoal({ id:'b', eventId:'eb', title:'Отпуск',
    category:'travel', on:'2026-01-01', targetCents:6_000_000,
    targetDate:'2027-02-01' });
  return buildGoalsScreenModel([a,b],'2026-11-08','a');
}
const props = () => ({model:data(),rubles:(x:number) => String(x/100) + ' ₽',
  formatDate:(x:string) => x});
afterEach(() => {cleanup();document.body.replaceChildren();});
describe('source-only approved goals preview', () => {
  it('renders goals and labels earmarking as neither bank cash nor expense', () => {
    render(<StrictMode><GoalsPreview {...props()} /></StrictMode>);
    expect(screen.getByRole('heading',{name:'Финансовые цели'})).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Предварительный просмотр');
    expect(screen.getByText('Это не банковский остаток и не расход')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Подушка'})).toBeTruthy();
    expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(1);
  });
  it('does not invent saving mutations and requires explicit selection handler', () => {
    const selected=vi.fn();
    const snapshot=data();
    const frozen=JSON.stringify(snapshot);
    const {rerender}=render(<GoalsPreview {...props()} model={snapshot} />);
    expect((screen.getByRole('button',{name:/Отпуск/}) as HTMLButtonElement).disabled).toBe(true);
    rerender(<GoalsPreview {...props()} model={snapshot} onSelect={selected} />);
    fireEvent.click(screen.getByRole('button',{name:/Отпуск/}));
    expect(selected).toHaveBeenCalledWith('b');
    expect(selected).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });
  it('never inserts a malicious title as HTML', () => {
    const model=data();
    model.cards[0]!.title='<img src=x onerror=alert(1)>';
    model.selected!.card.title='<img src=x onerror=alert(1)>';
    render(<GoalsPreview {...props()} model={model} />);
    expect(screen.getAllByText('<img src=x onerror=alert(1)>')).toHaveLength(2);
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
  it('renders an accessible empty state and zero counted funds', () => {
    const model=buildGoalsScreenModel([],'2026-11-08');
    render(<GoalsPreview {...props()} model={model} />);
    expect(screen.getByText('Накоплений пока нет.')).toBeTruthy();
    expect(screen.queryByRole('region',{name:'Выбранная цель'})).toBeNull();
  });
});
