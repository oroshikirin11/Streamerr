import { sveltekit } from '@sveltejs/kit/vite';

// `npm run dev` talks to the real backend so the UI is developed against
// live data rather than mocks. JSR_API points it at a different instance
// (e.g. a test box with auth disabled) without editing this file.
const api = process.env.JSR_API ?? 'http://localhost:8099';

export default {
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
};
