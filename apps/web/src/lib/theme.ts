export type ThemePreference = 'system' | 'light' | 'dark';

const KEY = 'fos-theme';

/** Theme preference is the only thing FinancialOS keeps in localStorage. Never data. */
export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, preference);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  applyTheme(preference);
}

export function applyStoredTheme(): void {
  applyTheme(readThemePreference());
}
