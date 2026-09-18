/** Release version string. Injected at build time; falls back to the package version. */
declare const __FOS_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __FOS_VERSION__ === 'string' ? __FOS_VERSION__ : '0.1.0';
