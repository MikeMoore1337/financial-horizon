import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Calendar, type CalendarProps } from './Calendar';
import { Overview, type OverviewProps } from './Overview';
import { Obligations, type ObligationsProps } from './Obligations';

export type ScreenView =
  | { view: 'calendar'; props: CalendarProps }
  | { view: 'overview'; props: OverviewProps }
  | { view: 'obligations'; props: ObligationsProps };

/** One React owner for any migrated screen, never shared with legacy innerHTML. */
export function createScreenRoot(host: HTMLElement) {
  const root = createRoot(host);
  return {
    render(screen: ScreenView) {
      // Existing delegated handlers and keyboard focus depend on a committed view.
      flushSync(() =>
        root.render(
          <StrictMode>
            {screen.view === 'calendar' ? (
              <Calendar {...screen.props} />
            ) : screen.view === 'overview' ? (
              <Overview {...screen.props} />
            ) : (
              <Obligations {...screen.props} />
            )}
          </StrictMode>,
        ),
      );
    },
    unmount() {
      root.unmount();
    },
  };
}
