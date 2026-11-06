// Apply the saved theme before first paint on every app page.
// The page and iOS PWA chrome must start with the same background.
(() => {
  const root = document.documentElement;
  let mode;
  try {
    const stored = localStorage.getItem('fh-theme');
    if (stored === 'dark' || stored === 'light') mode = stored;
  } catch {
    // Private browsing can block localStorage; use the system color scheme.
  }
  if (!mode) mode = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
  root.dataset.theme = mode;
  const meta = document.getElementById('theme-color');
  if (meta) meta.content = mode === 'dark' ? '#172336' : '#ffffff';
})();
