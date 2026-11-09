import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Navigation, type FinanceView, type NavigationVariant } from './Navigation';

/** React owns only the contents of the two existing navigation containers. */
export function AppShell({ view, variant }: { view: FinanceView; variant: NavigationVariant }) {
  return <Navigation view={view} variant={variant} />;
}

export function createAppShellRoots(sidebar: HTMLElement, bottom: HTMLElement) {
  if (sidebar === bottom) throw new Error('Distinct navigation roots required');
  // Replace legacy static buttons before the React roots are created. The original
  // HTML stays present for prior installed PWAs and for first paint.
  sidebar.replaceChildren();
  bottom.replaceChildren();
  const desktop = createRoot(sidebar);
  const mobile = createRoot(bottom);
  let mounted = true;
  return {
    render(view: FinanceView) {
      if (!mounted) throw new Error('Cannot render unmounted navigation');
      flushSync(() => {
        desktop.render(
          <StrictMode>
            <AppShell view={view} variant="sidebar" />
          </StrictMode>,
        );
        mobile.render(
          <StrictMode>
            <AppShell view={view} variant="bottom" />
          </StrictMode>,
        );
      });
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      desktop.unmount();
      mobile.unmount();
    },
  };
}
