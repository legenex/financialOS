/**
 * Minimal DOM builder. Text is always set through textContent; attribute names that could run
 * code or inject styles are refused, and links may only point at an http(s) URL or a page that
 * ships inside this extension.
 */

export type Child = Node | string | null | undefined | false;

export interface ElementProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string | undefined>;
}

const FORBIDDEN_ATTRIBUTE = /^(?:on|style$|srcdoc$|formaction$)/i;
const EXTENSION_PAGE = /^[a-z]+\.html$/;

export function assertSafeHref(href: string): void {
  if (EXTENSION_PAGE.test(href)) return;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error('link target is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('link target must be http(s)');
  if (url.username || url.password) throw new Error('link target must not carry credentials');
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined) continue;
    if (FORBIDDEN_ATTRIBUTE.test(name)) throw new Error(`attribute ${name} is not allowed`);
    if (name === 'href') assertSafeHref(value);
    node.setAttribute(name, value);
  }
  if (props.text !== undefined) node.textContent = props.text;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export function link(href: string, props: ElementProps = {}, children: Child[] = []): HTMLAnchorElement {
  return el('a', { ...props, attrs: { ...props.attrs, href } }, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(
  paths: readonly string[],
  options: { size?: number; class?: string; label?: string } = {},
): SVGSVGElement {
  const size = String(options.size ?? 20);
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('width', size);
  root.setAttribute('height', size);
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', '1.6');
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  root.setAttribute('class', options.class ? `icon ${options.class}` : 'icon');
  if (options.label) {
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', options.label);
  } else {
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    root.append(path);
  }
  return root;
}
