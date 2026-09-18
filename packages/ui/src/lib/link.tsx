import { createContext, forwardRef, useContext, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from 'react';

export interface LinkComponentProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  children?: ReactNode;
}

type LinkComponent = ComponentType<LinkComponentProps & { ref?: React.Ref<HTMLAnchorElement> }>;

const DefaultLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(function DefaultLink(props, ref) {
  return <a ref={ref} {...props} />;
});

const LinkContext = createContext<LinkComponent>(DefaultLink);

/** Lets the app inject a router-aware anchor so design-system links navigate client-side. */
export function LinkProvider({ component, children }: { component: LinkComponent; children: ReactNode }) {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

export function useLinkComponent(): LinkComponent {
  return useContext(LinkContext);
}

/** True for URLs that leave the app (these open with rel="noopener noreferrer"). */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('mailto:');
}
