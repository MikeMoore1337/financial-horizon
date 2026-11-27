import { Icon } from './Calendar';

export interface ToolbarProps {
  title: string;
  serverAccounts: boolean;
  localSnapshot?: boolean;
  budgetsEnabled?: boolean;
  goalsEnabled?: boolean;
  hideGlobalAdd?: boolean;
  theme: 'light' | 'dark';
  signedIn: boolean;
  busy: boolean;
}

/** Presentation only; existing delegated handlers own every action. */
export function Toolbar({
  title,
  theme,
  signedIn,
  busy,
  serverAccounts,
  localSnapshot = false,
  hideGlobalAdd = false,
}: ToolbarProps) {
  return (
    <>
      <div className="toolbar-leading">
        <button
          type="button"
          className="tool-icon hamburger"
          id="menu-toggle"
          aria-label="Открыть меню"
        >
          <Icon name="menu" />
        </button>
        <span className="crumb">Личные финансы</span>
        <span className="crumb-slash">/</span>
        <span id="toolbar-title">{title}</span>
      </div>
      <div className="toolbar-actions">
        <span className="local-chip">
          <span className="privacy-dot" />
          <span id="storage-context-chip">
            {localSnapshot ? 'Локальная копия' : serverAccounts ? 'На сервере' : 'Локально'}
          </span>
        </span>
        <button
          type="button"
          className="tool-icon"
          id="theme-toggle"
          aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          title="Переключить тему"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <a
          className="tool-icon toolbar-account"
          href="./account.html"
          id="account-entry-toolbar"
          aria-label="Управление аккаунтом"
          title="Управление аккаунтом"
          hidden={!signedIn}
        >
          <span className="lucide-user-icon" aria-hidden="true" />
        </a>
        <button
          type="button"
          className="button-secondary toolbar-logout"
          id="account-logout-toolbar"
          data-action="account-logout"
          aria-label="Выйти из аккаунта"
          title="Выйти из аккаунта"
          disabled={busy}
          hidden={!signedIn}
        >
          <span className="lucide-logout-icon" aria-hidden="true" />
          <span className="toolbar-logout-label">Выйти</span>
        </button>
        <button
          type="button"
          className="button-primary toolbar-add"
          id="top-add"
          aria-label="Добавить запись"
          hidden={serverAccounts || hideGlobalAdd}
        >
          <Icon name="plus" />
          <span>Добавить</span>
        </button>
      </div>
    </>
  );
}
