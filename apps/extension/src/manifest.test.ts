import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ICON_SIZES,
  OPTIONAL_HOST_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  checkManifest,
  createDeterministicZip,
  createManifest,
  extensionIdFromPublicKey,
  isAllowedUrlLiteral,
  parseCsp,
  scanCss,
  scanHtml,
  scanJs,
  scanSvg,
  type ExtensionManifest,
} from '../build.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = JSON.parse(readFileSync(path.join(appDir, 'manifest.template.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const manifest = createManifest(template, { version: pkg.version });

const withoutKey = (over: Record<string, unknown>): Record<string, unknown> => ({ ...manifest, ...over });

describe('manifest: permissions', () => {
  it('asks for storage and nothing else', () => {
    expect(manifest.permissions).toEqual(['storage']);
    expect(REQUIRED_PERMISSIONS).toEqual(['storage']);
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it('declares no permission this extension must never hold', () => {
    const forbidden = [
      'tabs',
      'history',
      'cookies',
      'webRequest',
      'webNavigation',
      'bookmarks',
      'downloads',
      'management',
      'scripting',
      'debugger',
      'topSites',
      'browsingData',
      'identity',
      'proxy',
      'nativeMessaging',
      'clipboardRead',
      'declarativeNetRequest',
    ];
    for (const permission of forbidden) expect(manifest.permissions).not.toContain(permission);
  });

  it('requests host access only as an optional permission the owner grants per address', () => {
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(OPTIONAL_HOST_PERMISSIONS);
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);
    // No plain-http access to anything but this computer.
    for (const pattern of manifest.optional_host_permissions ?? []) {
      expect(pattern.startsWith('https://') || /^http:\/\/(?:localhost|127\.0\.0\.1)\//.test(pattern)).toBe(true);
    }
    expect(manifest.optional_host_permissions).not.toContain('<all_urls>');
  });
});

describe('manifest: surface', () => {
  it('overrides only the new tab page and ships an options page', () => {
    expect(manifest.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
    expect(manifest.options_page).toBe('options.html');
  });

  it('injects nothing into web pages and runs nothing in the background', () => {
    for (const key of [
      'content_scripts',
      'background',
      'web_accessible_resources',
      'declarative_net_request',
      'devtools_page',
      'side_panel',
      'sandbox',
      'action',
      'commands',
      'update_url',
      'oauth2',
    ]) {
      expect(manifest[key], `${key} must not be declared`).toBeUndefined();
    }
  });

  it('accepts no external messages', () => {
    expect(manifest.externally_connectable).toEqual({ ids: [] });
    expect(manifest.externally_connectable?.ids).toHaveLength(0);
    expect(manifest.externally_connectable).not.toHaveProperty('matches');
  });

  it('is manifest v3, stays out of incognito, and pins its identity with a key', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.incognito).toBe('not_allowed');
    expect(manifest.version).toBe(pkg.version);
    expect(typeof manifest.key).toBe('string');
    expect(extensionIdFromPublicKey(manifest.key as string)).toMatch(/^[a-p]{32}$/);
  });

  it('declares every icon size the build ships', () => {
    for (const size of ICON_SIZES) expect(manifest.icons?.[String(size)]).toBe(`icons/icon-${size}.png`);
  });

  it('matches the extension ID recorded for the server allowlist', () => {
    const recorded = readFileSync(path.join(appDir, 'EXTENSION_ID.txt'), 'utf8').trim();
    expect(recorded).toBe(extensionIdFromPublicKey(manifest.key as string));
  });
});

describe('manifest: content security policy', () => {
  const policy = manifest.content_security_policy?.extension_pages ?? '';
  const csp = parseCsp(policy);

  it('allows scripts only from the package itself', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('style-src')).toEqual(["'self'"]);
    expect(csp.get('img-src')).toEqual(["'self'"]);
    expect(csp.get('font-src')).toEqual(["'self'"]);
  });

  it('never relaxes script execution', () => {
    expect(policy).not.toMatch(
      /unsafe-eval|wasm-unsafe-eval|unsafe-inline|unsafe-hashes|strict-dynamic|nonce-|sha256-/i,
    );
  });

  it('cannot be reframed or made to submit anywhere', () => {
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('allows outbound connections only to https or this computer', () => {
    expect(csp.get('connect-src')).toEqual(['https:', 'http://localhost:*', 'http://127.0.0.1:*']);
  });
});

describe('checkManifest', () => {
  const violates = (over: Record<string, unknown>, pattern: RegExp) => {
    const problems = checkManifest(withoutKey(over));
    expect(problems.join('\n'), JSON.stringify(over)).toMatch(pattern);
  };

  it('passes the real manifest', () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it('rejects every drift it exists to catch', () => {
    violates({ permissions: ['storage', 'tabs'] }, /permissions must be exactly/);
    violates({ optional_host_permissions: ['<all_urls>'] }, /optional_host_permissions drifted/);
    violates({ host_permissions: ['https://*/*'] }, /host_permissions must not be declared/);
    violates({ content_scripts: [{ matches: ['<all_urls>'], js: ['x.js'] }] }, /content_scripts must not be declared/);
    violates({ background: { service_worker: 'sw.js' } }, /background must not be declared/);
    violates({ externally_connectable: { ids: ['*'] } }, /externally_connectable/);
    violates({ chrome_url_overrides: { newtab: 'newtab.html', history: 'h.html' } }, /only the newtab override/);
    violates({ chrome_url_overrides: {} }, /newtab override/);
    violates({ manifest_version: 2 }, /manifest_version must be 3/);
    violates({ key: 'short' }, /key must be/);
    violates(
      {
        content_security_policy: {
          extension_pages:
            "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
      /CSP must not relax script execution/,
    );
    violates(
      {
        content_security_policy: {
          extension_pages:
            "default-src 'self'; script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'; connect-src https://cdn.example.test",
        },
      },
      /connect-src source not allowed/,
    );
  });

  it('refuses a version that is not a plain dotted number', () => {
    for (const version of ['0.1.0-beta', 'latest', '', '1.2.3.4.5']) {
      expect(() => createManifest(template, { version })).toThrow();
    }
    expect(createManifest(template, { version: '1.2.3' }).version).toBe('1.2.3');
  });
});

describe('extensionIdFromPublicKey', () => {
  it('maps the first 128 bits of SHA-256(SPKI) onto a-p', () => {
    // A synthetic key: the derivation is checked against an independent computation of the rule.
    const key = Buffer.alloc(64, 7).toString('base64');
    const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    const expected = [...hex].map((c) => 'abcdefghijklmnop'[Number.parseInt(c, 16)]).join('');
    expect(extensionIdFromPublicKey(key)).toBe(expected);
    expect(extensionIdFromPublicKey(key)).toMatch(/^[a-p]{32}$/);
  });

  it('refuses a missing or truncated key', () => {
    expect(() => extensionIdFromPublicKey('')).toThrow(/init-key/);
    expect(() => extensionIdFromPublicKey(Buffer.alloc(10).toString('base64'))).toThrow();
  });
});

describe('output policy scanners', () => {
  it('fails on eval-like constructs', () => {
    expect(scanJs('const f = eval("1+1")')).toContain('eval(');
    expect(scanJs('const f = new Function("return 1")')).toContain('new Function');
    expect(scanJs('const f = Function("return 1")')).toContain('Function(');
    expect(scanJs('setTimeout("doThing()", 10)')).toContain('string timer');
    expect(scanJs('el.innerHTML = value')).toContain('innerHTML/outerHTML assignment');
    expect(scanJs('el.insertAdjacentHTML("beforeend", x)')).toContain('insertAdjacentHTML');
    expect(scanJs('document.write("hi")')).toContain('document.write');
  });

  it('fails on synced storage and external messaging', () => {
    expect(scanJs('chrome.storage.sync.set({a:1})')).toContain('storage.sync usage');
    expect(scanJs('chrome.runtime.onMessageExternal.addListener(f)')).toContain('external messaging listener');
  });

  it('passes the code this extension actually ships', () => {
    expect(scanJs('const url = new URL(path, origin + "/");')).toEqual([]);
    expect(scanJs('node.textContent = value;')).toEqual([]);
    expect(scanJs('await chrome.storage.local.set({ k: v });')).toEqual([]);
  });

  it('fails only on URL literals that name a reachable third party', () => {
    for (const allowed of [
      'https://',
      'http://',
      'https://.',
      'https://${origin}/api',
      'http://localhost:3180/api',
      'http://127.0.0.1:3180',
      'https://financialos.example.test',
      'https://json-schema.org/draft/2020-12/schema#',
      'http://www.w3.org/2000/svg',
    ]) {
      expect(isAllowedUrlLiteral(allowed), allowed).toBe(true);
      expect(scanJs(`const x = "${allowed}";`), allowed).toEqual([]);
    }
    for (const blocked of [
      'https://cdn.jsdelivr.net/npm/x.js',
      'https://unpkg.com/y',
      'http://198.51.100.9/beacon',
      'https://analytics.example.org/collect',
    ]) {
      expect(isAllowedUrlLiteral(blocked), blocked).toBe(false);
      expect(scanJs(`fetch("${blocked}")`).join(' '), blocked).toMatch(/remote URL literal/);
    }
  });

  it('fails on inline script, inline style and remote references in HTML', () => {
    expect(scanHtml('<script>alert(1)</script>')).toContain('inline script');
    expect(scanHtml('<script src="https://cdn.example.org/a.js"></script>').join(' ')).toMatch(/remote|not local/);
    expect(scanHtml('<div style="color:red"></div>')).toContain('style attribute');
    expect(scanHtml('<button onclick="go()"></button>')).toContain('inline event handler');
    expect(scanHtml('<style>a{}</style>')).toContain('inline <style>');
    expect(scanHtml('<base href="/">')).toContain('<base> element');
    expect(scanHtml('<a href="javascript:alert(1)">x</a>')).toContain('javascript: URL');
  });

  it('fails on SVG that is anything more than a drawing', () => {
    expect(scanSvg('<svg><script>alert(1)</script></svg>')).toContain('script element in SVG');
    expect(scanSvg('<svg><foreignObject></foreignObject></svg>')).toContain('foreignObject in SVG');
    expect(scanSvg('<svg><image href="https://cdn.example.org/a.png"/></svg>').join(' ')).toMatch(
      /external reference|non-local/,
    );
    expect(scanSvg('<svg onload="go()"></svg>')).toContain('inline event handler in SVG');
    expect(scanSvg('<svg><a href="javascript:alert(1)">x</a></svg>')).toContain('javascript: URL in SVG');
    expect(scanSvg('<svg><use xlink:href="other.svg#icon"/></svg>').join(' ')).toMatch(/external reference|non-local/);
    // The mark this package actually ships: a namespace, a gradient reference, nothing else.
    expect(scanSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#tile)"/></svg>')).toEqual([]);
  });

  it('fails on remote CSS references', () => {
    expect(scanCss('@import "https://fonts.example.org/x.css";')).toContain('@import in output CSS');
    expect(scanCss('a{background:url(https://cdn.example.org/i.png)}').join(' ')).toMatch(/non-local/);
    expect(scanCss('a{background:url(//cdn.example.org/i.png)}').join(' ')).toMatch(/non-local/);
    expect(scanCss("@font-face{src:url('/fonts/inter.woff2')}")).toEqual([]);
    expect(scanCss('.a{--fill:50%}')).toEqual([]);
  });

  it('accepts the built output, when a build is present', () => {
    const dist = path.join(appDir, 'dist');
    const built = [
      'newtab.js',
      'options.js',
      'newtab.css',
      'options.css',
      'newtab.html',
      'options.html',
      'icons/mark.svg',
    ];
    for (const file of built) {
      let text: string;
      try {
        text = readFileSync(path.join(dist, file), 'utf8');
      } catch {
        return; // No dist in this working tree; `npm run build -w apps/extension` covers it.
      }
      const scan = file.endsWith('.js')
        ? scanJs
        : file.endsWith('.css')
          ? scanCss
          : file.endsWith('.svg')
            ? scanSvg
            : scanHtml;
      expect(scan(text), file).toEqual([]);
    }
  });
});

describe('createDeterministicZip', () => {
  it('produces byte-identical archives for identical inputs', async () => {
    const make = () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'fos-ext-zip-'));
      writeFileSync(path.join(dir, 'manifest.json'), '{"a":1}\n');
      writeFileSync(path.join(dir, 'newtab.js'), 'export const a = 1;\n');
      return dir;
    };
    const first = await createDeterministicZip(make());
    const second = await createDeterministicZip(make());
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(createHash('sha256').update(second).digest('hex')).toBe(createHash('sha256').update(first).digest('hex'));
  });
});

describe('the built manifest on disk', () => {
  it('is the manifest the policy check approved', () => {
    let built: ExtensionManifest;
    try {
      built = JSON.parse(readFileSync(path.join(appDir, 'dist', 'manifest.json'), 'utf8'));
    } catch {
      return; // No dist in this working tree.
    }
    expect(checkManifest(built)).toEqual([]);
    expect(built).toEqual(manifest);
  });
});
