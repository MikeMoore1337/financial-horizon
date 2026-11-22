import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Icon } from './Calendar';

/**
 * Static presentation only: native form inputs and delegated legacy handlers own all
 * command submission, validation, file reads and one-shot import approval.
 */
export function PaymentMethodsDialog() {
  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <div>
          <span className="eyebrow">Регулярный расход</span>
          <h2 id="payment-methods-heading">Способы оплаты</h2>
        </div>
        <button
          type="button"
          className="tool-icon"
          data-action="close-payment-methods"
          aria-label="Закрыть"
        >
          <Icon name="close" />
        </button>
      </div>
      <div id="payment-methods-list" aria-live="polite" />
      <form id="payment-method-form" method="dialog" noValidate>
        <input type="hidden" name="methodId" />
        <h3 id="payment-method-save-title">Новый способ оплаты</h3>
        <label className="field">
          <span>Тип способа оплаты</span>
          <select name="type" id="payment-method-type">
            <option value="payment_url">Ссылка на оплату или личный кабинет</option>
            <option value="qr_image">Изображение QR-кода</option>
            <option value="sbp_link">Ссылка СБП (HTTPS)</option>
            <option value="requisites">Реквизиты и назначение</option>
            <option value="instructions">Инструкция по оплате</option>
          </select>
        </label>
        <label className="field">
          <span>Название способа</span>
          <input name="label" required maxLength={80} placeholder="Например, Личный кабинет" />
        </label>
        <div id="payment-method-text-field">
          <label className="field">
            <span id="payment-method-value-label">Адрес HTTPS</span>
            <textarea name="value" rows={3} maxLength={2048} required />
          </label>
        </div>
        <div id="payment-method-qr-field" hidden>
          <label className="field">
            <span>Изображение PNG, JPEG или WebP (до 192 КБ)</span>
            <input
              name="qrFile"
              type="file"
              accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            />
          </label>
          <p className="form-note">
            Файл остаётся в вашей финансовой базе и зашифрованных резервных копиях. При изменении
            можно оставить старое изображение.
          </p>
        </div>
        <label className="field">
          <span>
            <input type="checkbox" name="primary" /> Сделать основным
          </span>
        </label>
        <p className="form-note">
          Не сохраняйте пароли, CVV, коды подтверждения и токены. Внешняя оплата не отмечает расход
          как оплаченный.
        </p>
        <div className="dialog-actions">
          <button type="button" className="button-secondary" data-action="reset-payment-method">
            Отменить правку
          </button>
          <button type="submit" className="button-primary">
            Сохранить способ
          </button>
        </div>
      </form>
      <div className="dialog-actions">
        <button type="button" className="button-secondary" data-action="close-payment-methods">
          Готово
        </button>
      </div>
    </div>
  );
}

export function ExcelImportDialog() {
  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <div>
          <span className="eyebrow">Только локально</span>
          <h2 id="excel-import-heading">Предпросмотр импорта Excel</h2>
        </div>
        <button
          type="button"
          className="tool-icon"
          data-action="cancel-excel-import"
          aria-label="Закрыть"
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="form-note">
        Ничего ещё не сохранено. Проверьте суммы, график кредитов и предупреждения. При
        подтверждении данные будут добавлены в текущую бухгалтерию, без удаления существующих
        записей.
      </p>
      <section id="excel-import-summary" className="excel-import-summary" aria-live="polite" />
      <div className="excel-import-list">
        <h3 id="excel-import-items-heading">Подготовленные записи</h3>
        <div
          id="excel-import-items"
          tabIndex={0}
          role="region"
          aria-labelledby="excel-import-items-heading"
        />
      </div>
      <div className="excel-import-list">
        <h3 id="excel-import-warnings-heading">Требует проверки</h3>
        <div
          id="excel-import-warnings"
          tabIndex={0}
          role="region"
          aria-labelledby="excel-import-warnings-heading"
        />
      </div>
      <div className="dialog-actions">
        <button type="button" className="button-secondary" data-action="cancel-excel-import">
          Отмена
        </button>
        <button
          type="button"
          id="excel-import-confirm"
          className="button-primary"
          data-action="confirm-excel-import"
        >
          Добавить записи
        </button>
      </div>
    </div>
  );
}

export function CloudImportDialog() {
  return (
    <div className="dialog-body">
      <div className="dialog-head">
        <div>
          <span className="eyebrow">Личный финансовый аккаунт</span>
          <h2 id="cloud-import-heading">Подтвердить перенос</h2>
        </div>
        <button
          type="button"
          className="tool-icon"
          data-action="cancel-cloud-import"
          aria-label="Закрыть"
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="form-note">
        Шифрованная копия сверена с текущей бухгалтерией. На сервере пока ничего не изменено. После
        подтверждения сервер получит расшифрованные финансовые данные. Локальные данные останутся на
        устройстве даже после импорта.
      </p>
      <p id="cloud-import-summary" className="form-note" role="status" aria-live="polite" />
      <div id="cloud-import-comparison" />
      <label className="field" id="cloud-import-preserve-row" hidden>
        <span>
          <input type="checkbox" id="cloud-import-preserve-zero-account" /> Я отдельно подтверждаю
          сохранение существующего пустого счёта на сервере. Он не будет удалён или объединён с
          локальными суммами.
        </span>
      </label>
      <label className="field">
        <span>
          <input type="checkbox" id="cloud-import-final-consent" /> Я сохранил зашифрованную копию
          вне браузера, проверил данные и разрешаю однократный перенос в свой аккаунт.
        </span>
      </label>
      <p className="form-note">
        Если импорт прервётся после подтверждения, не запускайте его повторно, пока не проверите
        результат на сервере. Автоматического удаления локальной базы нет.
      </p>
      <div className="dialog-actions">
        <button type="button" className="button-secondary" data-action="cancel-cloud-import">
          Отмена
        </button>
        <button type="button" className="button-secondary" data-action="prepare-cloud-merge" hidden>
          Подготовить предпросмотр
        </button>
        <button type="button" className="button-primary" data-action="confirm-cloud-import">
          Перенести на сервер
        </button>
      </div>
    </div>
  );
}

export interface AuxiliaryDialogHosts {
  paymentMethods: HTMLDialogElement;
  excelImport: HTMLDialogElement;
  cloudImport: HTMLDialogElement;
}

export function createAuxiliaryDialogRoots(hosts: AuxiliaryDialogHosts) {
  const configs = [
    { host: hosts.paymentMethods, element: <PaymentMethodsDialog /> },
    { host: hosts.excelImport, element: <ExcelImportDialog /> },
    { host: hosts.cloudImport, element: <CloudImportDialog /> },
  ];
  if (new Set(configs.map(({ host }) => host)).size !== configs.length) {
    throw new Error('Each auxiliary dialog requires its own host');
  }
  const roots = configs.map(({ host }) => createRoot(host));
  let disposed = false;
  let mounted = false;
  return {
    mount(): void {
      if (disposed) throw new Error('Dialogs were already disposed');
      if (mounted) return;
      mounted = true;
      flushSync(() => {
        configs.forEach(({ element }, index) =>
          roots[index]!.render(<StrictMode>{element}</StrictMode>),
        );
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      configs.forEach(({ host }) => {
        if (host.open) host.close();
      });
      roots.forEach((root) => root.unmount());
    },
  };
}
