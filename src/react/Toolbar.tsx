import { Icon } from './Calendar';
import type { FinanceView } from './Navigation';

export interface ToolbarProps {
  view: FinanceView;
  theme: 'light' | 'dark';
  signedIn: boolean;
  busy: boolean;
}

const headings: Record<FinanceView, string> = {
  overview: 'Обзор',
  calendar: 'Календарь',
  obligations: 'Обязательства',
  loans: 'Кредиты',
  settings: 'Настройки',
};

/** Presentation only; existing delegated handlers own every action. */
export function Toolbar({ view, theme, signedIn, busy }: ToolbarProps) {
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
        <span id="toolbar-title">{headings[view]}</span>
      </div>
      <div className="toolbar-actions">
        <span className="local-chip">
          <span className="privacy-dot" /> Локально
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
        >
          <Icon name="plus" />
          <span>Добавить</span>
        </button>
      </div>
    </>
  );
}
