import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiAssets = path.resolve(here, '../../packages/ui/assets');
const API_ORIGIN = 'http://127.0.0.1:3180';

/** Identity assets live in packages/ui/assets (shared with the extension). Serve/emit them under /icons/. */
function identityAssets(): Plugin {
  const files = () => readdirSync(uiAssets).filter((f) => /\.(png|svg|ico)$/.test(f));
  const types: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  return {
    name: 'fos-identity-assets',
    configureServer(server) {
      server.middlewares.use('/icons', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, ''));
        if (!files().includes(name)) return next();
        res.setHeader('Content-Type', types[path.extname(name)] ?? 'application/octet-stream');
        res.end(readFileSync(path.join(uiAssets, name)));
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({ type: 'asset', fileName: `icons/${name}`, source: readFileSync(path.join(uiAssets, name)) });
      }
    },
  };
}

/**
 * Stamps the service worker with a build version and the app-shell precache list. The worker itself is plain
 * JS in public/sw.js; only two marked literals are replaced.
 */
function serviceWorkerManifest(): Plugin {
  let outDir = 'dist';
  const shell: string[] = [];
  return {
    name: 'fos-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        // Fonts are cached on first use; everything else in the shell is precached.
        if (/\.(js|css|png|svg|ico|webmanifest)$/.test(fileName)) shell.push(`/${fileName}`);
      }
    },
    writeBundle() {
      const swPath = path.join(outDir, 'sw.js');
      const version = `${Date.now().toString(36)}`;
      const precache = ['/', '/index.html', '/manifest.webmanifest', ...shell.filter((f) => !f.endsWith('sw.js'))];
      const source = readFileSync(swPath, 'utf8')
        .replace(/\/\*__FOS_VERSION__\*\/'[^']*'/, `'${version}'`)
        .replace(/\/\*__FOS_PRECACHE__\*\/\[\]/, JSON.stringify([...new Set(precache)]));
      writeFileSync(swPath, source);
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), identityAssets(), serviceWorkerManifest()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsDir: 'assets',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Dev only: the built app is served by the API process (D-001).
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false, ws: false },
      '/launch': { target: API_ORIGIN, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: false },
      '/launch': { target: API_ORIGIN, changeOrigin: false },
    },
  },
});
