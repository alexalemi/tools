import {
  A, joinRoom, basicSetup, EditorState, Compartment, Annotation, Transaction, EditorView,
  markdown, vim, MarkdownIt, emoji, hljs, DOMPurify, words,
  HighlightStyle, syntaxHighlighting, tags, MatchDecorator, Decoration, ViewPlugin,
} from './lib.js';
import { turnServers } from '../turn.js';

const APP_ID = 'alexalemi-tools/txtpad';
const turnReady = turnServers();
const $ = id => document.getElementById(id);

// Every document starts from this exact change ({text: '', pads: {}}). Peers must share a common
// root: two browsers each creating their own `text` would conflict instead of merging.
const BASE = Uint8Array.from(atob('hW9KgziFaP0AaQEEAAAAAAF845o1Zl4YpeS5Pnx3fsSw62gKdRuWihUz99Hetc9xQgYBAgMCEwIjAkACVgIHFQshAiMDNAFCA1YCgAECfwB/AX8CfwB/AH8HfgRwYWRzBHRleHQCAH4CfwJ+AAQCAAIAAA=='), c => c.charCodeAt(0));

await A.initializeWasm(fetch(new URL('./automerge.wasm', import.meta.url)));

// ---------- Ids: six random words (~77 bits). The id is the only secret protecting a pad. ----------
const ID = /^[a-z]+(-[a-z]+){5}$/;
function newId() {
  const limit = 65536 - (65536 % words.length), buf = new Uint16Array(1), out = [];
  while (out.length < 6) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) out.push(words[buf[0] % words.length]);
  }
  return out.join('-');
}

// ---------- Storage: IndexedDB (localStorage is too small for edit history) ----------
const idb = await new Promise((ok, err) => {
  const r = indexedDB.open('txtpad', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('docs');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => err(r.error);
});
function dbRun(mode, fn) {
  return new Promise((ok, err) => {
    const tx = idb.transaction('docs', mode);
    const out = {};
    fn(tx.objectStore('docs'), out);
    tx.oncomplete = () => ok(out.value);
    tx.onerror = tx.onabort = () => err(tx.error);
  });
}
const dbGet = id => dbRun('readonly', (s, out) => { s.get(id).onsuccess = e => { out.value = e.target.result; }; });

// ---------- Documents ----------
const docs = new Map(); // id -> Promise<Doc>
const bus = new BroadcastChannel('txtpad'); // other tabs in this browser
const tabId = crypto.randomUUID();

class Doc {
  constructor(id, doc) { this.id = id; this.doc = doc; this.listeners = new Set(); this.timer = null; }
  change(fn) { this.set(A.change(this.doc, fn), { local: true }); }
  set(next, { local = false, fromBus = false, stored = false } = {}) {
    const before = A.getHeads(this.doc);
    this.doc = next;
    const after = A.getHeads(next);
    if (before.join() === after.join()) return;
    if (!fromBus) bus.postMessage({ from: tabId, id: this.id, bytes: A.saveSince(next, before) });
    if (!stored) { clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 300); }
    for (const l of this.listeners) l({ local, before, after });
    for (const r of rooms) r.pump(this);
  }
  save() {
    clearTimeout(this.timer); this.timer = null;
    // Merge with what's stored inside one transaction, so tabs can't overwrite each other.
    return dbRun('readwrite', store => {
      store.get(this.id).onsuccess = e => {
        if (e.target.result) this.set(A.loadIncremental(this.doc, e.target.result), { stored: true });
        store.put(A.save(this.doc), this.id);
      };
    }).catch(e => { console.error(e); connNote = 'could not save!'; renderConn(); });
  }
}
function openDoc(id) {
  if (!docs.has(id)) docs.set(id, (async () => {
    const d = new Doc(id, A.load(await dbGet(id) || BASE));
    bus.postMessage({ from: tabId, id, hello: true });
    return d;
  })());
  return docs.get(id);
}
bus.onmessage = async ({ data }) => {
  if (data.from === tabId || !docs.has(data.id)) return;
  const d = await docs.get(data.id);
  if (data.hello) bus.postMessage({ from: tabId, id: d.id, bytes: A.save(d.doc) });
  else d.set(A.loadIncremental(d.doc, data.bytes), { fromBus: true });
};
const flush = () => { for (const p of docs.values()) p.then(d => d.timer && d.save()); };
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.hidden && flush());

// ---------- Peer-to-peer sync ----------
// A room exists per secret. `docIds()` lists what may be offered there: a pad's room carries just that
// pad; the private library room carries your library and all of its pads.
const rooms = new Set();
let connNote = '';
async function sha(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}
async function openRoom(secret, docIds, accepts) {
  const peers = new Map(); // peerId -> Map(docId -> Automerge sync state)
  const roomId = (await sha('txtpad-room:' + secret)).slice(0, 32);
  const conn = joinRoom({ appId: APP_ID, password: secret, identity: 'none', turnConfig: await turnReady }, roomId);
  const action = conn.makeAction('sync');
  const room = {
    peers,
    pump(d) { for (const p of peers.keys()) room.pumpTo(p, d); },
    pumpTo(peerId, d) {
      const states = peers.get(peerId);
      if (!states || !docIds().includes(d.id)) return;
      const [state, msg] = A.generateSyncMessage(d.doc, states.get(d.id) || A.initSyncState());
      states.set(d.id, state);
      if (msg) action.send(msg, { target: peerId, metadata: { id: d.id } }).catch(e => console.warn(e));
    },
    async offerAll() {
      for (const id of docIds()) { const d = await openDoc(id); room.pump(d); }
    },
    close() { rooms.delete(room); return conn.leave(); },
  };
  action.onMessage(async (data, { peerId, metadata }) => {
    const id = metadata?.id;
    if (typeof id !== 'string' || !accepts(id)) return;
    const d = await openDoc(id);
    const states = peers.get(peerId);
    if (!states) return;
    try {
      const [doc, state] = A.receiveSyncMessage(d.doc, states.get(id) || A.initSyncState(), new Uint8Array(data.buffer || data));
      states.set(id, state);
      d.set(doc);
      room.pumpTo(peerId, d);
    } catch (e) { console.warn('bad sync message', e); }
  });
  conn.onPeerJoin(({ peerId }) => { peers.set(peerId, new Map()); connNote = ''; renderConn(); room.offerAll(); });
  conn.onPeerLeave(({ peerId }) => { peers.delete(peerId); renderConn(); });
  conn.onError(e => {
    console.warn('room error', e);
    if (e.code === 'peer-connect-failed') connNote = 'found a peer but couldn’t connect';
    renderConn();
  });
  rooms.add(room);
  return room;
}
function renderConn() {
  let n = 0;
  for (const r of rooms) n += r.peers.size;
  $('dot').className = n ? 'on' : '';
  $('connText').textContent = connNote || (n ? `syncing with ${n}` : navigator.onLine ? 'saved locally' : 'offline · saved locally');
}
addEventListener('online', renderConn);
addEventListener('offline', renderConn);

// ---------- Library: the list of your pads, itself a synced document ----------
const store = localStorage;
if (!ID.test(store['txtpad:library'] || '')) store['txtpad:library'] = newId();
let library, libraryId, libraryRoom;
async function openLibrary(id) {
  libraryId = id;
  library = await openDoc(id);
  // When another device adds a pad, start syncing it too.
  let known = padIds().join();
  library.listeners.add(() => {
    const now = padIds().join();
    if (now !== known) { known = now; libraryRoom?.offerAll(); }
    if ($('padsDlg').open) renderPads();
  });
}
const padIds = () => Object.keys(library.doc.pads).filter(id => ID.test(id));
function joinLibrary() {
  return openRoom(libraryId, () => [libraryId, ...padIds()], id => ID.test(id)).then(r => { libraryRoom = r; });
}
async function linkDevice(id) {
  const old = JSON.parse(JSON.stringify(library.doc.pads));
  await libraryRoom?.close();
  await openLibrary(id);
  library.change(d => { for (const [k, v] of Object.entries(old)) if (!d.pads[k]) d.pads[k] = v; });
  await library.save();
  store['txtpad:library'] = id;
}
function remember(id, title) {
  const cur = library.doc.pads[id];
  // Don't bloat the library's history: only record new titles, or activity once every ten minutes.
  if (cur && cur.title === title && Date.now() - cur.at < 600000) return;
  library.change(d => {
    if (!d.pads[id]) d.pads[id] = { title, at: Date.now() };
    else { if (d.pads[id].title !== title) d.pads[id].title = title; d.pads[id].at = Date.now(); }
  });
}

// ---------- Preview ----------
const md = new MarkdownIt({
  html: true, linkify: true, typographer: true,
  highlight: (code, lang) => (lang && hljs.getLanguage(lang)) ? hljs.highlight(code, { language: lang }).value : '',
}).use(emoji).use(mathPlugin);
md.core.ruler.push('lines', state => {
  for (const t of state.tokens) if (t.level === 0 && t.map && t.nesting >= 0) t.attrSet('data-line', String(t.map[0]));
});

// Emits TeX as escaped text in .mjx elements (the only places MathJax looks), so it survives both
// markdown and sanitizing untouched.
function mathPlugin(md) {
  const esc = md.utils.escapeHtml;
  const closed = (src, pos, open, close) => {
    let i = pos + open.length;
    while ((i = src.indexOf(close, i)) >= 0) {
      let k = i - 1, slashes = 0;
      while (src[k--] === '\\') slashes++;
      if (close[0] === '\\' || slashes % 2 === 0) return i;
      i += close.length;
    }
    return -1;
  };
  function find(src, pos) {
    for (const [open, close, display] of [['$$', '$$', true], ['\\[', '\\]', true], ['\\(', '\\)', false], ['$', '$', false]]) {
      if (!src.startsWith(open, pos)) continue;
      const end = closed(src, pos, open, close);
      if (end < 0) return null;
      const tex = src.slice(pos + open.length, end);
      if (!tex.trim()) return null;
      // "$5 and $10" isn't math: no space just inside the dollars, no digit right after.
      if (open === '$' && (/^\s|\s$|\n\s*\n/.test(tex) || /\d/.test(src[end + 1] || ''))) return null;
      return { display, tex, end: end + close.length };
    }
    const m = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(src.slice(pos, pos + 40));
    if (!m) return null;
    const tail = `\\end{${m[1]}}`;
    let depth = 1, i = pos + m[0].length;
    while (depth) {
      const e = src.indexOf(tail, i), b = src.indexOf(m[0], i);
      if (e < 0) return null;
      if (b >= 0 && b < e) { depth++; i = b + m[0].length; } else { depth--; i = e + tail.length; }
    }
    return { display: true, tex: src.slice(pos, i), end: i };
  }
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const c = state.src[state.pos];
    if (c !== '$' && c !== '\\') return false;
    const m = find(state.src, state.pos);
    if (!m || m.end > state.posMax) return false;
    if (!silent) Object.assign(state.push('math', '', 0), { content: m.tex, meta: m.display });
    state.pos = m.end;
    return true;
  });
  md.block.ruler.before('fence', 'math_block', (state, start, endLine, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const pos = state.bMarks[start] + state.tShift[start];
    if (state.src[pos] !== '$' && state.src[pos] !== '\\') return false;
    const m = find(state.src, pos);
    if (!m || !m.display) return false;
    let line = start;
    while (line < endLine && state.eMarks[line] < m.end) line++;
    // Leave it to the inline rule if the block runs out first or other text follows the math.
    if (line >= endLine || state.src.slice(m.end, state.eMarks[line]).trim()) return false;
    if (silent) return true;
    const t = state.push('math', '', 0);
    Object.assign(t, { block: true, content: m.tex, meta: true, map: [start, line + 1] });
    state.line = line + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math = (tokens, i) => {
    const { content, meta: display, block, map } = tokens[i];
    const body = display ? `\\[${content}\\]` : `\\(${content}\\)`;
    return block ? `<div class="mjx" data-line="${map[0]}">${esc(body)}</div>\n` : `<span class="mjx">${esc(body)}</span>`;
  };
}

window.MathJax = {
  loader: { load: ['ui/safe'], paths: { mathjax: new URL('./mathjax', import.meta.url).href } },
  tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']], processEnvironments: false, tags: 'ams' },
  svg: { fontCache: 'none' },
  options: { ignoreHtmlClass: 'nomath', processHtmlClass: 'mjx', enableMenu: false },
  startup: { typeset: false },
};
const mathReady = new Promise(ok => {
  const s = document.createElement('script');
  s.src = new URL('./mathjax/tex-svg-full.js', import.meta.url);
  s.onload = () => MathJax.startup.promise.then(() => ok(true), e => { console.error(e); ok(false); });
  s.onerror = () => ok(false);
  document.head.append(s);
});

// Pads come from other people, so everything is sanitized before it touches the page.
const clean = html => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'dialog'], FORBID_ATTR: ['style', 'id', 'name'] });

let rendering = null, dirty = false;
function render() {
  dirty = true;
  rendering ||= (async () => {
    while (dirty) {
      dirty = false;
      try { await renderOnce(current?.doc.text ?? ''); } catch (e) { console.error('render failed', e); }
    }
    rendering = null;
  })();
}
async function renderOnce(text) {
  const out = $('out');
  const next = document.createElement('div');
  next.id = 'page';
  next.className = 'staging nomath';
  next.innerHTML = clean(md.render(text));
  if (!text.trim()) next.innerHTML = '<p class="empty">Your page appears here as you type. If someone sent you this pad, it fills in once their browser connects.</p>';
  for (const a of next.querySelectorAll('a[href]')) if (!a.getAttribute('href').startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  // Typeset out of sight and swap when done, so the preview doesn't flicker while typing.
  out.append(next);
  try {
    if (next.querySelector('.mjx') && await mathReady) {
      MathJax.texReset();
      MathJax.typesetClear();
      await MathJax.typesetPromise([next]);
    }
  } finally {
    const top = out.scrollTop;
    next.classList.remove('staging');
    out.replaceChildren(next);
    out.scrollTop = top;
    markHere();
  }
}
// Mark the block being edited and, when the cursor moves, keep it in view.
function markHere(scroll = false) {
  const page = $('page');
  if (!page || !view) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  let here = null;
  for (const el of page.children) {
    const n = (el.matches('[data-line]') ? el : el.querySelector('[data-line]'))?.dataset.line;
    if (n !== undefined && Number(n) <= line) here = el;
    el.classList.remove('here');
  }
  if (!here || !view.hasFocus) return;
  here.classList.add('here');
  if (!scroll || document.body.dataset.view !== 'both') return;
  const out = $('out'), o = out.getBoundingClientRect(), h = here.getBoundingClientRect();
  if (h.top < o.top || h.bottom > o.bottom) out.scrollTop += h.top - o.top - o.height / 3;
}
const titleOf = text => (/^#\s+(.+)$/m.exec(text)?.[1] || text.trim().split('\n')[0] || '').trim().slice(0, 80);

// ---------- Editor ----------
const remote = Annotation.define();
const vimC = new Compartment();
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' }, { tag: tags.strong, fontWeight: 'bold' }, { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote], color: 'var(--muted)' },
  { tag: [tags.link, tags.url], color: 'var(--blue)' }, { tag: tags.monospace, color: 'var(--str)' },
]);
const texMatcher = new MatchDecorator({ regexp: /\$\$[^$]+\$\$|\$(?![\s$])[^$\n]*[^\s$]\$(?!\d)|\\(?:begin|end)\{[^}\n]*\}/g, decoration: Decoration.mark({ class: 'cm-tex' }) });
const texColor = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = texMatcher.createDeco(v); }
  update(u) { this.decorations = texMatcher.updateDeco(u, this.decorations); }
}, { decorations: p => p.decorations });
const isDark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
let current, view, padRoom, renderTimer;

function changed() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
    const text = current.doc.text, title = titleOf(text);
    document.title = title || 'txtpad';
    $('title').textContent = title || 'Untitled';
    if (text) remember(current.id, title);
  }, 200);
}
function mountEditor() {
  view = new EditorView({
    parent: $('left'),
    state: EditorState.create({
      doc: current.doc.text,
      extensions: [
        vimC.of(store['txtpad:vim'] ? vim() : []),
        basicSetup, markdown(), EditorView.lineWrapping, syntaxHighlighting(highlight), texColor,
        EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Pad text' }),
        EditorView.updateListener.of(u => {
          if (u.selectionSet || u.focusChanged) requestAnimationFrame(() => markHere(u.selectionSet));
          const mine = u.transactions.filter(t => t.docChanged && !t.annotation(remote));
          if (!mine.length) return;
          current.change(d => {
            for (const t of mine) t.changes.iterChanges((fromA, toA, fromB, _to, ins) => A.splice(d, ['text'], fromB, toA - fromA, ins.toString()));
          });
        }),
      ],
    }),
  });
  current.listeners.add(({ local, before, after }) => {
    if (!local) {
      for (const p of A.diff(current.doc, before, after)) {
        if (p.path.length !== 2 || p.path[0] !== 'text') continue;
        const from = p.path[1];
        const changes = p.action === 'splice' ? { from, insert: p.value } : p.action === 'del' ? { from, to: from + (p.length || 1) } : null;
        // Keep others' edits out of my undo stack.
        if (changes) view.dispatch({ changes, annotations: [remote.of(true), Transaction.addToHistory.of(false)] });
      }
    }
    changed();
  });
}

// ---------- UI ----------
const base = () => location.href.split('#')[0];
const go = id => { location.hash = id; };
$('new').onclick = () => go(newId());
function renderPads() {
  const q = $('filter').value.trim().toLowerCase();
  const list = Object.entries(library.doc.pads).filter(([id, p]) => ID.test(id) && `${p.title} ${id}`.toLowerCase().includes(q)).sort((a, b) => b[1].at - a[1].at);
  $('padList').replaceChildren(...list.map(([id, p]) => {
    const li = document.createElement('li'), a = document.createElement('a'), t = document.createElement('span'), x = document.createElement('button');
    const name = document.createElement('span');
    a.href = '#' + id; name.textContent = p.title || 'Untitled';
    if (id === current.id) { a.ariaCurrent = 'page'; x.hidden = true; a.onclick = () => $('padsDlg').close(); }
    t.className = 'muted'; t.textContent = new Date(p.at).toLocaleDateString(undefined, { dateStyle: 'medium' });
    x.type = 'button'; x.textContent = 'remove';
    x.title = 'Remove from your list and delete this browser’s copy';
    let armed = false;
    x.onclick = async () => {
      if (!armed) { armed = true; x.textContent = 'really?'; setTimeout(() => { armed = false; x.textContent = 'remove'; }, 3000); return; }
      library.change(d => { delete d.pads[id]; });
      const open = await docs.get(id);
      if (open) clearTimeout(open.timer);
      docs.delete(id);
      await dbRun('readwrite', s => { s.delete(id); });
    };
    a.append(name, t);
    li.append(a, x);
    return li;
  }));
  if (!list.length) $('padList').textContent = q ? 'No pad matches that.' : 'Pads you write or open show up here.';
}
$('filter').oninput = renderPads;
$('pads').onclick = () => { $('filter').value = ''; renderPads(); $('padsDlg').showModal(); };
for (const d of [$('padsDlg'), $('shareDlg')]) d.addEventListener('click', e => e.target === d && outside(d, e) && d.close());
function outside(el, e) { const r = el.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; }
$('share').onclick = () => {
  $('padLink').value = `${base()}#${current.id}`;
  $('devLink').value = `${base()}#link/${libraryId}`;
  $('shareDlg').showModal();
};
for (const b of document.querySelectorAll('[data-copy]')) b.onclick = async () => {
  const label = b.dataset.label ||= b.textContent;
  try { await navigator.clipboard.writeText($(b.dataset.copy).value); b.textContent = 'Copied'; }
  catch { $(b.dataset.copy).select(); b.textContent = 'Press Ctrl-C'; }
  setTimeout(() => { b.textContent = label; }, 1500);
};
$('upload').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  if (f) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: await f.text() } });
  $('file').value = '';
};
$('download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([current.doc.text], { type: 'text/markdown' }));
  a.download = (titleOf(current.doc.text).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || current.id) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('vim').setAttribute('aria-pressed', !!store['txtpad:vim']);
$('vim').onclick = () => {
  const on = !store['txtpad:vim'];
  if (on) store['txtpad:vim'] = '1'; else store.removeItem('txtpad:vim');
  $('vim').setAttribute('aria-pressed', on);
  view.dispatch({ effects: vimC.reconfigure(on ? vim() : []) });
  view.focus();
};
const syncTheme = () => { $('dark').setAttribute('aria-pressed', isDark()); };
$('dark').onclick = () => { store['txtpad:theme'] = document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; syncTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
function setView(v) {
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll('[data-set-view]')) {
    b.setAttribute('aria-pressed', b.dataset.setView === v || (v === 'both' && b.dataset.setView === 'write' && matchMedia('(max-width: 48rem)').matches));
  }
}
for (const b of document.querySelectorAll('[data-set-view]')) b.onclick = () => { store['txtpad:view'] = b.dataset.setView; setView(b.dataset.setView); };
setView(['write', 'both', 'read'].includes(store['txtpad:view']) ? store['txtpad:view'] : 'both');
for (const id of ['upload', 'download', 'present']) $(id).addEventListener('click', () => $('menu').hidePopover());
$('present').onclick = () => open(`${base()}#${current.id}/present`, '_blank', 'noopener');
addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('presenting')) {
    document.body.classList.remove('presenting');
    setView('both');
    history.replaceState(null, '', '#' + current.id);
  }
});
$('bar').onpointerdown = e => { e.preventDefault(); $('bar').setPointerCapture(e.pointerId); };
$('bar').onpointermove = e => { if ($('bar').hasPointerCapture(e.pointerId)) document.body.style.setProperty('--left', `${Math.min(90, Math.max(10, e.clientX / innerWidth * 100))}%`); };

const WELCOME = String.raw`# Welcome to txtpad

This is a *local-first* collaborative Markdown editor. Everything you write is stored in this browser
and works offline. Press **share** to send this pad to someone, or to link your other devices.

Math works, inline like $e^{i\pi} = -1$ or displayed and numbered:

\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}
\end{equation}

${'```'}python
def foo(x):
    return x + 1
${'```'}

Enjoy. :smile:
`;

// ---------- Start ----------
await openLibrary(store['txtpad:library']);
let first = !store['txtpad:last'];
let [route, mode] = location.hash.slice(1).split('/');
if (route === 'link') {
  const target = mode;
  mode = '';
  route = store['txtpad:last'];
  if (ID.test(target || '') && target !== libraryId) {
    const ok = await new Promise(done => {
      $('linkDlg').onclose = () => done($('linkDlg').returnValue === 'link');
      $('linkDlg').showModal();
    });
    if (ok) { await linkDevice(target); first = false; }
  }
}
if (ID.test(route || '')) first = false;
else route = ID.test(store['txtpad:last'] || '') ? store['txtpad:last'] : newId();
history.replaceState(null, '', '#' + route + (mode === 'present' ? '/present' : ''));
store['txtpad:last'] = route;
addEventListener('hashchange', async () => { await Promise.all([...docs.values()].map(p => p.then(d => d.timer && d.save()))); location.reload(); });

current = await openDoc(route);
if (mode === 'present') { document.body.classList.add('presenting'); setView('read'); }
mountEditor();
if (first) view.dispatch({ changes: { from: 0, insert: WELCOME } });
syncTheme();
changed();
renderConn();
[padRoom] = await Promise.all([openRoom(route, () => [route], id => id === route), joinLibrary()]);
renderConn();
navigator.storage?.persist?.();
navigator.serviceWorker?.register('sw.js').catch(e => console.warn(e));

window.txtpad = { get current() { return current; }, get library() { return library; }, get libraryId() { return libraryId; }, view, rooms, A };
