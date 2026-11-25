// Serves chess.alemi.family from the GitHub Pages copy, so a push updates both addresses.
const BASE = 'https://alexalemi.com/tools';
const FILES = { '/': '/chess.html', '/turn.js': '/turn.js', '/words.js': '/words.js' };
const ENGINE_FILE = /^\/engines(\/[\w-][\w.-]*)+$/;

export default {
  async fetch(request) {
    const url = new URL(request.url), { pathname } = url;
    if (url.protocol === 'http:' && url.hostname === 'chess.alemi.family') {
      url.protocol = 'https:'; // browsers only allow the crypto the game needs over https
      return Response.redirect(url.href, 301);
    }
    if (pathname === '/chess.html' || pathname === '/index.html') {
      return Response.redirect(new URL('/', request.url).href, 302);
    }
    const file = Object.hasOwn(FILES, pathname) ? FILES[pathname] : ENGINE_FILE.test(pathname) ? pathname : null;
    if (!file) return new Response('not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
    const headers = new Headers();
    for (const h of ['If-None-Match', 'If-Modified-Since']) {
      if (request.headers.has(h)) headers.set(h, request.headers.get(h));
    }
    try {
      return await fetch(BASE + file, { method: request.method, headers });
    } catch (e) {
      console.error(JSON.stringify({ message: 'origin unreachable', pathname, error: String(e) }));
      return new Response('Chess is temporarily unavailable.', { status: 502 });
    }
  },
};
