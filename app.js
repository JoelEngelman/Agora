// GitHub Pages bridge: route Agora API requests to the Cloudflare Worker backend.
const AGORA_API = 'https://agora.joeldavidengelman.workers.dev';
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (url && url.startsWith('/api/')) {
    const target = AGORA_API + url;
    const next = { ...init, credentials: 'include' };

    // The Pages frontend historically sent {email, password}; the API accepts {login, password}.
    if (url === '/api/auth/login' && typeof next.body === 'string') {
      try {
        const body = JSON.parse(next.body);
        if (body.email && !body.login) {
          body.login = body.email;
          delete body.email;
          next.body = JSON.stringify(body);
        }
      } catch {}
    }

    return originalFetch(target, next);
  }
  return originalFetch(input, init);
};
import './public/app.js';
