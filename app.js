// GitHub Pages entrypoint. Route Agora API requests to the Cloudflare Worker backend.
const AGORA_API = 'https://agora.joeldavidengelman.workers.dev';
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url && url.startsWith('/api/')) {
    const target = AGORA_API + url;
    return originalFetch(target, { ...init, credentials: 'include' });
  }
  return originalFetch(input, init);
};
import './public/app.js';
