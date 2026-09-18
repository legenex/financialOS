/**
 * Planning-side explanation builder. Items and the final object are produced by domain-core's shared helpers
 * (`core/explain`), so links are de-duplicated and assumption/missing lists are normalised the same way
 * everywhere. This adapter only adds the planning conventions: every assumption and every missing-data note is
 * also an explanation line, and missing-data lines may carry the value that could not be used.
 * Not exported from the package index.
 */
import type { Explanation, ExplanationItem, FxProvenance, Money, SourceLink } from '@financialos/contracts';
import { buildExplanation, explanationItem, sourceLink as coreSourceLink, type ExplanationRole, type SourceLinkKind } from '../core/explain';

export type { ExplanationRole, SourceLinkKind };

export function sourceLink(kind: SourceLinkKind, id: string, label: string): SourceLink {
  return coreSourceLink(kind, id, label);
}

export interface ItemOptions {
  note?: string | null;
  links?: readonly SourceLink[];
  fx?: FxProvenance | null;
}

export class ExplanationBuilder {
  private readonly items: ExplanationItem[] = [];
  private readonly assumptionList: string[] = [];
  private readonly missingList: string[] = [];

  constructor(
    private summaryText: string,
    private formulaText: string,
  ) {}

  summary(text: string): this {
    this.summaryText = text;
    return this;
  }

  formula(text: string): this {
    this.formulaText = text;
    return this;
  }

  add(label: string, value: Money | null, role: ExplanationRole, options: ItemOptions = {}): this {
    this.items.push(explanationItem(label, role, value, options));
    return this;
  }

  input(label: string, value: Money | null, options: ItemOptions = {}): this {
    return this.add(label, value, 'input', options);
  }

  subtracted(label: string, value: Money | null, options: ItemOptions = {}): this {
    return this.add(label, value, 'subtracted', options);
  }

  added(label: string, value: Money | null, options: ItemOptions = {}): this {
    return this.add(label, value, 'added', options);
  }

  excluded(label: string, value: Money | null, options: ItemOptions = {}): this {
    return this.add(label, value, 'excluded', options);
  }

  result(label: string, value: Money | null, options: ItemOptions = {}): this {
    return this.add(label, value, 'result', options);
  }

  /** Records an assumption once, both in the assumption list and as a line item. */
  assume(text: string, options: ItemOptions = {}): this {
    if (this.assumptionList.includes(text)) return this;
    this.assumptionList.push(text);
    return this.add(text, null, 'assumption', options);
  }

  /** Records missing data once, both in the missing list and as a line item (optionally with the unusable value). */
  missing(text: string, options: ItemOptions & { value?: Money | null } = {}): this {
    if (this.missingList.includes(text)) return this;
    this.missingList.push(text);
    return this.add(text, options.value ?? null, 'missing', options);
  }

  hasMissing(): boolean {
    return this.missingList.length > 0;
  }

  build(): Explanation {
    return buildExplanation({
      summary: this.summaryText,
      formula: this.formulaText,
      items: this.items.map((item) => ({ ...item, links: [...item.links] })),
      assumptions: this.assumptionList,
      missing: this.missingList,
    });
  }
}
