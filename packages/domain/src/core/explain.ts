/**
 * Helpers that build contract `Explanation`, `ExplanationItem` and `SourceLink` values consistently, plus
 * exception descriptors for the single exception inbox. Every computed figure in the engine should be
 * explainable through these.
 */
import type { Explanation, ExplanationItem, FxProvenance, Money, SourceLink } from '@financialos/contracts';
import type { ExceptionDescriptor, ExceptionSeverity } from './types';
import type { ExceptionKind } from '@financialos/contracts';

export type SourceLinkKind = SourceLink['kind'];
export type ExplanationRole = ExplanationItem['role'];

export function sourceLink(kind: SourceLinkKind, id: string, label: string): SourceLink {
  return { kind, id, label };
}

export const accountLink = (id: string, label: string): SourceLink => sourceLink('account', id, label);
export const transactionLink = (id: string, label: string): SourceLink => sourceLink('transaction', id, label);
export const snapshotLink = (id: string, label: string): SourceLink => sourceLink('snapshot', id, label);
export const arrangementLink = (id: string, label: string): SourceLink => sourceLink('arrangement', id, label);

export interface ExplanationItemOptions {
  note?: string | null;
  links?: readonly SourceLink[];
  fx?: FxProvenance | null;
}

export function explanationItem(
  label: string,
  role: ExplanationRole,
  value: Money | null,
  options: ExplanationItemOptions = {},
): ExplanationItem {
  const item: ExplanationItem = {
    label,
    value: value ? { amount: value.amount, currency: value.currency } : null,
    role,
    note: options.note ?? null,
    links: dedupeLinks(options.links ?? []),
  };
  if (options.fx !== undefined) item.fx = options.fx;
  return item;
}

export const inputItem = (label: string, value: Money | null, options?: ExplanationItemOptions) => explanationItem(label, 'input', value, options);
export const addedItem = (label: string, value: Money | null, options?: ExplanationItemOptions) => explanationItem(label, 'added', value, options);
export const subtractedItem = (label: string, value: Money | null, options?: ExplanationItemOptions) =>
  explanationItem(label, 'subtracted', value, options);
export const excludedItem = (label: string, value: Money | null, options?: ExplanationItemOptions) =>
  explanationItem(label, 'excluded', value, options);
export const assumptionItem = (label: string, options?: ExplanationItemOptions) => explanationItem(label, 'assumption', null, options);
export const missingItem = (label: string, options?: ExplanationItemOptions) => explanationItem(label, 'missing', null, options);
export const resultItem = (label: string, value: Money | null, options?: ExplanationItemOptions) => explanationItem(label, 'result', value, options);

/** Removes duplicate links (same kind and id), keeping the first occurrence and the original order. */
export function dedupeLinks(links: readonly SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const link of links) {
    const key = `${link.kind}\u0000${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: link.kind, id: link.id, label: link.label });
  }
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

export interface ExplanationParts {
  summary: string;
  formula: string;
  items?: readonly ExplanationItem[];
  assumptions?: readonly string[];
  missing?: readonly string[];
}

/** Builds an Explanation; assumption and missing lists are de-duplicated with order preserved. */
export function buildExplanation(parts: ExplanationParts): Explanation {
  return {
    summary: parts.summary,
    formula: parts.formula,
    items: [...(parts.items ?? [])],
    assumptions: uniqueStrings(parts.assumptions ?? []),
    missing: uniqueStrings(parts.missing ?? []),
  };
}

/**
 * Incremental explanation builder. Methods return the builder so calls can be chained; `build()` returns a
 * fresh object each time, so a builder can be reused without aliasing.
 */
export class ExplanationBuilder {
  private readonly items: ExplanationItem[] = [];
  private readonly assumptions: string[] = [];
  private readonly missingNotes: string[] = [];

  constructor(
    private summary: string,
    private formula: string,
  ) {}

  setSummary(summary: string): this {
    this.summary = summary;
    return this;
  }

  setFormula(formula: string): this {
    this.formula = formula;
    return this;
  }

  item(item: ExplanationItem): this {
    this.items.push(item);
    return this;
  }

  input(label: string, value: Money | null, options?: ExplanationItemOptions): this {
    return this.item(inputItem(label, value, options));
  }

  added(label: string, value: Money | null, options?: ExplanationItemOptions): this {
    return this.item(addedItem(label, value, options));
  }

  subtracted(label: string, value: Money | null, options?: ExplanationItemOptions): this {
    return this.item(subtractedItem(label, value, options));
  }

  excluded(label: string, value: Money | null, options?: ExplanationItemOptions): this {
    return this.item(excludedItem(label, value, options));
  }

  result(label: string, value: Money | null, options?: ExplanationItemOptions): this {
    return this.item(resultItem(label, value, options));
  }

  /** Adds an assumption both as a list entry and (when `asItem`) as an explanation line. */
  assume(text: string, asItem = false): this {
    this.assumptions.push(text);
    if (asItem) this.items.push(assumptionItem(text));
    return this;
  }

  /** Records missing data both as a list entry and (when `asItem`) as an explanation line. */
  missing(text: string, asItem = false, options?: ExplanationItemOptions): this {
    this.missingNotes.push(text);
    if (asItem) this.items.push(missingItem(text, options));
    return this;
  }

  get missingCount(): number {
    return uniqueStrings(this.missingNotes).length;
  }

  build(): Explanation {
    return buildExplanation({
      summary: this.summary,
      formula: this.formula,
      items: this.items.map((i) => ({ ...i, links: [...i.links] })),
      assumptions: this.assumptions,
      missing: this.missingNotes,
    });
  }
}

export interface ExceptionDescriptorInput {
  kind: ExceptionKind;
  severity?: ExceptionSeverity;
  title: string;
  detail: string;
  subject: { type: string; id: string | null; label?: string | null };
  entityId?: string | null;
  /** Extra discriminator when one subject can raise several exceptions of the same kind. */
  discriminator?: string | null;
}

/** Builds an exception descriptor with a stable dedupe key: `kind:subjectType:subjectId[:discriminator]`. */
export function exceptionDescriptor(input: ExceptionDescriptorInput): ExceptionDescriptor {
  const parts = [input.kind, input.subject.type, input.subject.id ?? '-'];
  if (input.discriminator) parts.push(input.discriminator);
  return {
    kind: input.kind,
    severity: input.severity ?? 'warning',
    title: input.title,
    detail: input.detail,
    subject: { type: input.subject.type, id: input.subject.id, label: input.subject.label ?? null },
    entityId: input.entityId ?? null,
    dedupeKey: parts.join(':'),
  };
}
