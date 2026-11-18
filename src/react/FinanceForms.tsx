import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Icon } from './Calendar';

function FormHeader({
  subject,
  titleId,
  title,
}: {
  subject: string;
  titleId: string;
  title: string;
}) {
  return (
    <div className="dialog-head">
      <div>
        <span className="eyebrow">{subject}</span>
        <h2 id={titleId}>{title}</h2>
      </div>
      <button className="tool-icon" value="cancel" aria-label="Закрыть">
        <Icon name="close" />
      </button>
    </div>
  );
}

function FormActions({ text }: { text: string }) {
  return (
    <div className="dialog-actions">
      <button className="button-secondary" value="cancel">
        Отмена
      </button>
      <button type="submit" className="button-primary" value="save">
        {text}
      </button>
    </div>
  );
}

/** Uncontrolled native forms preserve the existing delegated domain mutations. */
export function EntryDialogForm() {
  return (
    <form method="dialog" id="entry-form" className="dialog-body" noValidate>
      <FormHeader subject="Доход или расход" titleId="entry-heading" title="Новая запись" />
      <input type="hidden" name="id" />
      <label className="field">
        <span>Название</span>
        <input name="title" maxLength={100} required placeholder="Например, интернет" />
      </label>
      <div className="form-two">
        <label className="field">
          <span>Тип</span>
          <select name="kind">
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
        </label>
        <label className="field">
          <span>Сумма, ₽</span>
          <input name="amount" inputMode="decimal" placeholder="0,00" required />
        </label>
      </div>
      <div className="form-two">
        <label className="field">
          <span>Дата первого платежа</span>
          <input name="date" type="date" required />
        </label>
        <label className="field">
          <span>Повторять</span>
          <select name="recurrence">
            <option value="monthly">Ежемесячно</option>
            <option value="once">Однократно</option>
            <option value="yearly">Ежегодно</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Категория</span>
        <select name="category" id="entry-category" />
      </label>
      <div className="form-note" id="entry-methods-access" hidden>
        <button type="button" className="button-secondary" data-action="open-payment-methods">
          Способы оплаты (<span id="entry-method-count">0</span>)
        </button>
        <span>Ссылки, QR и реквизиты для этой записи</span>
      </div>
      <FormActions text="Сохранить запись" />
    </form>
  );
}

export function LoanDialogForm() {
  return (
    <form method="dialog" id="loan-form" className="dialog-body" noValidate>
      <FormHeader
        subject="Кредитные обязательства"
        titleId="loan-heading"
        title="Добавить кредит"
      />
      <input type="hidden" name="id" />
      <label className="field">
        <span>Название</span>
        <input name="title" required maxLength={100} placeholder="Например, ипотека" />
      </label>
      <div className="form-two">
        <label className="field">
          <span>Остаток долга, ₽</span>
          <input name="opening" inputMode="decimal" required placeholder="2100000" />
        </label>
        <label className="field">
          <span>Годовая ставка, %</span>
          <input name="apr" inputMode="decimal" required placeholder="9,5" />
        </label>
      </div>
      <div className="form-two">
        <label className="field">
          <span>Ежемесячный платёж, ₽</span>
          <input name="payment" inputMode="decimal" required placeholder="30200" />
        </label>
        <label className="field">
          <span>Осталось месяцев по графику</span>
          <input name="term" type="number" min={1} max={1200} required placeholder="240" />
        </label>
      </div>
      <div className="form-two">
        <label className="field">
          <span>Дата актуального остатка</span>
          <input name="asOfDate" type="date" required />
        </label>
        <label className="field">
          <span>День ежемесячного платежа</span>
          <input name="dueDay" type="number" min={1} max={31} required />
        </label>
      </div>
      <p className="form-note">
        Изменение исходных условий пересчитает прогноз всех сохранённых платежей. История операций
        останется.
      </p>
      <FormActions text="Сохранить кредит" />
    </form>
  );
}

export function PaymentDialogForm() {
  return (
    <form method="dialog" id="payment-form" className="dialog-body" noValidate>
      <FormHeader subject="Фактическая оплата" titleId="payment-heading" title="Внести платёж" />
      <input name="paymentId" type="hidden" />
      <label className="field">
        <span>Кредит</span>
        <select name="loanId" id="payment-loan" required />
      </label>
      <div className="form-two">
        <label className="field">
          <span>Внесённая сумма, ₽</span>
          <input name="amount" inputMode="decimal" required placeholder="30200" />
        </label>
        <label className="field">
          <span>Дата оплаты</span>
          <input name="date" type="date" required />
        </label>
      </div>
      <fieldset className="segmented-field">
        <legend>Вариант перерасчёта досрочной части</legend>
        <label>
          <input type="radio" name="strategy" value="term" defaultChecked />
          <span>Уменьшить срок</span>
        </label>
        <label>
          <input type="radio" name="strategy" value="amount" />
          <span>Уменьшить платёж</span>
        </label>
      </fieldset>
      <div className="forecast-box" id="payment-preview" aria-live="polite">
        Введите сумму для расчёта.
      </div>
      <p className="form-note">
        Это приблизительный аннуитетный прогноз, а не официальный график банка. Проценты начисляются
        помесячно; особые условия банка и штрафы не учтены.
      </p>
      <FormActions text="Подтвердить оплату" />
    </form>
  );
}

export function SettlementDialogForm() {
  return (
    <form method="dialog" id="settlement-form" className="dialog-body" noValidate>
      <FormHeader subject="План и факт" titleId="settlement-heading" title="Отметить сумму" />
      <input type="hidden" name="entryId" />
      <input type="hidden" name="occurrence" />
      <p id="settlement-description" className="form-note" />
      <div className="form-two">
        <label className="field">
          <span>Фактически внесено, ₽</span>
          <input name="amount" inputMode="decimal" required />
        </label>
        <label className="field">
          <span>Дата операции</span>
          <input name="date" type="date" required />
        </label>
      </div>
      <FormActions text="Записать факт" />
    </form>
  );
}

export function BackupPasswordDialogForm() {
  return (
    <form method="dialog" id="password-form" className="dialog-body" noValidate>
      <FormHeader
        subject="Шифрованная резервная копия"
        titleId="password-heading"
        title="Сохранить данные"
      />
      <label className="field">
        <span>Пароль резервной копии</span>
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={12}
          required
          placeholder="Не меньше 12 символов"
        />
      </label>
      <p className="form-note">
        Пароль нигде не хранится и не передаётся. Если забыть его, восстановить копию будет
        невозможно.
      </p>
      <FormActions text="Продолжить" />
    </form>
  );
}

export interface FinanceFormHosts {
  entry: HTMLDialogElement;
  loan: HTMLDialogElement;
  payment: HTMLDialogElement;
  settlement: HTMLDialogElement;
  password: HTMLDialogElement;
}

export function createFinanceFormRoots(hosts: FinanceFormHosts) {
  const entries = [
    { host: hosts.entry, element: <EntryDialogForm /> },
    { host: hosts.loan, element: <LoanDialogForm /> },
    { host: hosts.payment, element: <PaymentDialogForm /> },
    { host: hosts.settlement, element: <SettlementDialogForm /> },
    { host: hosts.password, element: <BackupPasswordDialogForm /> },
  ];
  if (new Set(entries.map(({ host }) => host)).size !== entries.length) {
    throw new Error('Each financial dialog requires a distinct host');
  }
  const roots = entries.map(({ host }) => createRoot(host));
  let mounted = false;
  let disposed = false;
  return {
    mount(): void {
      if (disposed) throw new Error('Financial forms are no longer mounted');
      if (mounted) return;
      mounted = true;
      flushSync(() => {
        entries.forEach(({ element }, index) =>
          roots[index]!.render(<StrictMode>{element}</StrictMode>),
        );
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      entries.forEach(({ host }) => {
        if (host.open) host.close();
      });
      roots.forEach((root) => root.unmount());
    },
  };
}
