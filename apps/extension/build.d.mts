/**
 * Types for the build script's exported helpers, so the manifest and output-policy tests can use
 * them from TypeScript. The build itself is plain ESM with no build step of its own.
 */

export interface ExtensionManifest {
  manifest_version: number;
  name: string;
  short_name?: string;
  version: string;
  description?: string;
  minimum_chrome_version?: string;
  icons?: Record<string, string>;
  chrome_url_overrides?: Record<string, string>;
  options_page?: string;
  incognito?: string;
  permissions?: string[];
  optional_host_permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  externally_connectable?: { ids?: string[] };
  key?: string;
  [key: string]: unknown;
}

export const REQUIRED_PERMISSIONS: string[];
export const OPTIONAL_HOST_PERMISSIONS: string[];
export const ICON_SIZES: number[];
export const ALLOWED_URL_LITERALS: RegExp[];

export function isAllowedUrlLiteral(literal: string): boolean;
export function extensionIdFromPublicKey(publicKeyBase64: string): string;
export function parseCsp(policy: string): Map<string, string[]>;
export function checkManifest(manifest: unknown): string[];
export function createManifest(template: unknown, options: { version: string }): ExtensionManifest;
export function scanJs(text: string): string[];
export function scanHtml(text: string): string[];
export function scanCss(text: string): string[];
export function scanSvg(text: string): string[];
export function createDeterministicZip(distDir: string): Promise<Uint8Array>;
