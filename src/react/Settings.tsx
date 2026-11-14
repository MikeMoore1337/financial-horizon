import { type ReactNode } from 'react';
import { Icon, type CalendarProps } from './Calendar';

export interface SettingsArchiveItem {
  id: string;
  title: string;
  entity: 'entry' | 'loan';
}
export interface SettingsAuditItem {
  id: string;
  description: string;
  date: string;
}
export interface SettingsProps {
  currentDate: string;
  categories: readonly string[];
  archived: readonly SettingsArchiveItem[];
  audit: readonly SettingsAuditItem[];
  storageMessage: string;
  formatDate: CalendarProps['formatDate'];
  showFinanceAccounts?: boolean;
  showFinanceImport?: boolean;
}

function SettingsCard({
  id,
  icon,
  children,
  install = false,
}: {
  id: string;
  icon: string;
  children: ReactNode;
  install?: boolean;
}) {
  return (
    <section
      className={'surface settings-card' + (install ? ' settings-install' : '')}
      data-settings-card={id}
    >
      <div className="settings-symbol" aria-hidden="true">
        <Icon name={icon} />
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

export function Settings({
  currentDate,
  categories,
  archived,
  audit,
  storageMessage,
  formatDate,
  showFinanceAccounts = false,
  showFinanceImport = false,
}: SettingsProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">{formatDate(currentDate)} · Личные финансы</div>
          <h1>Настройки</h1>
          <p className="subtitle">Безопасность, данные и управление записями</p>
        </div>
        <div className="header-tools" />
      </header>
      <div className="settings-grid">
        {showFinanceAccounts && (
          <SettingsCard id="finance-accounts" icon="credit">
            <h2>Счета и кошельки</h2>
            <p>Подтверждённые остатки с сервера. Локальные данные не меняются.</p>
            <div className="setting-actions">
              <button type="button" className="button-secondary" data-view="accounts-connected">
                <Icon name="credit" /> Открыть счета
              </button>
            </div>
          </SettingsCard>
        )}
        <SettingsCard id="security" icon="shield">
          <h2>Локальная безопасность</h2>
          <p>
            Финансовые записи хранятся в этом браузере и не передаются на сервер. В приватном режиме
            они могут быть удалены после закрытия окна.
          </p>
          <div className="setting-actions">
            <button className="button-secondary" data-action="persist">
              <Icon name="lock" /> Запросить постоянное хранение
            </button>
          </div>
          <p id="storage-status" className="small-hint settings-footnote" role="status">
            {storageMessage}
          </p>
        </SettingsCard>
        <SettingsCard id="backup" icon="download">
          <h2>Зашифрованная копия</h2>
          <p>
            Сохраните записи в зашифрованный файл (AES-256-GCM) для переноса на другое устройство
            или восстановления.
          </p>
          <div className="setting-actions">
            <button className="button-primary" data-action="backup">
              <Icon name="download" /> Скачать копию
            </button>
            <button className="button-secondary" data-action="verify-backup">
              <Icon name="shield" /> Проверить копию
            </button>
            <button className="button-secondary" data-action="restore">
              <Icon name="upload" /> Восстановить
            </button>
            {showFinanceAccounts && showFinanceImport && (
              <button className="button-secondary" data-action="cloud-import">
                <Icon name="upload" /> Перенести данные в аккаунт
              </button>
            )}
          </div>
          <p
            id="backup-verify-status"
            className="small-hint settings-footnote"
            role="status"
            aria-live="polite"
          />
        </SettingsCard>
        <SettingsCard id="import" icon="sheet">
          <h2>Импорт из Excel</h2>
          <p>
            Выберите XLSX для предварительного просмотра. Файл обрабатывается в браузере, текущие
            записи не заменяются.
          </p>
          <div className="setting-actions">
            <button className="button-secondary" data-action="excel-import">
              <Icon name="upload" /> Выбрать файл
            </button>
          </div>
          <p className="small-hint settings-footnote">
            Поддерживается шаблон с доходами и кредитами. Перед импортом проверьте суммы, даты и
            остатки.
          </p>
        </SettingsCard>
        <SettingsCard id="categories" icon="tag">
          <h2>Категории</h2>
          <p>
            Добавляйте, переименовывайте и удаляйте категории. Используемую категорию сначала
            замените в записях.
          </p>
          <div className="category-items">
            {categories.map((category) => (
              <span className="category-chip" key={category}>
                <span className="category-name">{category}</span>
                <button
                  type="button"
                  data-action="edit-category"
                  data-category={category}
                  aria-label={'Переименовать категорию ' + category}
                  title="Переименовать"
                >
                  <Icon name="edit" />
                </button>
                <button
                  type="button"
                  data-action="delete-category"
                  data-category={category}
                  aria-label={'Удалить категорию ' + category}
                  title="Удалить"
                >
                  <Icon name="trash" />
                </button>
              </span>
            ))}
          </div>
          <form id="category-form" className="category-add">
            <input
              name="name"
              maxLength={40}
              required
              aria-label="Новая категория"
              placeholder="Название категории"
            />
            <button className="button-primary" type="submit">
              Добавить
            </button>
          </form>
        </SettingsCard>
        <SettingsCard id="archive" icon="archive">
          <h2>Архив записей</h2>
          <p>Удалённые записи остаются в архиве и доступны для восстановления.</p>
          <div className="archive-list">
            {archived.length ? (
              archived.map((item) => (
                <div className="archive-row" key={item.entity + ':' + item.id}>
                  <span>{item.title}</span>
                  <button
                    className="button-text"
                    data-action="restore-item"
                    data-id={item.id}
                    data-entity={item.entity}
                  >
                    Восстановить
                  </button>
                </div>
              ))
            ) : (
              <div className="small-hint">Архив пуст.</div>
            )}
          </div>
        </SettingsCard>
        <SettingsCard id="history" icon="database">
          <h2>Пример и история</h2>
          <p>Загрузите пример записей для знакомства с интерфейсом или очистите бухгалтерию.</p>
          <div className="setting-actions">
            <button className="button-secondary" data-action="sample">
              Загрузить пример
            </button>
            <button className="button-secondary danger-zone" data-action="clear">
              Очистить бухгалтерию
            </button>
          </div>
          <details className="settings-history">
            <summary>
              Последние изменения{audit.length ? ' (' + Math.min(audit.length, 8) + ')' : ''}
            </summary>
            <div className="archive-list">
              {audit.length ? (
                audit.map((item) => (
                  <div className="archive-row" key={item.id}>
                    <span>{item.description}</span>
                    <span className="muted">{formatDate(item.date)}</span>
                  </div>
                ))
              ) : (
                <div className="small-hint">Пока изменений нет.</div>
              )}
            </div>
          </details>
        </SettingsCard>
        <SettingsCard id="install" icon="smartphone" install>
          <h2>Установка приложения</h2>
          <p>
            Установите приложение через меню браузера. На iPhone используйте «Поделиться» → «На
            экран Домой», на Mac - «Добавить в Dock». Данные разных устройств автоматически не
            объединяются.
          </p>
          <div className="setting-actions">
            <button className="button-secondary" data-action="install">
              Установить (где поддерживается)
            </button>
          </div>
        </SettingsCard>
      </div>
    </>
  );
}
