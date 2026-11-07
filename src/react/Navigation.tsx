import { Icon } from './Calendar';

export type FinanceView = 'overview' | 'calendar' | 'obligations' | 'loans' | 'settings';
export type NavigationVariant = 'sidebar' | 'bottom';
type NavigationItem = {
  view: FinanceView;
  title: string;
  shortTitle: string;
  icon: string;
};

const items: readonly NavigationItem[] = [
  { view: 'overview', title: 'Обзор', shortTitle: 'Обзор', icon: 'home' },
  { view: 'calendar', title: 'Календарь', shortTitle: 'Календарь', icon: 'calendar' },
  { view: 'obligations', title: 'Обязательства', shortTitle: 'Платежи', icon: 'list' },
  { view: 'loans', title: 'Кредиты', shortTitle: 'Кредиты', icon: 'credit' },
  { view: 'settings', title: 'Настройки', shortTitle: 'Ещё', icon: 'settings' },
];

export function Navigation({ view, variant }: { view: FinanceView; variant: NavigationVariant }) {
  return (
    <>
      {items.map((item) => {
        const selected = item.view === view;
        return (
          <button
            key={item.view}
            type="button"
            className={
              variant === 'sidebar'
                ? 'nav-item' + (selected ? ' active' : '')
                : selected
                  ? 'active'
                  : ''
            }
            data-view={item.view}
            aria-current={selected ? 'page' : 'false'}
          >
            <Icon name={item.icon} />
            <span>{variant === 'sidebar' ? item.title : item.shortTitle}</span>
          </button>
        );
      })}
    </>
  );
}
