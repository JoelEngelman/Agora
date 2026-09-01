import backend from './index.js';

const ALLOWED_ORIGIN = 'https://agora-hub.pages.dev';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const response = await backend.fetch(request, env, ctx);
    const headers = new Headers(response.headers);

    for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);

    const cookie = headers.get('Set-Cookie');
    if (cookie) headers.set('Set-Cookie', cookie.replace(/SameSite=Lax/gi, 'SameSite=None'));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
