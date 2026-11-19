import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { GoalsPreview } from '../../../src/react/goals/GoalsPreview.tsx';
import { buildGoalsScreenModel, createGoal } from '../../../src/domain/goals/index.ts';
import type { GoalEvent, GoalInstallment } from '../../../src/domain/goals/types.ts';

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
  it('shows next due dates rather than the first year of a multi-year goal', () => {
    const oldGoal=createGoal({id:'old',eventId:'old-1',title:'Долгосрочная цель',
      on:'2024-01-01',targetCents:12_000_000,targetDate:'2027-01-01'});
    const model=buildGoalsScreenModel([oldGoal],'2026-11-08','old');
    render(<GoalsPreview {...props()} model={model} />);
    const installments=document.querySelectorAll('.goals-preview-rows')[0]!;
    expect(installments.textContent).toContain('2026-12-01');
    expect(installments.textContent).toContain('Ожидается');
    expect(installments.textContent).not.toContain('2024-02-01');
    expect(installments.textContent).not.toContain('upcoming');
  });
  it('distinguishes undefined deficit from zero after the deadline', () => {
    const past=createGoal({id:'past',eventId:'past-1',title:'Просроченная цель',
      on:'2026-01-01',targetCents:12_000_000,targetDate:'2026-02-01'});
    const model=buildGoalsScreenModel([past],'2026-11-08','past');
    expect(model.selected?.snapshot.monthlyDeficitCents).toBeNull();
    render(<GoalsPreview {...props()} model={model} />);
    expect(screen.getByText('Невозможно рассчитать')).toBeTruthy();
    expect(screen.getByText('Предстоящих взносов нет.')).toBeTruthy();
  });
  it('localizes all installment statuses and goal history event types', () => {
    const model=data();
    const statuses: GoalInstallment['status'][] =
      ['upcoming','paid','partial','missed','skipped','unnecessary'];
    const eventTypes: GoalEvent['type'][] =
      ['create','update','contribution','use','skip','void',
        'complete','reopen','archive','restore'];
    model.selected!.installments=statuses.map((status,index) => ({
      dueOn:'2026-12-'+String(index+1).padStart(2,'0'),
      plannedCents:10_000,actualCents:0,status,
    }));
    model.selected!.history=eventTypes.map((type,index) => ({
      eventId:'event-'+index,on:'2026-11-08',type,amountCents:null,
      ledgerMutationCents:0 as const,reversed:false,voidedOn:null,
    }));
    render(<GoalsPreview {...props()} model={model} />);
    for (const label of ['Ожидается','Оплачено','Частично внесено','Пропущено',
      'Пропущено по плану','Не требуется','Создание цели','Изменение цели',
      'Пополнение','Использование средств','Пропуск взноса','Отмена операции',
      'Завершение цели','Возобновление цели','Архивация','Восстановление']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const raw of [...statuses,...eventTypes]) {
      expect(screen.queryByText(raw)).toBeNull();
    }
  });

});
