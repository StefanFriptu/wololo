import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const backend = process.env.WOLOLO_BACKEND ?? 'http://localhost:8585';

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: 'index.html',
        strict: true,
      }),
    }),
  ],
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': { target: backend } },
  },
});
