import init, { Engine } from './shannon_engine.js';
const ready = init({ module_or_path: new URL('./shannon_engine_bg.wasm', import.meta.url) }).then(() => new Engine());

// {id, fen, ms, exact} -> {id, bestMove, score, depth} or {id, error}. `exact` turns off the random choice among near-equal moves.
self.onmessage = async ({ data: { id, fen, ms, exact } }) => {
  try {
    const engine = await ready;
    self.postMessage({ id, ...JSON.parse(engine[exact ? 'findHint' : 'findBestMove'](fen, 12, ms)) });
  } catch (e) { self.postMessage({ id, error: String(e) }); }
};
