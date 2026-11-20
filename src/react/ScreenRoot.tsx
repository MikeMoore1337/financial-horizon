import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Calendar, type CalendarProps } from './Calendar';
import { Overview, type OverviewProps } from './Overview';
import { Obligations, type ObligationsProps } from './Obligations';
import { Loans, type LoansProps } from './Loans';
import { Settings, type SettingsProps } from './Settings';
import { AuthBoundary, type AuthAccess } from './AuthBoundary';
import { Accounts, type AccountsProps } from './Accounts';
import { ConnectedAccounts, type ConnectedAccountsProps } from './ConnectedAccounts';
import { BankImport, type BankImportProps } from '../importers/bank-statements/BankImport';

export type ScreenView =
  | { view: 'calendar'; props: CalendarProps }
  | { view: 'overview'; props: OverviewProps }
  | { view: 'obligations'; props: ObligationsProps }
  | { view: 'loans'; props: LoansProps }
  | { view: 'settings'; props: SettingsProps }
  | { view: 'accounts'; props: AccountsProps }
  | { view: 'accounts-connected'; props: ConnectedAccountsProps }
  | { view: 'bank-import'; props: BankImportProps };

/** One React owner for any migrated screen, never shared with legacy innerHTML. */
export function createScreenRoot(
  host: HTMLElement,
  getAccess: () => AuthAccess = () => ({ kind: 'guest' }),
) {
  const root = createRoot(host);
  return {
    render(screen: ScreenView) {
      // Existing delegated handlers and keyboard focus depend on a committed view.
      flushSync(() =>
        root.render(
          <StrictMode>
            <AuthBoundary access={getAccess()}>
              {screen.view === 'calendar' ? (
                <Calendar {...screen.props} />
              ) : screen.view === 'overview' ? (
                <Overview {...screen.props} />
              ) : screen.view === 'obligations' ? (
                <Obligations {...screen.props} />
              ) : screen.view === 'loans' ? (
                <Loans {...screen.props} />
              ) : screen.view === 'accounts' ? (
                <Accounts key={screen.props.activeProfileId ?? 'locked'} {...screen.props} />
              ) : screen.view === 'accounts-connected' ? (
                <ConnectedAccounts
                  key={screen.props.verifiedActorUserId ?? 'locked'}
                  {...screen.props}
                />
              ) : screen.view === 'bank-import' ? (
                <BankImport key={screen.props.mode === 'account' ?
                  screen.props.verifiedActorUserId ?? 'locked' : 'guest'} {...screen.props} />
              ) : (
                <Settings {...screen.props} />
              )}
            </AuthBoundary>
          </StrictMode>,
        ),
      );
    },
    unmount() {
      root.unmount();
    },
  };
}
