import { Briefcase, CalendarCheck2, Compass, Inbox, MessagesSquare, Plug, Server, Settings, Upload, Wallet, type LucideIcon } from 'lucide-react';

export interface Destination {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
}

/** The five main destinations, in order. */
export const PRIMARY: Destination[] = [
  { id: 'today', label: 'Today', path: '/today', icon: CalendarCheck2, description: 'Safe to spend, commitments and next actions' },
  { id: 'plan', label: 'Plan', path: '/plan', icon: Compass, description: 'Budgets, goals, commitments and the simulator' },
  { id: 'money', label: 'Money', path: '/money', icon: Wallet, description: 'Accounts, transactions and investments' },
  { id: 'business', label: 'Business', path: '/business', icon: Briefcase, description: 'Entities, cash forecast and clearing' },
  { id: 'coach', label: 'Coach', path: '/coach', icon: MessagesSquare, description: 'Grounded answers and reviews' },
];

export const CONNECTIONS: Destination = {
  id: 'connections',
  label: 'Connections',
  path: '/connections',
  icon: Plug,
  description: 'Connect banks, brokers, files and AI',
};

export const SECONDARY: Destination[] = [
  { id: 'inbox', label: 'Inbox', path: '/inbox', icon: Inbox, description: 'Exceptions that need a decision' },
  { id: 'imports', label: 'Imports', path: '/imports', icon: Upload, description: 'Statement and export files' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: Settings, description: 'Preferences, security and automation' },
  { id: 'system', label: 'System', path: '/system', icon: Server, description: 'Deployment, backups and health' },
];

/** Settings sub-pages (implemented by the feature agent under /settings/*). */
export const SETTINGS_PAGES: Array<{ id: string; label: string; path: string }> = [
  { id: 'general', label: 'General & budget preferences', path: '/settings/general' },
  { id: 'security', label: 'Security & sessions', path: '/settings/security' },
  { id: 'ai', label: 'AI & agents', path: '/settings/ai' },
  { id: 'alerts', label: 'Alerts & notifications', path: '/settings/alerts' },
  { id: 'automations', label: 'Automation schedules', path: '/settings/automations' },
  { id: 'extension', label: 'Extension pairing', path: '/settings/extension' },
  { id: 'backups', label: 'Backups', path: '/settings/backups' },
  { id: 'templates', label: 'Import templates', path: '/settings/import-templates' },
];

export function isActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}
