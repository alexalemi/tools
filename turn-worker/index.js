// Hands out short-lived Cloudflare TURN credentials, so the long-lived key never reaches the browser.
// The Origin check only stops other *websites*: a script can forge it, hence the rate limit.
const allowed = origin => ['https://alexalemi.com', 'https://chess.alemi.family'].includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!allowed(origin)) return new Response('forbidden', { status: 403 });
    const headers = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers });

    const { success } = await env.LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return new Response('slow down', { status: 429, headers });

    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID.trim()}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (res.ok) return Response.json(await res.json(), { headers });
      // Describes the secrets' shape (never their values) so a mis-pasted key can be spotted in the logs.
      const shape = v => ({ length: v.length, hex: /^[0-9a-f]+$/.test(v), trimmed: v === v.trim() });
      console.error(JSON.stringify({
        message: 'TURN API error', status: res.status, body: (await res.text()).slice(0, 200),
        id: shape(env.TURN_KEY_ID), token: shape(env.TURN_KEY_API_TOKEN),
      }));
    } catch (e) {
      console.error(JSON.stringify({ message: 'TURN API unreachable', error: String(e) }));
    }
    return new Response('TURN unavailable', { status: 502, headers });
  },
};
