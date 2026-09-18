import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cx } from '../lib/cx';

export interface StepperStep {
  id: string;
  label: string;
  /** Optional steps are labelled as such. */
  optional?: boolean;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the current step. */
  current: number;
  /** Indices of completed steps (defaults to all before current). */
  completed?: number[];
  label?: string;
  className?: string;
  aside?: ReactNode;
}

/** Wizard progress. Compact "Step 2 of 6" on phones, full list on wider screens. */
export function Stepper({ steps, current, completed, label = 'Progress', className, aside }: StepperProps) {
  const done = new Set(completed ?? steps.map((_, i) => i).filter((i) => i < current));
  const currentStep = steps[current];
  return (
    <nav aria-label={label} className={cx('fos-stepper', className)}>
      <p className="fos-stepper__compact">
        <span className="fos-num">
          Step {current + 1} of {steps.length}
        </span>
        {currentStep && <span className="fos-stepper__compact-label"> · {currentStep.label}</span>}
      </p>
      <div className="fos-stepper__bar" aria-hidden="true">
        {steps.map((s, i) => (
          <span key={s.id} className={cx('fos-stepper__seg', (done.has(i) || i === current) && 'fos-stepper__seg--on')} />
        ))}
      </div>
      <ol className="fos-stepper__list">
        {steps.map((step, i) => {
          const state = done.has(i) ? 'done' : i === current ? 'current' : 'upcoming';
          return (
            <li key={step.id} className={cx('fos-stepper__item', `fos-stepper__item--${state}`)} aria-current={i === current ? 'step' : undefined}>
              <span className="fos-stepper__dot" aria-hidden="true">
                {state === 'done' ? <Check size={12} strokeWidth={3} /> : <span className="fos-num">{i + 1}</span>}
              </span>
              <span className="fos-stepper__label">
                {step.label}
                {step.optional && <span className="fos-stepper__opt"> (optional)</span>}
                <span className="fos-sr-only">{state === 'done' ? ', completed' : state === 'current' ? ', current step' : ''}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {aside}
    </nav>
  );
}
