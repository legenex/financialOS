// @financialos/ui — FinancialOS design system. Import styles via '@financialos/ui/tokens.css' and
// '@financialos/ui/styles.css'. Usage for every export is documented in docs/ui/COMPONENTS.md.

export { cx } from './lib/cx';
export {
  MASKED_TEXT,
  absDecimal,
  decimalSign,
  formatMoneyValue,
  isDecimalString,
  isKnownMoney,
  moneyText,
  negateDecimal,
  type FormatOptions,
  type MaybeMoneyValue,
  type MoneyValue,
} from './lib/money';
export { PrivacyProvider, usePrivacy } from './lib/privacy';
export { LinkProvider, isExternalHref, useLinkComponent, type LinkComponentProps } from './lib/link';
export { formatDateTime, formatIsoDate, formatRelativeTime } from './lib/time';

export { UiProvider, type UiProviderProps } from './components/UiProvider';
export { Button, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type IconButtonProps } from './components/Button';
export { Link, type LinkProps } from './components/Link';
export { Spinner, type SpinnerProps } from './components/Spinner';
export { Card, PageHeader, Section, type CardProps, type PageHeaderProps, type SectionProps } from './components/Card';
export { Stat, type StatDelta, type StatProps } from './components/Stat';
export { Money, type MoneyProps } from './components/Money';
export { Badge, STATUS_SPECS, StatusBadge, humanize, type BadgeProps, type StatusBadgeProps, type StatusKind, type Tone } from './components/StatusBadge';
export { Freshness, type FreshnessProps, type FreshnessState } from './components/Freshness';
export { ProgressBar, type ProgressBarProps } from './components/ProgressBar';
export {
  EmptyState,
  ErrorState,
  LoadingRegion,
  OfflineState,
  Skeleton,
  type EmptyStateProps,
  type ErrorStateProps,
  type OfflineStateProps,
  type SkeletonProps,
} from './components/States';
export { Dialog, DialogClose, Drawer, type DialogProps, type DrawerProps } from './components/Dialog';
export { SegmentedControl, TabPanel, Tabs, type SegmentedControlProps, type SegmentedOption, type TabItem, type TabsProps } from './components/Tabs';
export {
  Checkbox,
  Combobox,
  RadioGroup,
  Select,
  Switch,
  type CheckboxProps,
  type ComboboxProps,
  type RadioGroupProps,
  type RadioOption,
  type SelectOption,
  type SelectProps,
  type SwitchProps,
} from './components/Choice';
export { DateField, FieldShell, TextArea, TextField, type DateFieldProps, type TextAreaProps, type TextFieldProps } from './components/Field';
export { NumberField, parseDecimalInput, type NumberFieldProps } from './components/NumberField';
export { Tooltip, TooltipProvider, type TooltipProps } from './components/Tooltip';
export { InfoTip, Popover, PopoverClose, type InfoTipProps, type PopoverProps } from './components/Popover';
export { LiveRegion, ToastProvider, useToast, type LiveRegionProps, type ToastInput } from './components/Toast';
export { Table, type TableColumn, type TableProps } from './components/Table';
export { DataList, type DataListItem, type DataListProps } from './components/DataList';
export { KeyValue, type KeyValueItem, type KeyValueProps } from './components/KeyValue';
export { Stepper, type StepperProps, type StepperStep } from './components/Stepper';
export { Callout, type CalloutProps, type CalloutTone } from './components/Callout';
export { CodeBlock, type CodeBlockProps } from './components/CodeBlock';
export { CommandPalette, Kbd, type CommandGroup, type CommandItem, type CommandPaletteProps } from './components/CommandPalette';
export { Logo, LogoMark, type LogoProps } from './components/Logo';

export { AreaTimeline, type AreaTimelineProps, type TimelineEvent } from './charts/AreaTimeline';
export { BarComparison, type BarComparisonProps, type ComparisonRow } from './charts/BarComparison';
export { Donut, type DonutProps, type DonutSegment } from './charts/Donut';
export { Sparkline, type SparklinePoint, type SparklineProps } from './charts/Sparkline';
export { CHART_OTHER, CHART_SLOTS, ChartFrame, ChartLegend, toGeometry, type ChartFrameProps, type LegendEntry } from './charts/shared';
