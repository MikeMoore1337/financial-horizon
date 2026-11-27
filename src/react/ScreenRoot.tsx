import { StrictMode, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { type CalendarProps } from './Calendar';
import { ConnectedCalendar } from './ConnectedCalendar';
import { type OverviewProps } from './Overview';
import { ConnectedOverview } from './ConnectedOverview';
import { Obligations, type ObligationsProps } from './Obligations';
import { Loans, type LoansProps } from './Loans';
import { Settings, type SettingsProps } from './Settings';
import { AuthBoundary, type AuthAccess } from './AuthBoundary';
import { Accounts, type AccountsProps } from './Accounts';
import { ConnectedAccounts, type ConnectedAccountsProps } from './ConnectedAccounts';
import { OfflineSyncAccounts } from './OfflineSyncAccounts';
import { Budgets } from './Budgets';
import {GoalWorkspace,type GoalWorkspaceProps} from './goals/GoalWorkspace';
import { BankImport, type BankImportProps } from '../importers/bank-statements/BankImport';

export type ScreenView =
  | { view: 'calendar'; props: CalendarProps }
  | { view: 'overview'; props: OverviewProps }
  | { view: 'obligations'; props: ObligationsProps }
  | { view: 'loans'; props: LoansProps }
  | { view: 'settings'; props: SettingsProps }
  | { view: 'accounts'; props: AccountsProps }
  | { view: 'accounts-connected'; props: ConnectedAccountsProps }
  | { view: 'bank-import'; props: BankImportProps }
  | {view:'goals';props:GoalWorkspaceProps}
  | { view: 'budgets'; props: Extract<ComponentProps<typeof Budgets>, { mode: 'guest' }> };

/** Separate local-key entry: never mounts the legacy account or guest ledger. */
export function createOfflineSyncRoot(
  host: HTMLElement,
  actor: string,
  onBack: () => void,
  offlineOnly = true,
  onSessionRevoked?: () => void,
  allowOfflineBudgets = false,
  allowOfflineGoals = false,
) {
  const root = createRoot(host);
  const render = (budgetMode = false,goalMode=false) =>
    flushSync(() =>
      root.render(
        <StrictMode>
          <OfflineSyncAccounts
            actor={actor}
            offlineOnly={offlineOnly}
            budgetMode={budgetMode}
            goalMode={goalMode}
            allowOfflineGoals={allowOfflineGoals}
            allowOfflineBudgets={allowOfflineBudgets}
            onBack={onBack}
            onSessionRevoked={onSessionRevoked}
          />
        </StrictMode>,
      ),
    );
  render();
  return { unmount: () => root.unmount(), setBudgetMode: render };
}

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
                <ConnectedCalendar {...screen.props} />
              ) : screen.view === 'overview' ? (
                <ConnectedOverview {...screen.props} />
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
              ) : screen.view === 'goals' ? (
                <GoalWorkspace {...screen.props}/>
              ) : screen.view === 'budgets' ? (
                <Budgets {...screen.props} />
              ) : screen.view === 'bank-import' ? (
                <BankImport
                  key={screen.props.verifiedActorUserId ?? screen.props.mode}
                  {...screen.props}
                />
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
