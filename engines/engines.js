// Both engines run in workers and are only downloaded when first used.
export function shannon() {
  const worker = new Worker(new URL('./shannon/worker.js', import.meta.url), { type: 'module' });
  const waiting = new Map();
  let next = 0;
  worker.onmessage = ({ data: { id, error, ...result } }) => {
    const { resolve, reject } = waiting.get(id);
    waiting.delete(id);
    error ? reject(new Error(error)) : resolve(result);
  };
  worker.onerror = e => { for (const { reject } of waiting.values()) reject(new Error(e.message || 'engine failed to load')); waiting.clear(); };
  return {
    search: (fen, ms, exact = false) => new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      worker.postMessage({ id: next, fen, ms, exact });
    }),
    stop: () => worker.terminate(),
  };
}

// Stockfish's own limiter starts at 1320 Elo. The gentler levels instead look a few moves ahead and then
// choose loosely among the best candidates: the higher `loose` (in centipawns), the more often a worse one.
export const LEVELS = {
  beginner: { name: 'Beginner', loose: 320 },
  easy: { name: 'Easy', loose: 180 },
  1320: { name: 'Medium (about 1320)', elo: 1320 },
  1600: { name: 'Club player (about 1600)', elo: 1600 },
  1900: { name: 'Strong (about 1900)', elo: 1900 },
  2300: { name: 'Master (about 2300)', elo: 2300 },
  full: { name: 'Full strength' },
};

export function pickLoosely(lines, loose, random = Math.random()) {
  const weights = lines.map(l => Math.exp((l.value - lines[0].value) / loose));
  let left = random * weights.reduce((a, b) => a + b, 0);
  return lines[Math.max(0, weights.findIndex(w => (left -= w) < 0))].pv[0];
}

// Handles one request at a time.
export function stockfish() {
  const worker = new Worker(new URL('./stockfish/stockfish-19-lite-single.js', import.meta.url));
  let job = null, fail, ready;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});
  const started = new Promise(r => { ready = r; });
  worker.onerror = e => fail(new Error(e.message || 'engine failed to load'));
  worker.onmessage = ({ data: line }) => {
    if (line === 'readyok') ready();
    if (!job) return;
    const m = /^info .*\bdepth (\d+).* multipv (\d+) score (cp|mate) (-?\d+)\b(?! (?:lower|upper)bound).* pv (.+)$/.exec(line);
    if (m) {
      const n = +m[4]; // from the side to move
      job.lines[m[2] - 1] = { kind: m[3], n, value: m[3] === 'cp' ? n : n > 0 ? 10000 - n : -10000 - n, depth: +m[1], pv: m[5].trim().split(' ') };
    } else if (line.startsWith('bestmove')) {
      const { lines, resolve } = job;
      job = null;
      resolve({ best: line.split(' ')[1], lines: lines.filter(Boolean) });
    }
  };
  worker.postMessage('uci');
  worker.postMessage('isready');
  async function run(fen, options, go) {
    await Promise.race([started, failed]);
    return Promise.race([failed, new Promise(resolve => {
      job = { lines: [], resolve };
      for (const [k, v] of Object.entries(options)) worker.postMessage(`setoption name ${k} value ${v}`);
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go ${go}`);
    })]);
  }
  return {
    // Scores are from White's side: {cp} or {mate} (moves; negative = Black mates).
    analyse: async (fen, depth, ms) => {
      const { lines: [top] } = await run(fen, {}, `depth ${depth} movetime ${ms}`);
      if (!top) throw new Error('no analysis');
      return { [top.kind]: top.n * (fen.split(' ')[1] === 'w' ? 1 : -1), depth: top.depth, pv: top.pv };
    },
    // The move to play at one of LEVELS, like "e2e4".
    play: async (fen, level) => {
      const { loose, elo } = LEVELS[level];
      const { best, lines } = await run(fen, { UCI_LimitStrength: !!elo, UCI_Elo: elo || 1320, MultiPV: loose ? 12 : 1 }, loose ? 'depth 4' : 'movetime 1000');
      return loose && lines.length ? pickLoosely(lines, loose) : best;
    },
    stop: () => worker.terminate(),
  };
}
