// TURN relays, for players whose networks can't connect directly. See turn-worker/.
const TURN_URL = 'https://turn-credentials.alexalemi.workers.dev';

// Resolves to [] on any failure: direct connections still work without TURN.
export async function turnServers() {
  if (!TURN_URL) return [];
  try {
    const res = await fetch(TURN_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers } = await res.json();
    return iceServers.filter(s => s.username)
      .map(s => ({ ...s, urls: [s.urls].flat().filter(u => !/:53(\?|$)/.test(u)) })); // browsers block port 53
  } catch (e) {
    console.warn('no TURN servers:', e);
    return [];
  }
}
