import { useState } from 'react';
import { Eye, EyeOff, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { IconButton, SegmentedControl, usePrivacy } from '@financialos/ui';
import { readThemePreference, writeThemePreference, type ThemePreference } from '../../lib/theme';
import { useSession } from '../../lib/session';

export function PrivacyToggle() {
  const { masked, toggle } = usePrivacy();
  return (
    <IconButton
      label={masked ? 'Show amounts' : 'Hide amounts'}
      icon={masked ? <EyeOff size={20} /> : <Eye size={20} />}
      onClick={toggle}
      aria-pressed={masked}
    />
  );
}

export function useThemePreference(): [ThemePreference, (t: ThemePreference) => void] {
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());
  return [
    theme,
    (next) => {
      writeThemePreference(next);
      setTheme(next);
    },
  ];
}

export function ThemeSwitcher({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const [theme, setTheme] = useThemePreference();
  return (
    <SegmentedControl<ThemePreference>
      label="Theme"
      size={size}
      value={theme}
      onValueChange={setTheme}
      fullWidth
      options={[
        { value: 'system', label: <span className="inline-flex items-center gap-1"><Monitor size={14} aria-hidden="true" />Auto</span> },
        { value: 'light', label: <span className="inline-flex items-center gap-1"><Sun size={14} aria-hidden="true" />Light</span> },
        { value: 'dark', label: <span className="inline-flex items-center gap-1"><Moon size={14} aria-hidden="true" />Dark</span> },
      ]}
    />
  );
}

export function SignOutButton({ variant = 'icon' }: { variant?: 'icon' | 'full' }) {
  const { logout } = useSession();
  const [pending, setPending] = useState(false);
  const run = async () => {
    setPending(true);
    try {
      await logout();
    } finally {
      setPending(false);
    }
  };
  if (variant === 'full') {
    return (
      <button type="button" className="fos-btn fos-btn--secondary fos-btn--md fos-btn--full" onClick={run} disabled={pending}>
        <LogOut size={16} aria-hidden="true" />
        <span>Sign out</span>
      </button>
    );
  }
  return <IconButton label="Sign out" icon={<LogOut size={18} />} onClick={run} loading={pending} size="sm" />;
}
