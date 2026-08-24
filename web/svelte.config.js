import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    // SPA mode: one shell, client-side routing, no SSR. The panel is a
    // long-lived control surface talking to a WebSocket, not a content site.
    adapter: adapter({ fallback: 'index.html', pages: 'build', assets: 'build' }),
    prerender: { entries: [] },
  },
};
