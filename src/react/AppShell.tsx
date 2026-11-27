import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Navigation, type FinanceView, type NavigationVariant } from './Navigation';
import { Toolbar, type ToolbarProps } from './Toolbar';

/** React owns only the contents of the existing three shell containers. */
export function AppShell({
  view,
  variant,
  budgetsEnabled = false,
  goalsEnabled = false,
}: {
  view: FinanceView;
  variant: NavigationVariant;
  budgetsEnabled?: boolean;
  goalsEnabled?: boolean;
}) {
  return (
    <Navigation
      view={view}
      variant={variant}
      budgetsEnabled={budgetsEnabled}
      goalsEnabled={goalsEnabled}
    />
  );
}

export function createAppShellRoots(
  sidebar: HTMLElement,
  bottom: HTMLElement,
  header: HTMLElement,
) {
  if (new Set([sidebar, bottom, header]).size !== 3) {
    throw new Error('Distinct shell roots required');
  }
  // Static HTML remains for first paint and older installed PWAs.
  // Replace it before React takes exclusive ownership.
  sidebar.replaceChildren();
  bottom.replaceChildren();
  header.replaceChildren();
  const desktop = createRoot(sidebar);
  const mobile = createRoot(bottom);
  const toolbar = createRoot(header);
  let mounted = true;
  return {
    render(view: FinanceView, options: ToolbarProps) {
      if (!mounted) throw new Error('Cannot render unmounted shell');
      flushSync(() => {
        desktop.render(
          <StrictMode>
            <AppShell
              view={view}
              variant="sidebar"
              budgetsEnabled={options.budgetsEnabled}
              goalsEnabled={options.goalsEnabled}
            />
          </StrictMode>,
        );
        mobile.render(
          <StrictMode>
            <AppShell
              view={view}
              variant="bottom"
              budgetsEnabled={options.budgetsEnabled}
              goalsEnabled={options.goalsEnabled}
            />
          </StrictMode>,
        );
        toolbar.render(
          <StrictMode>
            <Toolbar {...options} />
          </StrictMode>,
        );
      });
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      desktop.unmount();
      mobile.unmount();
      toolbar.unmount();
    },
  };
}
