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

// Analyses one position at a time. Scores are from White's side: {cp} or {mate} (moves; negative = Black mates).
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
    const m = /^info .*\bdepth (\d+).* score (cp|mate) (-?\d+)\b(?! (?:lower|upper)bound).* pv (.+)$/.exec(line);
    if (m) {
      job.result = { [m[2]]: m[3] * (job.fen.split(' ')[1] === 'w' ? 1 : -1), depth: +m[1], pv: m[4].trim().split(' ') };
    } else if (line.startsWith('bestmove')) {
      const { result, resolve, reject } = job;
      job = null;
      result ? resolve(result) : reject(new Error('no analysis'));
    }
  };
  worker.postMessage('uci');
  worker.postMessage('isready');
  return {
    analyse: async (fen, depth, ms) => {
      await Promise.race([started, failed]);
      return Promise.race([failed, new Promise((resolve, reject) => {
        job = { fen, resolve, reject };
        worker.postMessage(`position fen ${fen}`);
        worker.postMessage(`go depth ${depth} movetime ${ms}`);
      })]);
    },
    stop: () => worker.terminate(),
  };
}
