export interface ServiceWorkerEnv {
  production: boolean;
  navigator?: Navigator;
  isSecureContext?: boolean;
}

/**
 * Registers the shell-only service worker. Guarded: production builds only, secure contexts only, and only
 * when the browser supports service workers. Returns whether registration was attempted.
 */
export function registerServiceWorker(env: ServiceWorkerEnv = { production: import.meta.env.PROD }): boolean {
  const nav = env.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
  const secure = env.isSecureContext ?? (typeof window !== 'undefined' && window.isSecureContext);
  if (!env.production || !nav || !secure || !('serviceWorker' in nav)) return false;
  const register = () => {
    nav.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      console.warn('Service worker registration failed', error);
    });
  };
  if (typeof document !== 'undefined' && document.readyState !== 'complete') {
    window.addEventListener('load', register, { once: true });
  } else {
    register();
  }
  return true;
}
