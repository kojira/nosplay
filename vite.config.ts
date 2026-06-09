import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

// https://vite.dev/config/
// On GitHub Pages a project site is served from https://<user>.github.io/<repo>/,
// so the deploy workflow sets BASE_PATH='/nosplay/' for production builds.
// Everything else (dev, local `vite build` + `vite preview`) falls back to '/'
// so assets resolve at the server root and previews are genuinely usable.
export default defineConfig(() => ({
  base: process.env.BASE_PATH ?? '/',
  plugins: [svelte()],
  build: {
    rollupOptions: {
      // index.html is the app; svg-smoke.html is the isolated browser smoke
      // test for the Prompt API (see README "SVG smoke test"). Vite serves both
      // in dev automatically, but only emits the listed pages on build.
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        'svg-smoke': resolve(import.meta.dirname, 'svg-smoke.html'),
      },
    },
  },
}))
