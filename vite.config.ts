import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
// On GitHub Pages a project site is served from https://<user>.github.io/<repo>/,
// so production builds need a base of '/<repo>/'. The deploy workflow sets
// BASE_PATH; locally `vite dev`/`vite preview` fall back to '/'.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? '/nosplay/' : '/'),
  plugins: [svelte()],
}))
