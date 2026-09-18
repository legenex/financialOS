import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Heading level for the title. */
  level?: 2 | 3 | 4;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  tone?: 'default' | 'sunken' | 'accent';
  as?: 'section' | 'div' | 'article';
}

/** A bordered surface. Use sparingly: most groups should be a Section, not a Card. */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { title, description, actions, footer, level = 2, padding = 'md', tone = 'default', as = 'section', className, children, ...rest },
  ref,
) {
  const Tag = as;
  const Heading = `h${level}` as const;
  return (
    <Tag ref={ref as never} className={cx('fos-card', `fos-card--pad-${padding}`, `fos-card--${tone}`, className)} {...rest}>
      {(title || actions) && (
        <header className="fos-card__header">
          <div className="fos-card__titles">
            {title && <Heading className="fos-card__title">{title}</Heading>}
            {description && <p className="fos-card__description">{description}</p>}
          </div>
          {actions && <div className="fos-card__actions">{actions}</div>}
        </header>
      )}
      <div className="fos-card__body">{children}</div>
      {footer && <footer className="fos-card__footer">{footer}</footer>}
    </Tag>
  );
});

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
  /** Visually hide the heading but keep it for assistive technology. */
  hideTitle?: boolean;
}

/** An unboxed group with a heading. The default way to structure a page. */
export const Section = forwardRef<HTMLElement, SectionProps>(function Section(
  { title, description, actions, level = 2, hideTitle, className, children, id, ...rest },
  ref,
) {
  const Heading = `h${level}` as const;
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section ref={ref} id={id} aria-labelledby={headingId} className={cx('fos-section', className)} {...rest}>
      <header className={cx('fos-section__header', hideTitle && 'fos-sr-only')}>
        <div className="fos-section__titles">
          <Heading id={headingId} className={cx('fos-section__title', level === 3 && 'fos-section__title--sm')}>
            {title}
          </Heading>
          {description && <p className="fos-section__description">{description}</p>}
        </div>
        {actions && <div className="fos-section__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
});

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  className?: string;
}

/** The single h1 of a page, with optional description and actions. */
export function PageHeader({ title, description, actions, eyebrow, meta, className }: PageHeaderProps) {
  return (
    <header className={cx('fos-pagehead', className)}>
      <div className="fos-pagehead__titles">
        {eyebrow && <p className="fos-pagehead__eyebrow">{eyebrow}</p>}
        <h1 className="fos-pagehead__title">{title}</h1>
        {description && <p className="fos-pagehead__description">{description}</p>}
        {meta && <div className="fos-pagehead__meta">{meta}</div>}
      </div>
      {actions && <div className="fos-pagehead__actions">{actions}</div>}
    </header>
  );
}
