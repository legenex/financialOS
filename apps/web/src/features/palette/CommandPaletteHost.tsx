import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Building2,
  CalendarPlus,
  Eye,
  FileText,
  FileUp,
  Flag,
  Landmark,
  Lock,
  Moon,
  Receipt,
  Search as SearchIcon,
  Settings2,
  Target,
  User,
  Wallet,
} from 'lucide-react';
import { CommandPalette, usePrivacy, type CommandGroup } from '@financialos/ui';
import { usePalette } from '../../app/palette';
import { CONNECTIONS, PRIMARY, SECONDARY, SETTINGS_PAGES } from '../../app/shell/nav';
import { withContext } from '../../lib/context';
import { useSearch } from '../../lib/endpoints';
import { useDebounced } from '../../lib/hooks';
import { internalHref } from '../../lib/links';
import { useSession } from '../../lib/session';
import { readThemePreference, writeThemePreference } from '../../lib/theme';

const SEARCH_ICONS = {
  account: <Wallet size={16} />,
  transaction: <Receipt size={16} />,
  entity: <Building2 size={16} />,
  goal: <Target size={16} />,
  connection: <Landmark size={16} />,
  page: <FileText size={16} />,
  exception: <Flag size={16} />,
  document: <FileText size={16} />,
} as const;

/** Ctrl/Cmd+K: jump anywhere, search records (server-side), and run quick actions. */
export function CommandPaletteHost() {
  const { open, setOpen } = usePalette();
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const privacy = usePrivacy();
  const { logout } = useSession();
  const debounced = useDebounced(search, 250);
  const results = useSearch(open ? debounced : '');

  const go = (path: string) => navigate(withContext(path, params));

  const groups: CommandGroup[] = (() => {
    const nav: CommandGroup = {
      id: 'nav',
      heading: 'Go to',
      items: [...PRIMARY, CONNECTIONS, ...SECONDARY].map((d) => {
        const Icon = d.icon;
        return { id: d.id, label: d.label, hint: d.description, icon: <Icon size={16} />, onSelect: () => go(d.path) };
      }),
    };
    const planPages: CommandGroup = {
      id: 'plan',
      heading: 'Plan',
      items: [
        { id: 'budget', label: 'Budget', path: '/plan/budget' },
        { id: 'goals', label: 'Goals & reserves', path: '/plan/goals' },
        { id: 'commitments', label: 'Commitments', path: '/plan/commitments' },
        { id: 'subscriptions', label: 'Subscriptions', path: '/plan/subscriptions' },
        { id: 'simulator', label: 'Purchase simulator', path: '/plan/simulator' },
      ].map((p) => ({ id: p.id, label: p.label, icon: <Target size={16} />, keywords: ['plan'], onSelect: () => go(p.path) })),
    };
    const settings: CommandGroup = {
      id: 'settings',
      heading: 'Settings',
      items: SETTINGS_PAGES.map((p) => ({ id: p.id, label: p.label, icon: <Settings2 size={16} />, keywords: ['settings', 'preferences'], onSelect: () => go(p.path) })),
    };
    const actions: CommandGroup = {
      id: 'actions',
      heading: 'Actions',
      items: [
        { id: 'import', label: 'Import a file', hint: 'Upload a statement or export', icon: <FileUp size={16} />, keywords: ['upload', 'csv', 'statement'], onSelect: () => go('/imports/new') },
        { id: 'goal', label: 'Add a goal', icon: <Target size={16} />, keywords: ['reserve', 'saving'], onSelect: () => go('/plan/goals?new=1') },
        { id: 'review', label: 'Start a weekly review', icon: <CalendarPlus size={16} />, keywords: ['coach', 'review'], onSelect: () => go('/coach/reviews?start=weekly') },
        {
          id: 'privacy',
          label: privacy.masked ? 'Show amounts' : 'Hide amounts',
          hint: 'Privacy mask for this session',
          icon: <Eye size={16} />,
          keywords: ['privacy', 'mask'],
          onSelect: () => privacy.toggle(),
        },
        {
          id: 'theme',
          label: 'Switch theme',
          hint: 'Cycle automatic, light and dark',
          icon: <Moon size={16} />,
          keywords: ['dark', 'light', 'appearance'],
          onSelect: () => {
            const order = ['system', 'light', 'dark'] as const;
            const current = readThemePreference();
            writeThemePreference(order[(order.indexOf(current) + 1) % order.length]!);
          },
        },
        { id: 'lock', label: 'Lock now', hint: 'Sign out of this session on every tab', icon: <Lock size={16} />, keywords: ['sign out', 'logout'], onSelect: () => void logout() },
      ],
    };
    const found = results.data?.items ?? [];
    const searchGroup: CommandGroup = {
      id: 'search',
      heading: 'Search results',
      forceMount: true,
      items: found.map((r) => ({
        id: `${r.kind}-${r.id}`,
        label: r.title,
        hint: r.subtitle ?? undefined,
        icon: SEARCH_ICONS[r.kind] ?? <User size={16} />,
        onSelect: () => navigate(internalHref(r.href)),
      })),
    };
    return [searchGroup, actions, nav, planPages, settings];
  })();

  const term = debounced.trim();
  const status =
    term.length >= 2 && results.isError
      ? 'Record search is unavailable right now. Navigation and actions still work.'
      : term.length === 1
        ? 'Type at least two characters to search records.'
        : undefined;

  return (
    <CommandPalette
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
      groups={groups}
      search={search}
      onSearchChange={setSearch}
      loading={term.length >= 2 && results.isFetching}
      status={
        status ?? (
          <span className="inline-flex items-center gap-1">
            <SearchIcon size={12} aria-hidden="true" /> Search accounts, transactions, goals and more
          </span>
        )
      }
    />
  );
}
