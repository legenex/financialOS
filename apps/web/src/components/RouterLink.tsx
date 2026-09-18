import { forwardRef } from 'react';
import { Link } from 'react-router';
import type { LinkComponentProps } from '@financialos/ui';

/** Adapter so design-system links navigate with react-router. */
export const RouterLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function RouterLink({ href, ...rest }, ref) {
  return <Link ref={ref} to={href} {...rest} />;
});
