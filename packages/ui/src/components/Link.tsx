import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { cx } from '../lib/cx';
import { isExternalHref, useLinkComponent } from '../lib/link';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children: ReactNode;
  variant?: 'default' | 'subtle' | 'plain';
  /** Show an arrow for links that leave FinancialOS. Defaults to true for external URLs. */
  showExternalIcon?: boolean;
}

/** Router-aware link (the app injects its router link through LinkProvider). External links open safely. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, children, variant = 'default', className, showExternalIcon, ...rest },
  ref,
) {
  const Anchor = useLinkComponent();
  const external = isExternalHref(href);
  const classes = cx('fos-link', `fos-link--${variant}`, className);
  if (external) {
    return (
      <a ref={ref} href={href} className={classes} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        {(showExternalIcon ?? true) && <ArrowUpRight className="fos-link__ext" size={14} aria-hidden="true" />}
        <span className="fos-sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Anchor ref={ref} href={href} className={classes} {...rest}>
      {children}
    </Anchor>
  );
});
