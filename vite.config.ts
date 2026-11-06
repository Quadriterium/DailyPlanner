import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      react(),
      {
        name: 'offline-app-shell',
        apply: 'build',
        closeBundle() {
          const root = join('dist', 'client');
          const files = readdirSync(root, { recursive: true })
            .filter((file): file is string => typeof file === 'string' && /\.(js|css|html|svg|png|webmanifest)$/.test(file) && file !== 'sw.js')
            .sort();
          const hash = createHash('sha256');
          files.forEach(file => { hash.update(file); hash.update(readFileSync(join(root, file))); });
          const source = readFileSync(join('pwa', 'service-worker.js'), 'utf8')
            .replace('__VERSION__', hash.digest('hex').slice(0, 20))
            .replace('__PRECACHE__', JSON.stringify(files.map(file => `/${file.replaceAll('\\', '/')}`)));
          writeFileSync(join(root, 'sw.js'), source);
        },
      },
    ],
    build: { outDir: 'dist/client' },
    server: {
      host: env.HOST || '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        // Legal pages are rendered by the API server from the details stored in SQLite.
        '^/(confidentialite|conditions-utilisation)(\\?|$)': `http://127.0.0.1:${env.PORT || 3000}`,
        '/api': {
          target: `http://127.0.0.1:${env.PORT || 3000}`,
          // Hors authentification/admin, le proxy retire Origin pour les écritures locales ; les routes admin le conservent.
          configure: proxy => proxy.on('proxyReq', (request, incoming) => {
            if (incoming.url?.startsWith('/api/admin/') || (incoming.url?.startsWith('/api/auth/') && incoming.headers.origin)) {
              // Admin writes require an Origin; only rewrite the known, local Vite origin.
              const origin = incoming.headers.origin;
              if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
                request.setHeader('origin', env.PUBLIC_ORIGIN || `http://127.0.0.1:${env.PORT || 3000}`);
              }
            } else request.removeHeader('origin');
          }),
        },
      },
    },
  };
});
