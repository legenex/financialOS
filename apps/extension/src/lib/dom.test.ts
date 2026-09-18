// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { assertSafeHref, el, link, svg } from './dom';
import { ICONS } from './icons';

describe('assertSafeHref', () => {
  it('accepts http(s) URLs and pages that ship inside the extension', () => {
    for (const href of [
      'https://financialos.example.test/launch/today',
      'http://localhost:3180/launch/plan',
      'options.html',
      'newtab.html',
    ]) {
      expect(() => assertSafeHref(href)).not.toThrow();
    }
  });

  it('refuses anything that could run code or carry credentials', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'https://user:secret@financialos.example.test',
      '../../etc/passwd',
      '//evil.example.org',
    ]) {
      expect(() => assertSafeHref(href), href).toThrow();
    }
  });
});

describe('el', () => {
  it('always sets text as text, never as markup', () => {
    const node = el('p', { text: '<img src=x onerror=alert(1)>' });
    expect(node.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(node.querySelector('img')).toBeNull();
    expect(node.children).toHaveLength(0);
  });

  it('refuses attributes that could run code or inject styles', () => {
    for (const name of ['onclick', 'onerror', 'ONLOAD', 'style', 'srcdoc', 'formaction']) {
      expect(() => el('div', { attrs: { [name]: 'x' } }), name).toThrow();
    }
  });

  it('checks href even when it arrives through attrs', () => {
    expect(() => el('a', { attrs: { href: 'javascript:alert(1)' } })).toThrow();
    expect(() => link('javascript:alert(1)')).toThrow();
  });

  it('skips undefined attributes and falsy children', () => {
    const node = el('div', { attrs: { title: undefined } }, [null, undefined, false, 'kept']);
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.textContent).toBe('kept');
  });
});

describe('svg', () => {
  it('draws from static path data and is hidden from assistive technology by default', () => {
    const node = svg(ICONS.check, { size: 16 });
    expect(node.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.querySelectorAll('path')).toHaveLength(ICONS.check.length);
    expect(node.getAttribute('width')).toBe('16');
  });

  it('is labelled when it carries meaning on its own', () => {
    const node = svg(ICONS.lock, { label: 'Hidden' });
    expect(node.getAttribute('role')).toBe('img');
    expect(node.getAttribute('aria-label')).toBe('Hidden');
    expect(node.hasAttribute('aria-hidden')).toBe(false);
  });

  it('ships only path data, with no script or external reference', () => {
    for (const [name, paths] of Object.entries(ICONS)) {
      for (const d of paths) expect(d, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/);
    }
  });
});
