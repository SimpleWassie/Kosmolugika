import './fixes.css';

const TYPES = ['scene', 'character', 'location', 'prop', 'lore', 'note'];
const TYPE_LABEL = { scene: 'Scene', character: 'Character', location: 'Location', prop: 'Prop', lore: 'Lore', note: 'Note' };
const PRESETS = [['Plot', '#df9f82'], ['Character arc', '#d1a2e8'], ['World', '#8eafd8'], ['Theme', '#d2b86f'], ['Visual', '#86c3b3'], ['Production', '#e690aa']];
const STORAGE = 'kosmolugika-v01';
const TAU = Math.PI * 2;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const uid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
const now = () => Math.floor(Date.now() / 1000);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const dirty = new Set(), deleted = new Set();
const pts = new Map();
const undoStack = [], redoStack = [];
let state = { galaxies: [], active: null };
let remote = null; // null = unknown, true = API reachable, false = local-only (no API on this host)
let currentView = 'galaxy', selected = null, search = '', layout = 'free', boardAxis = 'episode';
let filters = { type: '', category: '', episode: '', tasks: false };
let sort = { key: 'sequence', dir: 1 };
let saveTimer, toastTimer, longPress, lastText = 0;
let canvas, context, camera = { x: 0, y: 0, zoom: 1 }, points = [], stars = [];
let hoverId = null, linkFrom = null, linkDrag = null, pointer = null, moved = false, pinch = null;
const colorCache = new Map();

const home = $('#home'), studio = $('#studio'), memo = $('#memo'), layer = $('#modal-layer');

/* ---------- data + persistence ---------- */
function seed() {
  const gid = uid(), time = now();
  return { id: gid, name: 'The Glass Meridian', created_at: time, updated_at: time, categories: PRESETS.map(([name, color]) => ({ id: uid(), galaxy_id: gid, name, color })), items: [], links: [] };
}
function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ galaxies: state.galaxies, activeId: state.active?.id || null, dirty: [...dirty], deleted: [...deleted] }));
  } catch { toast('Browser storage is full — export a backup'); }
}
function setSave(s) {
  const el = $('.save-indicator');
  if (el) { el.classList.toggle('saving', s === 'saving'); el.classList.toggle('error', s === 'error'); }
  const label = $('#save-label');
  if (label) label.textContent = { saved: 'SAVED', saving: 'SAVING', error: 'NOT SYNCED' }[s] || 'SAVED';
  const foot = $('#save-state');
  if (foot) foot.textContent = s === 'error' ? 'Saved on this device · will sync when online' : remote ? 'Synced' : 'Saved on this device';
}
function saveGalaxy(g, delay = 300) {
  g.updated_at = now();
  dirty.add(g.id);
  setSave('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}
function scheduleSave() { if (state.active) saveGalaxy(state.active, 800); }
async function flush() { persist(); await syncDirty(); renderCounters(); }

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error('no-api');
  return r;
}
async function syncDirty() {
  if (remote === false) { setSave('saved'); return; }
  let failed = false;
  try {
    for (const id of [...deleted]) {
      const r = await api(`/galaxies/${id}`, { method: 'DELETE' });
      if (r.ok) deleted.delete(id); else failed = true;
    }
    for (const id of [...dirty]) {
      const g = state.galaxies.find(x => x.id === id);
      if (!g) { dirty.delete(id); continue; }
      const sentAt = g.updated_at;
      const r = await api(`/galaxies/${id}/sync`, { method: 'PUT', body: JSON.stringify(g) });
      if (r.ok) {
        const j = await r.json();
        if (g.updated_at === sentAt) { dirty.delete(id); g.updated_at = j.updated_at; }
      } else failed = true;
    }
    remote = true;
  } catch (e) {
    if (e.message === 'no-api') { remote = false; setSave('saved'); persist(); return; }
    failed = true;
  }
  persist();
  setSave(failed ? 'error' : 'saved');
}
async function pullRemote() {
  try {
    const r = await api('/galaxies');
    if (!r.ok) return;
    remote = true;
    const list = await r.json();
    const ids = new Set(list.map(g => g.id));
    for (const rg of list) {
      if (deleted.has(rg.id)) continue;
      const local = state.galaxies.find(g => g.id === rg.id);
      if (local && (dirty.has(local.id) || local.updated_at >= rg.updated_at || state.active?.id === local.id)) continue;
      const full = await api(`/galaxies/${rg.id}`).then(x => (x.ok ? x.json() : null));
      if (!full) continue;
      const idx = state.galaxies.findIndex(g => g.id === rg.id);
      if (idx >= 0) state.galaxies[idx] = full; else state.galaxies.push(full);
    }
    state.galaxies.forEach(g => { if (!ids.has(g.id) && !deleted.has(g.id)) dirty.add(g.id); });
    state.galaxies.sort((a, b) => b.updated_at - a.updated_at);
    await syncDirty();
    if (!home.classList.contains('hidden')) renderHome();
  } catch (e) { if (e.message === 'no-api') remote = false; else setSave('error'); }
}
async function boot() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (saved?.galaxies) {
      state.galaxies = saved.galaxies;
      (saved.dirty || []).forEach(x => dirty.add(x));
      (saved.deleted || []).forEach(x => deleted.add(x));
    }
  } catch { /* corrupt local data: start fresh */ }
  if (!state.galaxies.length) { const g = seed(); state.galaxies = [g]; dirty.add(g.id); persist(); }
  initCanvas();
  bindMemo();
  renderHome();
  window.addEventListener('keydown', hotkeys);
  window.addEventListener('pagehide', persist);
  window.addEventListener('online', () => { remote = null; pullRemote(); });
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.popover') && !e.target.closest('#more-menu') && !e.target.closest('[data-gmenu]') && !e.target.closest('#layout-toggle') && !e.target.closest('[data-move]')) $('#popover').classList.add('hidden');
    if (!e.target.closest('.filters-pop') && !e.target.closest('#filter-toggle')) $('#filter-pop')?.remove();
  });
  await pullRemote();
}

/* ---------- undo / redo (session only, last 50 operations) ---------- */
const snapshot = g => JSON.stringify({ name: g.name, categories: g.categories, items: g.items, links: g.links });
function checkpoint() {
  const g = state.active; if (!g) return;
  undoStack.push(snapshot(g));
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
}
function checkpointText() { const t = Date.now(); if (t - lastText > 1500) checkpoint(); lastText = t; }
function restoreSnapshot(s) { const g = state.active, o = JSON.parse(s); g.name = o.name; g.categories = o.categories; g.items = o.items; g.links = o.links; }
function afterRestore() {
  const g = state.active;
  $('#galaxy-name').value = g.name;
  if (selected && !activeItem()) { selected = null; memo.classList.add('hidden'); } else if (selected) openMemo(selected);
  scheduleSave(); showView(); renderCounters();
}
function undo() { const g = state.active; if (!g || !undoStack.length) { toast('Nothing to undo'); return; } redoStack.push(snapshot(g)); restoreSnapshot(undoStack.pop()); afterRestore(); toast('Undone'); }
function redo() { const g = state.active; if (!g || !redoStack.length) { toast('Nothing to redo'); return; } undoStack.push(snapshot(g)); restoreSnapshot(redoStack.pop()); afterRestore(); toast('Redone'); }

/* ---------- home + galaxy management ---------- */
function renderHome() {
  home.classList.remove('hidden'); studio.classList.add('hidden');
  $('#galaxy-list').innerHTML = state.galaxies.map((g, i) => `<article class="galaxy-card" data-open="${g.id}" style="--nebula:${i % 2 ? '125,96,177' : '83,111,150'}"><div class="card-nebula"></div><button class="card-menu" data-gmenu="${g.id}" aria-label="Galaxy actions">···</button><div class="card-glyph">✳</div><h2 class="card-name">${esc(g.name)}</h2><div class="card-meta">${g.items.filter(x => !x.deleted_at).length} BODIES <span class="footer-dot">·</span> UPDATED ${ago(g.updated_at)}</div><span class="card-open">↗</span></article>`).join('');
  $$('[data-open]').forEach(e => e.onclick = () => openGalaxy(e.dataset.open));
  $$('[data-gmenu]').forEach(e => e.onclick = ev => {
    ev.stopPropagation();
    const g = state.galaxies.find(x => x.id === e.dataset.gmenu);
    showMenu(e, [['Rename galaxy', () => renameGalaxy(g)], ['Duplicate galaxy', () => duplicateGalaxy(g)], ['Export backup', () => exportGalaxy(g)], ['Delete galaxy', () => confirmDeleteGalaxy(g)]]);
  });
  setSave(dirty.size ? 'saving' : 'saved');
}
function openGalaxy(id) {
  state.active = state.galaxies.find(g => g.id === id);
  if (!state.active) return;
  undoStack.length = 0; redoStack.length = 0;
  home.classList.add('hidden'); studio.classList.remove('hidden');
  $('#galaxy-name').value = state.active.name;
  currentView = 'galaxy'; selected = null; camera = { x: 0, y: 0, zoom: 1 };
  showView(); renderCounters();
}
function createGalaxy() {
  modal('A new universe', 'Name your galaxy and give the story somewhere to grow.', { label: 'GALAXY NAME', value: 'Untitled galaxy', placeholder: 'e.g. The Long Winter', confirm: 'Create galaxy' }, name => {
    const g = seed(); g.name = (name || 'Untitled galaxy').slice(0, 160);
    state.galaxies.unshift(g); saveGalaxy(g); renderHome(); openGalaxy(g.id);
  });
}
function renameGalaxy(g) {
  modal('Rename galaxy', 'Give this story world a name.', { label: 'GALAXY NAME', value: g.name, confirm: 'Save' }, name => {
    if (!name) return;
    g.name = name.slice(0, 160); saveGalaxy(g); renderHome();
    if (state.active?.id === g.id) $('#galaxy-name').value = g.name;
  });
}
function duplicateGalaxy(g) {
  const copy = structuredClone(g), map = new Map();
  map.set(g.id, uid()); copy.id = map.get(g.id); copy.name = `${g.name} (copy)`; copy.created_at = now();
  copy.categories.forEach(c => { const old = c.id; c.id = uid(); c.galaxy_id = copy.id; map.set(old, c.id); });
  copy.items.forEach(i => { const old = i.id; i.id = uid(); i.galaxy_id = copy.id; i.category_id = map.get(i.category_id) || null; i.created_at = now(); i.updated_at = now(); map.set(old, i.id); });
  copy.links = copy.links.filter(l => map.has(l.from_id) && map.has(l.to_id)).map(l => ({ ...l, id: uid(), galaxy_id: copy.id, from_id: map.get(l.from_id), to_id: map.get(l.to_id) }));
  state.galaxies.unshift(copy); saveGalaxy(copy); renderHome(); toast('Galaxy duplicated');
}
function confirmDeleteGalaxy(g) {
  modal('Delete this galaxy?', 'This permanently removes its bodies, links, and categories.', { confirm: 'Delete galaxy', danger: true }, () => {
    state.galaxies = state.galaxies.filter(x => x.id !== g.id);
    dirty.delete(g.id); deleted.add(g.id);
    if (state.active?.id === g.id) state.active = null;
    if (!state.galaxies.length) { const n = seed(); state.galaxies = [n]; dirty.add(n.id); }
    persist(); renderHome(); flush();
  });
}

/* ---------- lenses ---------- */
function showView() {
  if (!state.active) return;
  $$('#lens-tabs .lens-tab').forEach(b => b.classList.toggle('active', b.dataset.view === currentView));
  const map = currentView === 'galaxy';
  $('#canvas-wrap').classList.toggle('hidden', !map);
  $('#lens-content').classList.toggle('hidden', map);
  if (map) { renderCanvas(); return; }
  renderLens();
}
function liveItems() { return state.active?.items.filter(i => !i.deleted_at) || []; }
function filteredItems(ignoreSearch = false) {
  const q = search.toLowerCase();
  return liveItems().filter(i =>
    (ignoreSearch || !q || `${i.title} ${i.summary} ${i.body}`.toLowerCase().includes(q)) &&
    (!filters.type || i.type === filters.type) &&
    (!filters.category || i.category_id === filters.category) &&
    (!filters.episode || String(i.episode || '') === filters.episode) &&
    (!filters.tasks || i.tasks?.some(t => !t.done)));
}
const bySeq = (a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.created_at - b.created_at;
function sortVal(i, k) {
  const g = state.active;
  if (k === 'title') return (i.title || '').toLowerCase();
  if (k === 'type') return i.type;
  if (k === 'category') return (g.categories.find(c => c.id === i.category_id)?.name || '').toLowerCase();
  if (k === 'links') return g.links.filter(l => l.from_id === i.id || l.to_id === i.id).length;
  if (k === 'tasks') return (i.tasks || []).filter(t => !t.done).length;
  return i[k] ?? 0;
}
function sortItems(items) { return [...items].sort((a, b) => { const av = sortVal(a, sort.key), bv = sortVal(b, sort.key); return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir; }); }

function lensList(items, g) {
  const cat = id => g.categories.find(c => c.id === id), linksFor = id => g.links.filter(l => l.from_id === id || l.to_id === id);
  const cols = [['title', 'TITLE'], ['type', 'TYPE'], ['category', 'CATEGORY'], ['episode', 'EPISODE'], ['sequence', 'SEQ.'], ['links', 'LINKS'], ['tasks', 'OPEN TASKS']];
  return `<div class="lens-heading"><div><h2>All bodies</h2><p>${items.length} ideas, people and places in this galaxy.</p></div><button class="button button-quiet" data-new-item>＋ New body</button></div><table class="view-table"><thead><tr>${cols.map(([k, v]) => `<th><button class="sort-button" data-sort="${k}">${v}${sort.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead><tbody>${sortItems(items).map(i => `<tr data-item="${i.id}"><td class="table-name">${esc(i.title || 'Untitled')}</td><td><span class="type-chip"><i class="type-dot" style="background:${color(i)}"></i>${TYPE_LABEL[i.type]}</span></td><td>${esc(cat(i.category_id)?.name || '—')}</td><td>${i.episode || '—'}</td><td>${i.sequence || '—'}</td><td>${linksFor(i.id).length}</td><td>${i.tasks?.filter(t => !t.done).length || '—'}</td></tr>`).join('')}</tbody></table>`;
}
function boardGroups(items) {
  const axis = boardAxis, groups = new Map();
  groups.set('Unassigned', []);
  items.filter(i => i.type === 'scene').forEach(i => {
    const v = i[axis] ? `${axis === 'episode' ? 'Episode' : 'Act'} ${i[axis]}` : 'Unassigned';
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(i);
  });
  const n = s => parseInt(s.match(/\d+/)?.[0] || 0);
  return [...groups.entries()].sort((a, b) => a[0] === 'Unassigned' ? -1 : b[0] === 'Unassigned' ? 1 : n(a[0]) - n(b[0]));
}
function lensBoard(items) {
  const axis = boardAxis;
  return `<div class="lens-heading"><div><h2>Story board</h2><p>Move a scene to shape its place in the story.</p></div><select class="select-small" id="board-axis"><option value="episode" ${axis === 'episode' ? 'selected' : ''}>Group by episode</option><option value="act" ${axis === 'act' ? 'selected' : ''}>Group by act</option></select></div><div class="board-scroll">${boardGroups(items).map(([label, arr]) => `<div class="board-column" data-column="${escAttr(label)}"><div class="board-col-head"><span class="board-col-name">${esc(label.toUpperCase())}</span><span class="board-col-count">${arr.length}</span></div>${arr.sort(bySeq).map(i => `<article class="board-card" draggable="true" data-item="${i.id}"><span class="type-chip"><i class="type-dot" style="background:${color(i)}"></i>${TYPE_LABEL[i.type]}</span><h3>${esc(i.title || 'Untitled')}</h3><p>${esc(i.summary || 'No summary yet.')}</p><div class="card-tools"><button data-up="${i.id}" aria-label="Move up">▲</button><button data-down="${i.id}" aria-label="Move down">▼</button><button data-move="${i.id}" aria-label="Move to another column">⇢ Move</button></div></article>`).join('')}</div>`).join('')}</div>`;
}
function lensBreakdown(items, g) {
  const scenes = items.filter(i => i.type === 'scene').sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999) || bySeq(a, b));
  return `<div class="lens-heading"><div><h2>Scene breakdown</h2><p>${scenes.length} scenes · cast, places &amp; props at a glance.</p></div><div><button class="button button-quiet" id="export-md">↓ Markdown</button><button class="button button-quiet" onclick="window.print()">Print</button></div></div><table class="view-table breakdown-table"><thead><tr><th>EP / SEQ.</th><th>SCENE</th><th>SUMMARY</th><th>CAST</th><th>LOCATIONS</th><th>PROPS</th></tr></thead><tbody>${scenes.map(s => {
    const linked = linkedTo(g, s.id);
    const names = t => linked.filter(i => i.type === t).map(i => esc(i.title)).join(', ') || '—';
    return `<tr data-item="${s.id}"><td>${s.episode || '—'} / ${s.sequence || '—'}</td><td class="breakdown-title">${esc(s.title)}</td><td>${esc(s.summary || '—')}</td><td class="cast-list">${names('character')}</td><td>${names('location')}</td><td>${names('prop')}</td></tr>`;
  }).join('')}</tbody></table>`;
}
function lensTasks(items) {
  const grouped = new Map();
  items.forEach(i => { const open = (i.tasks || []).filter(t => !t.done); if (open.length) grouped.set(i.id, { item: i, tasks: open }); });
  const total = [...grouped.values()].reduce((n, x) => n + x.tasks.length, 0);
  return `<div class="lens-heading"><div><h2>Open tasks</h2><p>${total} small next steps, across ${grouped.size} bodies.</p></div></div>${[...grouped.values()].map(({ item, tasks }) => `<section class="task-group"><h3>${esc(item.title)} <span class="table-sub">· ${TYPE_LABEL[item.type]}</span></h3>${tasks.map(t => `<label class="task-view-row"><input type="checkbox" data-task="${esc(t.id)}" data-owner="${item.id}" /><span>${esc(t.text)}</span><small data-openmemo="${item.id}">Open memo ↗</small></label>`).join('')}</section>`).join('') || '<div class="empty-state"><strong>All clear for now.</strong>Your unchecked tasks will gather here.</div>'}`;
}
function linkedTo(g, id) {
  return g.links.filter(l => l.from_id === id || l.to_id === id).map(l => g.items.find(i => i.id === (l.from_id === id ? l.to_id : l.from_id))).filter(i => i && !i.deleted_at);
}
function renderLens() {
  const out = $('#lens-content'), items = filteredItems(), g = state.active;
  out.innerHTML = currentView === 'list' ? lensList(items, g) : currentView === 'board' ? lensBoard(items) : currentView === 'breakdown' ? lensBreakdown(items, g) : lensTasks(items);
  out.querySelectorAll('[data-item]').forEach(row => row.addEventListener('click', e => { if (e.target.closest('button')) return; openMemo(row.dataset.item); }));
  out.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { sort.dir = sort.key === b.dataset.sort ? -sort.dir : 1; sort.key = b.dataset.sort; renderLens(); });
  out.querySelectorAll('[data-new-item]').forEach(b => b.onclick = () => createItem());
  $('#board-axis')?.addEventListener('change', e => { boardAxis = e.target.value; renderLens(); });
  out.querySelectorAll('.board-card').forEach(c => c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', c.dataset.item)));
  out.querySelectorAll('.board-column').forEach(c => {
    c.addEventListener('dragover', e => e.preventDefault());
    c.addEventListener('drop', e => { e.preventDefault(); moveScene(e.dataTransfer.getData('text/plain'), c.dataset.column); });
  });
  out.querySelectorAll('[data-up]').forEach(b => b.onclick = () => reorderScene(b.dataset.up, -1));
  out.querySelectorAll('[data-down]').forEach(b => b.onclick = () => reorderScene(b.dataset.down, 1));
  out.querySelectorAll('[data-move]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const labels = [...out.querySelectorAll('.board-column')].map(c => c.dataset.column);
    const actions = labels.map(l => [l, () => moveScene(b.dataset.move, l)]);
    actions.push([`New ${boardAxis}…`, () => modal(`New ${boardAxis}`, 'Which number should this scene move to?', { label: 'NUMBER', value: '', confirm: 'Move' }, v => { const n = parseInt(v); if (n > 0) moveScene(b.dataset.move, `${boardAxis} ${n}`); })]);
    showMenu(b, actions);
  });
  out.querySelectorAll('[data-task]').forEach(x => x.onchange = () => { toggleTask(x.dataset.owner, x.dataset.task); renderLens(); });
  out.querySelectorAll('[data-openmemo]').forEach(x => x.onclick = () => openMemo(x.dataset.openmemo));
  $('#export-md')?.addEventListener('click', exportBreakdown);
}
function moveScene(id, label) {
  const g = state.active, i = g.items.find(x => x.id === id); if (!i) return;
  const target = label === 'Unassigned' ? null : parseInt(label.match(/\d+/)?.[0] || '');
  if (label !== 'Unassigned' && !(target > 0)) return;
  checkpoint();
  i[boardAxis] = target;
  const peers = liveItems().filter(x => x.type === 'scene' && x.id !== id && (x[boardAxis] || null) === target);
  i.sequence = Math.max(0, ...peers.map(x => x.sequence || 0)) + 1;
  i.updated_at = now(); scheduleSave(); renderLens();
}
function reorderScene(id, dir) {
  const it = state.active.items.find(x => x.id === id); if (!it) return;
  const col = liveItems().filter(x => x.type === 'scene' && (x[boardAxis] || null) === (it[boardAxis] || null)).sort(bySeq);
  const n = col.findIndex(x => x.id === id), m = n + dir;
  if (m < 0 || m >= col.length) return;
  checkpoint();
  [col[n], col[m]] = [col[m], col[n]];
  col.forEach((x, k) => { x.sequence = k + 1; x.updated_at = now(); });
  scheduleSave(); renderLens();
}

/* ---------- items + memo ---------- */
function createItem(position) {
  const g = state.active; if (!g) return;
  checkpoint();
  const cat = g.categories[0];
  const i = { id: uid(), galaxy_id: g.id, type: 'scene', category_id: cat?.id || null, title: '', summary: '', body: '', act: null, episode: null, sequence: null, tasks: [], refs: [], x: position?.x ?? camera.x + (Math.random() - .5) * 60, y: position?.y ?? camera.y + (Math.random() - .5) * 60, z: 0, deleted_at: null, created_at: now(), updated_at: now() };
  g.items.push(i); scheduleSave(); showView(); renderCounters(); openMemo(i.id); $('#memo-title').focus();
}
function activeItem() { return state.active?.items.find(i => i.id === selected); }
function openMemo(id) {
  const i = state.active.items.find(x => x.id === id); if (!i || i.deleted_at) return;
  selected = id; memo.classList.remove('hidden');
  $('#memo-kicker').textContent = TYPE_LABEL[i.type].toUpperCase();
  $('#memo-title').value = i.title;
  $('#memo-type').innerHTML = TYPES.map(t => `<option value="${t}" ${i.type === t ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('');
  $('#memo-category').innerHTML = `<option value="">No category</option>` + state.active.categories.map(c => `<option value="${c.id}" ${i.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  $('#scene-fields').classList.toggle('hidden', i.type !== 'scene');
  $('#memo-act').value = i.act || ''; $('#memo-episode').value = i.episode || ''; $('#memo-sequence').value = i.sequence || '';
  $('#memo-summary').value = i.summary || ''; $('#memo-body').value = i.body || '';
  $('#memo-preview').classList.add('hidden'); $('#memo-body').classList.remove('hidden'); $('#preview-toggle').textContent = 'Preview';
  $('#memo-created').textContent = `CREATED ${ago(i.created_at)}`;
  $('#memo-saved').textContent = `MODIFIED ${ago(i.updated_at)}`;
  renderMemoDetails(i); renderCanvas();
}
const isImage = u => /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(u);
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '#');
function renderMemoDetails(i) {
  const g = state.active, links = g.links.filter(l => l.from_id === i.id || l.to_id === i.id);
  $('#memo-links').innerHTML = links.map(l => {
    const other = g.items.find(x => x.id === (l.from_id === i.id ? l.to_id : l.from_id));
    if (!other) return '';
    const arrow = l.directed ? (l.from_id === i.id ? '→' : '←') : '↔';
    return `<div class="link-row" data-openlink="${other.id}"><i class="type-dot" style="background:${color(other)}"></i><span class="link-title">${esc(other.title || 'Untitled')}</span><span class="link-label" data-editlink="${l.id}" title="Edit relationship">${esc(l.label || TYPE_LABEL[other.type])}</span><button class="row-remove" data-dir="${l.id}" title="Toggle direction">${arrow}</button><button class="row-remove" data-unlink="${l.id}" aria-label="Remove link">×</button></div>`;
  }).join('') || '<span class="table-sub">Nothing connected yet.</span>';
  const ml = $('#memo-links');
  ml.querySelectorAll('[data-openlink]').forEach(x => x.onclick = () => openMemo(x.dataset.openlink));
  ml.querySelectorAll('[data-unlink]').forEach(x => x.onclick = e => { e.stopPropagation(); checkpoint(); g.links = g.links.filter(l => l.id !== x.dataset.unlink); scheduleSave(); renderMemoDetails(i); renderCanvas(); });
  ml.querySelectorAll('[data-dir]').forEach(x => x.onclick = e => { e.stopPropagation(); const l = g.links.find(k => k.id === x.dataset.dir); if (!l) return; checkpoint(); l.directed = l.directed ? 0 : 1; scheduleSave(); renderMemoDetails(i); renderCanvas(); });
  ml.querySelectorAll('[data-editlink]').forEach(x => x.onclick = e => {
    e.stopPropagation(); const l = g.links.find(k => k.id === x.dataset.editlink); if (!l) return;
    modal('Relationship', 'How are these two bodies connected?', { label: 'LABEL', value: l.label || '', placeholder: 'e.g. betrays, lives at', confirm: 'Save' }, v => { checkpoint(); l.label = (v || '').trim().slice(0, 120) || null; scheduleSave(); renderMemoDetails(i); });
  });
  const canAppear = ['character', 'location', 'prop'].includes(i.type);
  const appears = canAppear ? linkedTo(g, i.id).filter(x => x.type === 'scene') : [];
  $('#appears-section').classList.toggle('hidden', !canAppear);
  $('#appears-list').innerHTML = appears.map(s => `<div class="appear-row" data-openlink="${s.id}"><i class="type-dot" style="background:${color(s)}"></i><span>${esc(s.title || 'Untitled')}</span><span class="link-label">EP ${s.episode || '—'} · ${s.sequence || '—'}</span></div>`).join('') || '<span class="table-sub">No linked scenes yet.</span>';
  $('#appears-list').querySelectorAll('[data-openlink]').forEach(x => x.onclick = () => openMemo(x.dataset.openlink));
  $('#memo-tasks').innerHTML = (i.tasks || []).map(t => `<label class="task-row ${t.done ? 'done' : ''}"><input type="checkbox" ${t.done ? 'checked' : ''} data-task="${esc(t.id)}" /><span>${esc(t.text)}</span><button class="row-remove" data-rmtask="${esc(t.id)}" aria-label="Remove task">×</button></label>`).join('');
  $('#memo-tasks').querySelectorAll('[data-task]').forEach(x => x.onchange = () => { toggleTask(i.id, x.dataset.task); renderMemoDetails(i); renderCounters(); });
  $('#memo-tasks').querySelectorAll('[data-rmtask]').forEach(x => x.onclick = e => { e.preventDefault(); checkpoint(); i.tasks = i.tasks.filter(t => t.id !== x.dataset.rmtask); scheduleSave(); renderMemoDetails(i); renderCounters(); });
  const open = (i.tasks || []).filter(t => !t.done).length;
  $('#memo-task-count').textContent = open ? `· ${open} OPEN` : '';
  $('#memo-refs').innerHTML = (i.refs || []).map((r, n) => `<div class="ref-row">${isImage(r.url) ? `<img class="ref-thumb" src="${escAttr(safeUrl(r.url))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span>↗</span>'}<a href="${escAttr(safeUrl(r.url))}" target="_blank" rel="noreferrer noopener">${esc(r.label || r.url)}</a><button class="row-remove" data-rmref="${n}" aria-label="Remove reference">×</button></div>`).join('') || '<span class="table-sub">No references yet.</span>';
  $('#memo-refs').querySelectorAll('[data-rmref]').forEach(x => x.onclick = () => { checkpoint(); i.refs.splice(+x.dataset.rmref, 1); scheduleSave(); renderMemoDetails(i); });
}
function bindMemo() {
  const bind = (sel, key) => $(sel).addEventListener('input', e => {
    const i = activeItem(); if (!i) return;
    checkpointText(); i[key] = e.target.value; i.updated_at = now();
    $('#memo-saved').textContent = 'MODIFIED JUST NOW';
    scheduleSave();
    if (key === 'title' || key === 'summary') { renderCanvas(); if (currentView !== 'galaxy') renderLens(); }
  });
  bind('#memo-title', 'title'); bind('#memo-summary', 'summary'); bind('#memo-body', 'body');
  $('#memo-type').onchange = e => { const i = activeItem(); if (!i) return; checkpoint(); i.type = e.target.value; if (!i.category_id) i.category_id = state.active.categories[0]?.id || null; i.updated_at = now(); scheduleSave(); openMemo(i.id); if (currentView !== 'galaxy') renderLens(); };
  $('#memo-category').onchange = e => { const i = activeItem(); if (!i) return; checkpoint(); i.category_id = e.target.value || null; i.updated_at = now(); scheduleSave(); renderCanvas(); };
  [['#memo-act', 'act'], ['#memo-episode', 'episode'], ['#memo-sequence', 'sequence']].forEach(([sel, k]) => $(sel).oninput = e => {
    const i = activeItem(); if (!i) return;
    checkpointText(); i[k] = e.target.value ? +e.target.value : null; i.updated_at = now(); scheduleSave();
    if (currentView !== 'galaxy') renderLens(); else renderCanvas();
  });
  $('#memo-close').onclick = () => memo.classList.add('hidden');
  $('#preview-toggle').onclick = () => {
    const on = $('#memo-preview').classList.contains('hidden');
    $('#memo-preview').classList.toggle('hidden', !on); $('#memo-body').classList.toggle('hidden', on);
    $('#memo-preview').innerHTML = on ? markdown($('#memo-body').value) : '';
    $('#preview-toggle').textContent = on ? 'Edit' : 'Preview';
  };
  $('#task-add').onclick = () => { $('#new-task').classList.toggle('hidden'); $('#new-task').focus(); };
  $('#new-task').onkeydown = e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const i = activeItem(); if (!i) return;
    checkpoint(); i.tasks.push({ id: uid(), text: e.target.value.trim().slice(0, 500), done: false });
    e.target.value = ''; e.target.classList.add('hidden'); i.updated_at = now(); scheduleSave(); renderMemoDetails(i); renderCounters();
  };
  $('#ref-add').onclick = () => modal('Add a reference', 'Link to an image or web page that helps you see the idea.', { label: 'LABEL', value: 'Reference', secondLabel: 'URL', secondPlaceholder: 'https://…', confirm: 'Add reference' }, (label, url) => {
    url = (url || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { toast('Use a full http(s) link'); return; }
    const i = activeItem(); if (!i) return;
    checkpoint(); i.refs.push({ label: (label || url).slice(0, 200), url }); i.updated_at = now(); scheduleSave(); renderMemoDetails(i);
  });
  $('#link-add').onclick = () => chooseLink();
  $('#delete-item').onclick = () => {
    const i = activeItem(); if (!i) return;
    checkpoint(); i.deleted_at = now(); i.updated_at = now(); selected = null; memo.classList.add('hidden');
    scheduleSave(); showView(); renderCounters(); toast('Moved to trash');
  };
  $('#galaxy-name').oninput = e => { checkpointText(); state.active.name = e.target.value.slice(0, 160); scheduleSave(); };
  $('#back-home').onclick = () => { memo.classList.add('hidden'); flush(); renderHome(); };
  $('#add-item').onclick = $('#canvas-add').onclick = () => createItem();
  $('#create-galaxy').onclick = createGalaxy;
  $('#empty-map [data-new-item]')?.addEventListener('click', () => createItem());
  $('#lens-tabs').onclick = e => { const b = e.target.closest('[data-view]'); if (b) { currentView = b.dataset.view; showView(); } };
  $('#search-toggle').onclick = () => { const x = $('#search'); x.classList.toggle('open'); if (x.classList.contains('open')) x.focus(); else { x.value = ''; search = ''; showView(); } };
  $('#search').oninput = e => { search = e.target.value; currentView === 'galaxy' ? renderCanvas() : renderLens(); };
  $('#filter-toggle').onclick = toggleFilters;
  $('#more-menu').onclick = e => showMenu(e.currentTarget, [['Undo', undo], ['Redo', redo], ['Export full JSON', () => exportGalaxy(state.active)], ['Export breakdown', exportBreakdown], ['Trash', showTrash], ['Add category', addCategory], ['Manage categories', manageCategories], ['Import backup', importGalaxy]]);
  $('#layout-toggle').onclick = e => showMenu(e.currentTarget, [
    ['Free layout', () => { layout = 'free'; $('#layout-toggle').innerHTML = '✧ <span>Free</span><span class="chevron">⌄</span>'; renderCanvas(); }],
    ['Timeline layout (read-only)', () => { layout = 'timeline'; $('#layout-toggle').innerHTML = '✧ <span>Timeline</span><span class="chevron">⌄</span>'; renderCanvas(); }]]);
  $('#zoom-in').onclick = () => zoomBy(1.2);
  $('#zoom-out').onclick = () => zoomBy(1 / 1.2);
  $('#recenter').onclick = () => { camera = { x: 0, y: 0, zoom: 1 }; renderCanvas(); };
}
function toggleTask(itemId, taskId) {
  const i = state.active.items.find(x => x.id === itemId), t = i?.tasks.find(x => x.id === taskId);
  if (t) { checkpoint(); t.done = !t.done; i.updated_at = now(); scheduleSave(); }
}
function createLink(from, to, label = null, directed = 0) {
  const g = state.active;
  if (!g || from === to) return false;
  if (g.links.some(l => (l.from_id === from && l.to_id === to) || (l.from_id === to && l.to_id === from))) { toast('Already linked'); return false; }
  checkpoint();
  g.links.push({ id: uid(), galaxy_id: g.id, from_id: from, to_id: to, label, directed });
  scheduleSave(); renderCanvas(); renderCounters();
  const i = activeItem(); if (i && !memo.classList.contains('hidden')) renderMemoDetails(i);
  toast('Linked');
  return true;
}
function chooseLink() {
  const i = activeItem(), others = liveItems().filter(x => x.id !== i.id);
  if (!others.length) { toast('Add another body before linking'); return; }
  const opts = others.map(x => `<option value="${x.id}">${esc(x.title || 'Untitled')} · ${TYPE_LABEL[x.type]}</option>`).join('');
  layer.innerHTML = `<div class="modal-card"><h2>Connect a body</h2><p>Make a relationship visible in your story galaxy.</p><label>BODY</label><select id="link-target" class="modal-input">${opts}</select><label>RELATIONSHIP (OPTIONAL)</label><input id="link-label" class="modal-input" placeholder="e.g. betrays, lives at" /><label class="filter-check"><input id="link-directed" type="checkbox" /> Direction matters</label><div class="modal-actions"><button class="button button-quiet" data-cancel>Cancel</button><button class="button button-primary" data-confirm>Connect</button></div></div>`;
  layer.classList.remove('hidden');
  layer.querySelector('[data-cancel]').onclick = closeModal;
  layer.querySelector('[data-confirm]').onclick = () => {
    const to = $('#link-target').value, label = $('#link-label').value.trim().slice(0, 120) || null, directed = $('#link-directed').checked ? 1 : 0;
    closeModal(); createLink(i.id, to, label, directed);
  };
}
function renderCounters() {
  $('#body-total').textContent = `${liveItems().length} BODIES`;
  $('#link-total').textContent = `${state.active?.links.length || 0} LINKS`;
  $('#task-count').textContent = liveItems().reduce((n, i) => n + (i.tasks?.filter(t => !t.done).length || 0), 0);
  $('#empty-map').classList.toggle('hidden', liveItems().length > 0 || currentView !== 'galaxy');
  const fc = Object.values(filters).filter(Boolean).length;
  $('#filter-count').textContent = fc; $('#filter-count').classList.toggle('hidden', !fc);
}
function toggleFilters() {
  if ($('#filter-pop')) { $('#filter-pop').remove(); return; }
  const pop = document.createElement('div'); pop.id = 'filter-pop'; pop.className = 'filters-pop';
  pop.innerHTML = `<label>TYPE</label><select id="f-type"><option value="">Any type</option>${TYPES.map(t => `<option value="${t}" ${filters.type === t ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select><label>CATEGORY</label><select id="f-category"><option value="">Any category</option>${state.active.categories.map(c => `<option value="${c.id}" ${filters.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><label>EPISODE</label><select id="f-episode"><option value="">Any episode</option>${[...new Set(liveItems().map(i => i.episode).filter(Boolean))].sort((a, b) => a - b).map(n => `<option ${String(n) === filters.episode ? 'selected' : ''}>${n}</option>`).join('')}</select><label class="filter-check"><input id="f-tasks" type="checkbox" ${filters.tasks ? 'checked' : ''}/> Has open tasks</label>`;
  $('.lens-bar').appendChild(pop);
  pop.querySelectorAll('select,input').forEach(x => x.onchange = () => {
    filters = { type: $('#f-type').value, category: $('#f-category').value, episode: $('#f-episode').value, tasks: $('#f-tasks').checked };
    renderCounters(); currentView === 'galaxy' ? renderCanvas() : renderLens();
  });
}
function showTrash() {
  const trash = state.active.items.filter(i => i.deleted_at);
  layer.innerHTML = `<div class="modal-card"><div class="section-head"><div><h2>Trash</h2><p>Restore a body or clear it forever.</p></div><button class="icon-button" data-cancel>×</button></div>${trash.map(i => `<div class="trash-row"><div>${esc(i.title || 'Untitled')}<small>${TYPE_LABEL[i.type]} · moved ${ago(i.deleted_at)}</small></div><div class="trash-actions"><button data-restore="${i.id}">Restore</button><button data-purge="${i.id}">Delete</button></div></div>`).join('') || '<div class="empty-state">Trash is empty.</div>'}<div class="modal-actions"><button class="button button-quiet" data-cancel>Close</button></div></div>`;
  layer.classList.remove('hidden');
  layer.querySelectorAll('[data-cancel]').forEach(b => b.onclick = closeModal);
  layer.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => { const i = state.active.items.find(x => x.id === b.dataset.restore); checkpoint(); i.deleted_at = null; i.updated_at = now(); closeModal(); scheduleSave(); showView(); renderCounters(); });
  layer.querySelectorAll('[data-purge]').forEach(b => b.onclick = () => {
    checkpoint();
    state.active.items = state.active.items.filter(x => x.id !== b.dataset.purge);
    state.active.links = state.active.links.filter(l => l.from_id !== b.dataset.purge && l.to_id !== b.dataset.purge);
    showTrash(); scheduleSave(); renderCounters();
  });
}
function addCategory() {
  modal('New category', 'Give a group of story elements its own colour.', { label: 'CATEGORY NAME', value: 'New category', secondLabel: 'COLOR', secondValue: '#ae9bea', confirm: 'Add category' }, (name, col) => {
    if (!name) return;
    checkpoint(); state.active.categories.push({ id: uid(), galaxy_id: state.active.id, name: name.slice(0, 80), color: col });
    scheduleSave(); if (selected) openMemo(selected); toast('Category added');
  });
}
function manageCategories() {
  layer.innerHTML = `<div class="modal-card"><h2>Categories</h2><p>Rename a category, change its colour, or remove it.</p>${state.active.categories.map(c => `<div class="trash-row"><div><i class="color-swatch" style="background:${escAttr(c.color)}"></i>${esc(c.name)}</div><div class="trash-actions"><button data-editcat="${c.id}">Edit</button><button data-delcat="${c.id}">Remove</button></div></div>`).join('')}<div class="modal-actions"><button class="button button-quiet" data-cancel>Close</button></div></div>`;
  layer.classList.remove('hidden');
  layer.querySelectorAll('[data-cancel]').forEach(b => b.onclick = closeModal);
  layer.querySelectorAll('[data-editcat]').forEach(b => b.onclick = () => {
    const c = state.active.categories.find(x => x.id === b.dataset.editcat); closeModal();
    modal('Edit category', '', { label: 'CATEGORY NAME', value: c.name, secondLabel: 'COLOR', secondValue: c.color, confirm: 'Save' }, (name, col) => { checkpoint(); c.name = (name || c.name).slice(0, 80); c.color = col; scheduleSave(); if (selected) openMemo(selected); renderCanvas(); manageCategories(); });
  });
  layer.querySelectorAll('[data-delcat]').forEach(b => b.onclick = () => {
    const id = b.dataset.delcat; checkpoint();
    state.active.categories = state.active.categories.filter(c => c.id !== id);
    state.active.items.forEach(i => { if (i.category_id === id) i.category_id = null; });
    scheduleSave(); renderCanvas(); manageCategories();
  });
}
function exportGalaxy(g) { download(`${slug(g.name)}.json`, JSON.stringify({ ...g, exported_at: new Date().toISOString() }, null, 2), 'application/json'); }
function exportBreakdown() {
  const g = state.active, scenes = liveItems().filter(i => i.type === 'scene').sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999) || bySeq(a, b));
  let md = `# ${g.name} — Scene breakdown\n\n`, current = '';
  scenes.forEach(s => {
    const ep = s.episode ? `Episode ${s.episode}` : 'Unassigned';
    if (ep !== current) { current = ep; md += `## ${ep}\n\n`; }
    const linked = linkedTo(g, s.id), names = t => linked.filter(i => i.type === t).map(i => i.title).join(', ') || '—';
    md += `### ${s.sequence || '—'}. ${s.title}\n${s.summary || ''}\n\n- Cast: ${names('character')}\n- Locations: ${names('location')}\n- Props: ${names('prop')}\n\n`;
  });
  download(`${slug(g.name)}-breakdown.md`, md, 'text/markdown');
}
function importGalaxy() {
  modal('Import a galaxy', 'Choose a Kosmolugika JSON backup. It will be added as a new galaxy.', { label: 'BACKUP FILE', file: true, confirm: 'Import backup' }, async file => {
    if (!file) return;
    try {
      let g = JSON.parse(await file.text());
      if (!Array.isArray(g.items) || !Array.isArray(g.categories)) throw Error();
      g = structuredClone(g);
      const news = uid(), map = new Map([[g.id, news]]);
      g.id = news; g.name = `${(g.name || 'Imported galaxy').slice(0, 150)} (import)`; g.created_at = now();
      g.categories.forEach(c => { const o = c.id; c.id = uid(); c.galaxy_id = news; map.set(o, c.id); });
      g.items.forEach(i => { const o = i.id; i.id = uid(); i.galaxy_id = news; i.category_id = map.get(i.category_id) || null; map.set(o, i.id); });
      g.links = (g.links || []).filter(l => map.has(l.from_id) && map.has(l.to_id)).map(l => ({ ...l, id: uid(), galaxy_id: news, from_id: map.get(l.from_id), to_id: map.get(l.to_id) }));
      delete g.exported_at;
      state.galaxies.unshift(g); saveGalaxy(g); renderHome(); openGalaxy(news); toast('Backup imported');
    } catch { toast('That file is not a Kosmolugika backup'); }
  });
}
function modal(title, desc, config = {}, onConfirm = () => {}) {
  layer.innerHTML = `<div class="modal-card"><h2>${esc(title)}</h2><p>${esc(desc)}</p>${config.file ? `<label>${config.label}</label><input id="modal-file" class="modal-input" type="file" accept="application/json" />` : `${config.label ? `<label>${config.label}</label><input id="modal-value" class="modal-input" value="${escAttr(config.value || '')}" placeholder="${escAttr(config.placeholder || '')}" />` : ''}${config.secondLabel ? `<label>${config.secondLabel}</label><input id="modal-second" class="modal-input" type="${config.secondLabel === 'COLOR' ? 'color' : 'text'}" value="${escAttr(config.secondValue || '')}" placeholder="${escAttr(config.secondPlaceholder || '')}" />` : ''}`}<div class="modal-actions"><button class="button button-quiet" data-cancel>Cancel</button><button class="button ${config.danger ? 'button-quiet' : 'button-primary'}" data-confirm>${esc(config.confirm || 'Save')}</button></div></div>`;
  layer.classList.remove('hidden');
  const confirm = () => { const first = config.file ? $('#modal-file').files[0] : $('#modal-value')?.value; const second = $('#modal-second')?.value; closeModal(); onConfirm(first, second); };
  layer.querySelector('[data-cancel]').onclick = closeModal;
  layer.querySelector('[data-confirm]').onclick = confirm;
  layer.onkeydown = e => { if (e.key === 'Enter' && !config.secondLabel) confirm(); if (e.key === 'Escape') closeModal(); };
  $('#modal-value')?.focus(); $('#modal-value')?.select();
}
function closeModal() { layer.classList.add('hidden'); layer.innerHTML = ''; layer.onkeydown = null; }
function showMenu(anchor, actions) {
  const p = $('#popover');
  p.innerHTML = actions.map((a, i) => `<button data-action="${i}">${esc(a[0])}</button>`).join('');
  p.classList.remove('hidden');
  p.querySelectorAll('button').forEach(b => b.onclick = () => { p.classList.add('hidden'); actions[+b.dataset.action][1](); });
  const r = anchor.getBoundingClientRect();
  p.style.top = `${Math.min(r.bottom + 5, innerHeight - Math.min(actions.length * 38 + 12, innerHeight - 20))}px`;
  p.style.right = `${Math.max(12, innerWidth - r.right)}px`;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2100); }
function ago(t) { if (!t) return 'JUST NOW'; const d = Math.max(0, now() - t); return d < 60 ? 'JUST NOW' : d < 3600 ? `${Math.floor(d / 60)}M AGO` : d < 86400 ? `${Math.floor(d / 3600)}H AGO` : `${Math.floor(d / 86400)}D AGO`; }
function slug(s) { return (s || 'galaxy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function download(name, data, type) { const a = document.createElement('a'), url = URL.createObjectURL(new Blob([data], { type })); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

/* ---------- galaxy canvas (on-demand 2D renderer; WebGL instancing comes in the next phase) ---------- */
function initCanvas() {
  canvas = $('#galaxy-canvas'); context = canvas.getContext('2d');
  stars = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), a: .08 + Math.random() * .22, r: .3 + Math.random() * .8 }));
  new ResizeObserver(() => renderCanvas()).observe($('#canvas-wrap'));
  bindCanvasEvents();
}
function degreeMap() { const m = new Map(); state.active.links.forEach(l => { m.set(l.from_id, (m.get(l.from_id) || 0) + 1); m.set(l.to_id, (m.get(l.to_id) || 0) + 1); }); return m; }
function worldPositions() {
  const g = state.active; if (!g) return [];
  const items = filteredItems(true), deg = degreeMap();
  if (layout === 'timeline') {
    const groups = new Map();
    items.forEach(i => { const k = i.episode || i.act || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    const map = new Map();
    [...groups.keys()].sort((a, b) => a - b).forEach((k, arm) => groups.get(k).sort(bySeq).forEach((i, n) => { const angle = n * .54 + arm * 2.3, r = 48 + n * 16; map.set(i.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r }); }));
    return items.map(i => ({ item: i, pos: map.get(i.id), deg: deg.get(i.id) || 0 }));
  }
  const placed = new Map();
  items.forEach(i => { if (i.x || i.y) placed.set(i.id, { x: i.x, y: i.y }); });
  const catIndex = new Map(g.categories.map((c, n) => [c.id, n]));
  let k = 0, auto = false;
  items.forEach(i => {
    if (placed.has(i.id)) return;
    const link = g.links.find(l => (l.from_id === i.id && placed.has(l.to_id)) || (l.to_id === i.id && placed.has(l.from_id)));
    const near = link ? placed.get(link.from_id === i.id ? link.to_id : link.from_id) : null;
    const angle = k * 2.399 + (catIndex.get(i.category_id) || 0) * 1.1, r = 50 + Math.sqrt(k) * 24; k++;
    const p = near ? { x: near.x + Math.cos(angle) * 54, y: near.y + Math.sin(angle) * 54 } : { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    i.x = p.x; i.y = p.y; placed.set(i.id, p); auto = true;
  });
  if (auto) scheduleSave(); // persist auto-placed positions once
  return items.map(i => ({ item: i, pos: placed.get(i.id), deg: deg.get(i.id) || 0 }));
}
function renderCanvas() {
  if (!canvas || !context) return;
  const r = canvas.getBoundingClientRect(), w = r.width, h = r.height;
  if (!w || !h) return;
  const d = Math.min(devicePixelRatio || 1, 2), bw = Math.round(w * d), bh = Math.round(h * d);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  context.setTransform(d, 0, 0, d, 0, 0);
  const g = state.active;
  context.clearRect(0, 0, w, h);
  const bg = context.createRadialGradient(w * .5, h * .5, 10, w * .5, h * .5, Math.max(w, h) * .75);
  bg.addColorStop(0, '#0d1019'); bg.addColorStop(1, '#080b11');
  context.fillStyle = bg; context.fillRect(0, 0, w, h);
  stars.forEach(s => { context.beginPath(); context.fillStyle = `rgba(188,194,224,${s.a})`; context.arc(s.x * w, s.y * h, s.r, 0, TAU); context.fill(); });
  if (!g) return;

  const list = worldPositions(), by = new Map(list.map(e => [e.item.id, e]));
  const sx = x => w / 2 + (x - camera.x) * camera.zoom, sy = y => h / 2 + (y - camera.y) * camera.zoom;
  const heavy = list.length > 200, q = search.toLowerCase();
  points = [];

  context.lineWidth = 1;
  g.links.forEach(l => {
    const a = by.get(l.from_id), b = by.get(l.to_id); if (!a || !b) return;
    const x1 = sx(a.pos.x), y1 = sy(a.pos.y), x2 = sx(b.pos.x), y2 = sy(b.pos.y);
    if ((x1 < -50 && x2 < -50) || (x1 > w + 50 && x2 > w + 50) || (y1 < -50 && y2 < -50) || (y1 > h + 50 && y2 > h + 50)) return;
    const chosen = selected === a.item.id || selected === b.item.id || hoverId === a.item.id || hoverId === b.item.id;
    const grad = context.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, color(a.item, .65)); grad.addColorStop(1, color(b.item, .62));
    context.strokeStyle = grad; context.globalAlpha = chosen ? .72 : .28;
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
    if (l.directed) {
      const ang = Math.atan2(y2 - y1, x2 - x1), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      context.fillStyle = color(b.item, .8); context.beginPath();
      context.moveTo(mx + Math.cos(ang) * 4, my + Math.sin(ang) * 4);
      context.lineTo(mx + Math.cos(ang + 2.6) * 4, my + Math.sin(ang + 2.6) * 4);
      context.lineTo(mx + Math.cos(ang - 2.6) * 4, my + Math.sin(ang - 2.6) * 4);
      context.fill();
    }
  });
  context.globalAlpha = 1;
  if (linkDrag) {
    const a = by.get(linkDrag.from);
    if (a) { context.strokeStyle = 'rgba(222,215,255,.6)'; context.setLineDash([4, 4]); context.beginPath(); context.moveTo(sx(a.pos.x), sy(a.pos.y)); context.lineTo(linkDrag.x, linkDrag.y); context.stroke(); context.setLineDash([]); }
  }

  list.forEach(e => {
    const i = e.item, n = e.deg, x = sx(e.pos.x), y = sy(e.pos.y);
    const base = { scene: 5, character: 6, location: 6.4, prop: 3.5, lore: 8, note: 2.6 }[i.type];
    const size = Math.min(12, base + Math.min(n, 4) * .55) * Math.min(1.25, Math.sqrt(camera.zoom));
    if (x < -30 || x > w + 30 || y < -30 || y > h + 30) return;
    const c = color(i), on = selected === i.id || hoverId === i.id || linkFrom === i.id, glow = Math.min(n, 5);
    const match = !q || `${i.title} ${i.summary}`.toLowerCase().includes(q) || (i.body || '').toLowerCase().includes(q);
    const A = match ? 1 : .12;
    context.save(); context.translate(x, y);
    context.shadowColor = c; context.shadowBlur = heavy ? (on ? 14 : 0) : (on ? 17 : 5 + glow * 2);
    context.fillStyle = c; context.strokeStyle = c; context.globalAlpha = A;
    if (heavy && !on) { context.beginPath(); context.arc(0, 0, size * (1.6 + glow * .15), 0, TAU); context.globalAlpha = A * .1; context.fill(); context.globalAlpha = A; }
    if (i.type === 'location') {
      context.beginPath(); context.ellipse(0, 0, size * 1.9, size * .7, 0, -.2, Math.PI * 1.65); context.globalAlpha = A * .6; context.lineWidth = 1; context.stroke();
      context.globalAlpha = A; context.beginPath(); context.arc(0, 0, size * .72, 0, TAU); context.fill();
    } else if (i.type === 'character') {
      context.beginPath(); context.arc(0, 0, size * 1.5, 0, TAU); context.globalAlpha = A * .1; context.fill();
      context.globalAlpha = A; context.beginPath();
      for (let j = 0; j < 8; j++) { const ang = j * Math.PI / 4 - Math.PI / 2, rr = j % 2 ? size * .52 : size * 1.15; j === 0 ? context.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr) : context.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr); }
      context.closePath(); context.fill();
    } else if (i.type === 'lore') {
      context.beginPath(); context.arc(0, 0, size * 1.2, 0, TAU); context.globalAlpha = A * .34; context.fill();
    } else {
      context.beginPath(); context.arc(0, 0, size * (i.type === 'prop' ? .68 : .8), 0, TAU); context.fill();
    }
    if (on) { context.globalAlpha = .75; context.shadowBlur = 0; context.beginPath(); context.arc(0, 0, size + 5, 0, TAU); context.strokeStyle = c; context.lineWidth = .8; context.stroke(); }
    context.restore();
    points.push({ id: i.id, x, y, size: Math.max(size + 6, 10), item: i });
  });

  // labels: hovered/selected always, plus the nearest ~30 to the centre once zoomed in
  const labels = $('#map-labels'); labels.innerHTML = '';
  const show = points.filter(p => p.id === selected || p.id === hoverId);
  if (camera.zoom > 1.45) {
    const cx = w / 2, cy = h / 2;
    [...points].sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy)).slice(0, 30).forEach(p => { if (!show.includes(p)) show.push(p); });
  }
  show.forEach(p => {
    const el = document.createElement('span'); el.className = 'map-label'; el.textContent = p.item.title || 'Untitled';
    el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; el.style.opacity = p.id === selected || p.id === hoverId ? '1' : '.68';
    labels.append(el);
  });
  renderCounters();
}
function color(i, alpha) {
  const c = state.active?.categories.find(x => x.id === i.category_id)?.color;
  const hex = /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#b5a6ee';
  return alpha ? hexrgba(hex, alpha) : hex;
}
function hexrgba(h, a) {
  const key = h + a; let v = colorCache.get(key);
  if (!v) { const n = parseInt(h.slice(1), 16); v = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; colorCache.set(key, v); }
  return v;
}
function zoomBy(f) { camera.zoom = clamp(camera.zoom * f, .35, 4); renderCanvas(); }
function hitTest(x, y) { for (let k = points.length - 1; k >= 0; k--) { const p = points[k]; if (Math.hypot(p.x - x, p.y - y) < p.size + 5) return p; } return null; }
function setHover(id) { if (hoverId === id) return; hoverId = id; canvas.style.cursor = id ? 'pointer' : ''; renderCanvas(); }

function bindCanvasEvents() {
  const c = canvas, local = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', e => {
    c.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { clearTimeout(longPress); const [p, q] = [...pts.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, zoom: camera.zoom }; pointer = null; return; }
    const { x, y } = local(e), hit = hitTest(x, y), touch = e.pointerType === 'touch';
    if (linkFrom) { // touch link mode: tap the target body
      if (hit && hit.id !== linkFrom) createLink(linkFrom, hit.id);
      linkFrom = null; renderCanvas(); pointer = null; return;
    }
    moved = false;
    pointer = { x: e.clientX, y: e.clientY, cameraX: camera.x, cameraY: camera.y, hit, touch, longPressed: false, checkpointed: false,
      linking: !!hit && e.shiftKey && !touch,
      armed: !!hit && !touch && !e.shiftKey && layout === 'free',
      ix: hit?.item.x, iy: hit?.item.y };
    if (hit && touch) {
      const p = pointer;
      longPress = setTimeout(() => { p.longPressed = true; p.armed = layout === 'free'; navigator.vibrate?.(15); selected = hit.id; renderCanvas(); }, 450);
    }
  });
  c.addEventListener('pointermove', e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { const [p, q] = [...pts.values()]; camera.zoom = clamp(pinch.zoom * (Math.hypot(p.x - q.x, p.y - q.y) / pinch.d), .35, 4); renderCanvas(); return; }
    if (!pointer) { if (e.pointerType === 'mouse') { const { x, y } = local(e); setHover(hitTest(x, y)?.id || null); } return; }
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;
    if (!moved && Math.hypot(dx, dy) > (pointer.touch ? 8 : 4)) { moved = true; if (!pointer.armed) clearTimeout(longPress); }
    if (!moved) return;
    $('.canvas-wrap').classList.add('dragging');
    if (pointer.linking) { linkDrag = { from: pointer.hit.id, ...local(e) }; renderCanvas(); return; }
    if (pointer.armed && pointer.hit) {
      if (!pointer.checkpointed) { checkpoint(); pointer.checkpointed = true; }
      const it = pointer.hit.item; it.x = pointer.ix + dx / camera.zoom; it.y = pointer.iy + dy / camera.zoom;
      renderCanvas(); return;
    }
    camera.x = pointer.cameraX - dx / camera.zoom; camera.y = pointer.cameraY - dy / camera.zoom; renderCanvas();
  });
  const finish = e => {
    pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
    clearTimeout(longPress); $('.canvas-wrap').classList.remove('dragging');
    const p = pointer; pointer = null; if (!p) return;
    if (p.linking) {
      if (moved) { const { x, y } = local(e), t = hitTest(x, y); if (t && t.id !== p.hit.id) createLink(p.hit.id, t.id); }
      linkDrag = null; renderCanvas(); return;
    }
    if (p.hit && moved && p.armed) { p.hit.item.updated_at = now(); scheduleSave(); return; }
    if (p.hit && !moved) {
      if (p.longPressed) { linkFrom = p.hit.id; selected = p.hit.id; toast('Tap another body to link · tap empty space to cancel'); renderCanvas(); return; }
      selected = p.hit.id; openMemo(selected);
    }
  };
  c.addEventListener('pointerup', finish); c.addEventListener('pointercancel', finish);
  c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !pointer) setHover(null); });
  c.addEventListener('wheel', e => {
    e.preventDefault();
    const r = c.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const old = camera.zoom, nz = clamp(old * Math.exp(-e.deltaY * .001), .35, 4);
    camera.x += mx / old - mx / nz; camera.y += my / old - my / nz; camera.zoom = nz; renderCanvas();
  }, { passive: false });
  c.addEventListener('dblclick', e => { const r = c.getBoundingClientRect(); createItem({ x: (e.clientX - r.left - r.width / 2) / camera.zoom + camera.x, y: (e.clientY - r.top - r.height / 2) / camera.zoom + camera.y }); });
  c.addEventListener('contextmenu', e => e.preventDefault());
}
function hotkeys(e) {
  const typing = e.target.matches('input,textarea,select'), mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { memo.classList.add('hidden'); closeModal(); linkFrom = null; return; }
  if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (typing || mod || studio.classList.contains('hidden')) return;
  if (e.key === '/' || e.key === 'f') { $('#search').classList.add('open'); $('#search').focus(); e.preventDefault(); }
  if (e.key === 'n' || e.key === '+') createItem();
}
function markdown(src) {
  return esc(src).replace(/^### (.*$)/gm, '<h3>$1</h3>').replace(/^## (.*$)/gm, '<h2>$1</h2>').replace(/^# (.*$)/gm, '<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>').replace(/\n/g, '<br>');
}
function esc(x = '') { return String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(x = '') { return esc(x).replace(/`/g, '&#96;'); }

boot();
