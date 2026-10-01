// Kosmolugika API (Cloudflare Pages Function + D1)
// One catch-all handler for /api/*. Bodies are validated and normalised server-side.

const TYPES = new Set(['scene', 'character', 'location', 'prop', 'lore', 'note']);
const PRESETS = [['Plot', '#df9f82'], ['Character arc', '#d1a2e8'], ['World', '#8eafd8'], ['Theme', '#d2b86f'], ['Visual', '#86c3b3'], ['Production', '#e690aa']];
const HEX = /^#[0-9a-f]{6}$/i;
const CHUNK = 50; // statements per db.batch when syncing large galaxies

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);
const uid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
const readJson = async request => { try { return await request.json(); } catch { return null; } };
const int = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const name160 = v => (typeof v === 'string' && v.trim() && v.length <= 160 ? v.trim() : null);
const short = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
const parseList = v => { if (Array.isArray(v)) return v; try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };

// ---------- Cloudflare Access (defence in depth) ----------
// Enforced only when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set as Pages variables.
async function verifyAccess(request, env) {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return true;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  try {
    const b64 = x => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), c => c.charCodeAt(0));
    const dec = x => JSON.parse(new TextDecoder().decode(b64(x)));
    const header = dec(h), payload = dec(p);
    if (header.alg !== 'RS256') return false;
    const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (payload.iss !== `https://${domain}` || !([].concat(payload.aud)).includes(env.ACCESS_AUD) || payload.exp < now()) return false;
    const certs = await (await fetch(`https://${domain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600, cacheEverything: true } })).json();
    const jwk = certs.keys.find(k => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(s), new TextEncoder().encode(`${h}.${p}`));
  } catch { return false; }
}

// ---------- Normalisation ----------
// lenient: blank titles become "Untitled" (the UI creates blank bodies and autosaves them).
function normItem(i, lenient = false) {
  if (!i || !TYPES.has(i.type)) throw new Error('Invalid item type.');
  let title = short(i.title ?? '', 300);
  if (title === null) throw new Error('Title must be text of at most 300 characters.');
  if (!title) { if (!lenient) throw new Error('A non-empty title is required.'); title = 'Untitled'; }
  const summary = i.summary ?? '', body = i.body ?? '';
  if (typeof summary !== 'string' || summary.length > 1200 || typeof body !== 'string' || body.length > 50000) throw new Error('Summary or body is too long.');
  const tasks = parseList(i.tasks), refs = parseList(i.refs);
  if (tasks.length > 500 || refs.length > 100) throw new Error('Too many tasks or references.');
  return {
    type: i.type,
    category_id: i.category_id || null,
    title, summary, body,
    act: int(i.act), episode: int(i.episode), sequence: int(i.sequence),
    tasks: JSON.stringify(tasks.filter(t => t && typeof t === 'object').map(t => ({ id: String(t.id || uid()).slice(0, 64), text: String(t.text ?? '').slice(0, 500), done: !!t.done }))),
    refs: JSON.stringify(refs.filter(r => r && /^https?:\/\//i.test(String(r.url || ''))).map(r => ({ label: String(r.label || r.url).slice(0, 200), url: String(r.url).slice(0, 2000) }))),
    x: num(i.x), y: num(i.y), z: num(i.z),
    deleted_at: int(i.deleted_at)
  };
}

const ITEM_COLS = ['id', 'galaxy_id', 'type', 'category_id', 'title', 'summary', 'body', 'act', 'episode', 'sequence', 'tasks', 'refs', 'x', 'y', 'z', 'deleted_at', 'created_at', 'updated_at'];
const upsertItem = (db, gid, id, r, created, updated) => db.prepare(
  `INSERT INTO items(${ITEM_COLS.join(',')}) VALUES(${ITEM_COLS.map(() => '?').join(',')})
   ON CONFLICT(id) DO UPDATE SET type=excluded.type,category_id=excluded.category_id,title=excluded.title,summary=excluded.summary,body=excluded.body,act=excluded.act,episode=excluded.episode,sequence=excluded.sequence,tasks=excluded.tasks,refs=excluded.refs,x=excluded.x,y=excluded.y,z=excluded.z,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at
   WHERE items.galaxy_id=excluded.galaxy_id`
).bind(id, gid, r.type, r.category_id, r.title, r.summary, r.body, r.act, r.episode, r.sequence, r.tasks, r.refs, r.x, r.y, r.z, r.deleted_at, created, updated);

const ITEM_DIFF = ['type', 'category_id', 'title', 'summary', 'body', 'act', 'episode', 'sequence', 'tasks', 'refs', 'x', 'y', 'z', 'deleted_at'];
const sameItem = (old, r) => ITEM_DIFF.every(k => (old[k] ?? null) === (r[k] ?? null));

const getGalaxy = (db, id) => db.prepare('SELECT * FROM galaxies WHERE id=?').bind(id).first();

async function loadGalaxy(db, id) {
  const galaxy = await getGalaxy(db, id);
  if (!galaxy) return null;
  const [cats, items, links] = await Promise.all([
    db.prepare('SELECT * FROM categories WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM items WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM links WHERE galaxy_id=?').bind(id).all()
  ]);
  return { ...galaxy, categories: cats.results, items: items.results.map(i => ({ ...i, tasks: parseList(i.tasks), refs: parseList(i.refs) })), links: links.results };
}

// Diff-based write: reads current rows, then writes only what changed (usually one statement per autosave).
// Keeps D1 query counts and bound-parameter counts small regardless of galaxy size.
async function writeGalaxy(db, id, p) {
  const name = name160(p.name);
  if (!name) throw new Error('Galaxy needs a name.');
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const items = Array.isArray(p.items) ? p.items : [];
  const links = Array.isArray(p.links) ? p.links : [];
  if (items.length > 5000 || links.length > 20000 || cats.length > 200) throw new Error('Galaxy is too large.');
  const t = now();

  const [ec, ei, el] = await Promise.all([
    db.prepare('SELECT * FROM categories WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM items WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM links WHERE galaxy_id=?').bind(id).all()
  ]);
  const dels = [], ups = [];

  // categories
  const catSeen = new Set();
  const oldCats = new Map(ec.results.map(r => [r.id, r]));
  for (const c of cats) {
    if (!c || !c.id || catSeen.has(String(c.id))) continue;
    const cid = String(c.id);
    catSeen.add(cid);
    const nm = String(c.name || 'Untitled').slice(0, 80), col = HEX.test(c.color) ? c.color : '#a99af6';
    const o = oldCats.get(cid);
    if (!o || o.name !== nm || o.color !== col) ups.push(db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color WHERE categories.galaxy_id=excluded.galaxy_id').bind(cid, id, nm, col));
  }
  for (const o of ec.results) if (!catSeen.has(o.id)) dels.push(db.prepare('DELETE FROM categories WHERE id=?').bind(o.id));

  // items
  const seen = new Set();
  const oldItems = new Map(ei.results.map(r => [r.id, r]));
  for (const raw of items) {
    if (!raw || !raw.id || seen.has(String(raw.id))) continue;
    const iid = String(raw.id);
    seen.add(iid);
    const r = normItem(raw, true);
    const o = oldItems.get(iid);
    if (!o || !sameItem(o, r)) ups.push(upsertItem(db, id, iid, r, int(raw.created_at) || t, t));
  }
  for (const o of ei.results) if (!seen.has(o.id)) dels.push(db.prepare('DELETE FROM items WHERE id=?').bind(o.id));

  // links (drop dangling, self and duplicate-pair links)
  const linkSeen = new Set(), pairSeen = new Set();
  const oldLinks = new Map(el.results.map(r => [r.id, r]));
  for (const l of links) {
    if (!l || !l.id || linkSeen.has(String(l.id))) continue;
    const from = String(l.from_id), to = String(l.to_id), pair = `${from}|${to}`;
    if (from === to || !seen.has(from) || !seen.has(to) || pairSeen.has(pair)) continue;
    const lid = String(l.id);
    linkSeen.add(lid); pairSeen.add(pair);
    const label = short(l.label ?? '', 120) || null, directed = l.directed ? 1 : 0;
    const o = oldLinks.get(lid);
    if (!o || o.from_id !== from || o.to_id !== to || (o.label ?? null) !== label || o.directed !== directed) ups.push(db.prepare('INSERT OR REPLACE INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(lid, id, from, to, label, directed));
  }
  for (const o of el.results) if (!linkSeen.has(o.id)) dels.push(db.prepare('DELETE FROM links WHERE id=?').bind(o.id));

  const head = db.prepare('INSERT INTO galaxies(id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at').bind(id, name, int(p.created_at) || t, t);
  const stmts = [head, ...dels, ...ups];
  for (let k = 0; k < stmts.length; k += CHUNK) await db.batch(stmts.slice(k, k + CHUNK));
  return t;
}

async function copyGalaxy(db, id) {
  const g = await loadGalaxy(db, id);
  if (!g) return null;
  const t = now(), gid = uid(), map = new Map();
  const cats = g.categories.map(c => { const n = uid(); map.set(c.id, n); return { ...c, id: n }; });
  const items = g.items.map(i => { const n = uid(); map.set(i.id, n); return { ...i, id: n, category_id: map.get(i.category_id) || null }; });
  const links = g.links.filter(l => map.has(l.from_id) && map.has(l.to_id)).map(l => ({ ...l, id: uid(), from_id: map.get(l.from_id), to_id: map.get(l.to_id) }));
  const name = `${g.name} (copy)`.slice(0, 160);
  await db.batch([
    db.prepare('INSERT INTO galaxies(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(gid, name, t, t),
    ...cats.map(c => db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?)').bind(c.id, gid, c.name, c.color)),
    ...items.map(i => db.prepare(`INSERT INTO items(${ITEM_COLS.join(',')}) VALUES(${ITEM_COLS.map(() => '?').join(',')})`).bind(i.id, gid, i.type, i.category_id, i.title, i.summary, i.body, i.act, i.episode, i.sequence, JSON.stringify(i.tasks), JSON.stringify(i.refs), i.x, i.y, i.z, i.deleted_at, i.created_at, t)),
    ...links.map(l => db.prepare('INSERT INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(l.id, gid, l.from_id, l.to_id, l.label, l.directed))
  ]);
  return { id: gid, name, created_at: t, updated_at: t };
}

const chunked = async (db, stmts) => { for (let k = 0; k < stmts.length; k += 100) await db.batch(stmts.slice(k, k + 100)); };

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return fail('D1 binding DB is not configured.', 503);
  if (!(await verifyAccess(request, env))) return fail('Unauthorized.', 401);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const method = request.method;
  const [a, b, c] = parts;

  try {
    // ----- galaxies -----
    if (a === 'galaxies' && !b) {
      if (method === 'GET') {
        const rows = await db.prepare('SELECT g.*,COUNT(DISTINCT i.id) item_count FROM galaxies g LEFT JOIN items i ON i.galaxy_id=g.id AND i.deleted_at IS NULL GROUP BY g.id ORDER BY g.updated_at DESC').all();
        return json(rows.results);
      }
      if (method === 'POST') {
        const body = await readJson(request);
        const name = name160(body?.name);
        if (!name) return fail('Galaxy name required.');
        const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : uid();
        if (await getGalaxy(db, id)) return fail('Galaxy already exists.', 409);
        const t = now();
        if (Array.isArray(body.categories) || Array.isArray(body.items)) {
          await writeGalaxy(db, id, { ...body, name });
          return json({ id, name }, 201);
        }
        const cats = PRESETS.map(([n, col]) => ({ id: uid(), galaxy_id: id, name: n, color: col }));
        await db.batch([
          db.prepare('INSERT INTO galaxies(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(id, name, t, t),
          ...cats.map(k => db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?)').bind(k.id, id, k.name, k.color))
        ]);
        return json({ id, name, created_at: t, updated_at: t, categories: cats, items: [], links: [] }, 201);
      }
    }

    if (a === 'galaxies' && b) {
      // Sync creates the galaxy if it does not exist yet, so it must run before the existence check.
      if (c === 'sync' && method === 'PUT') {
        const body = await readJson(request);
        if (!body || body.id !== b) return fail('Galaxy id mismatch.');
        const updated_at = await writeGalaxy(db, b, body);
        return json({ ok: true, updated_at });
      }
      if (!c && method === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM links WHERE galaxy_id=?').bind(b),
          db.prepare('DELETE FROM items WHERE galaxy_id=?').bind(b),
          db.prepare('DELETE FROM categories WHERE galaxy_id=?').bind(b),
          db.prepare('DELETE FROM galaxies WHERE id=?').bind(b)
        ]);
        return json({ ok: true });
      }
      if (!(await getGalaxy(db, b))) return fail('Galaxy not found.', 404);
      if (!c && method === 'GET') return json(await loadGalaxy(db, b));
      if (!c && method === 'PATCH') {
        const body = await readJson(request);
        const name = name160(body?.name);
        if (!name) return fail('Galaxy name required.');
        await db.prepare('UPDATE galaxies SET name=?,updated_at=? WHERE id=?').bind(name, now(), b).run();
        return json({ ok: true });
      }
      if (c === 'duplicate' && method === 'POST') return json(await copyGalaxy(db, b), 201);
      if (c === 'export' && method === 'GET') return json({ ...(await loadGalaxy(db, b)), exported_at: new Date().toISOString() });
    }

    // ----- import -----
    if (a === 'import' && method === 'POST') {
      const body = await readJson(request);
      if (!body || !Array.isArray(body.categories) || !Array.isArray(body.items)) return fail('Invalid galaxy backup.');
      const gid = uid(), cmap = new Map(), imap = new Map();
      const categories = body.categories.filter(k => k && k.id).map(k => { const n = uid(); cmap.set(k.id, n); return { ...k, id: n }; });
      const items = body.items.filter(i => i && i.id).map(i => { const n = uid(); imap.set(i.id, n); return { ...i, id: n, category_id: cmap.get(i.category_id) || null }; });
      const links = (Array.isArray(body.links) ? body.links : []).map(l => ({ ...l, id: uid(), from_id: imap.get(l.from_id), to_id: imap.get(l.to_id) })).filter(l => l.from_id && l.to_id);
      const name = `${(name160(body.name) || 'Imported galaxy').slice(0, 150)} (import)`;
      await writeGalaxy(db, gid, { name, categories, items, links, created_at: now() });
      return json({ id: gid }, 201);
    }

    // ----- items (batch-positions must be matched before /items/:id) -----
    if (a === 'items' && b === 'batch-positions' && method === 'POST') {
      const body = await readJson(request);
      if (!Array.isArray(body?.positions) || body.positions.length > 1000) return fail('Invalid positions.');
      const t = now();
      await chunked(db, body.positions.filter(p => p && p.id).map(p => db.prepare('UPDATE items SET x=?,y=?,z=?,updated_at=? WHERE id=?').bind(num(p.x), num(p.y), num(p.z), t, String(p.id))));
      return json({ ok: true });
    }
    if (a === 'items' && !b && method === 'POST') {
      const body = await readJson(request);
      if (!body || !(await getGalaxy(db, body.galaxy_id))) return fail('Galaxy not found.', 404);
      const r = normItem(body);
      const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : uid(), t = now();
      await upsertItem(db, body.galaxy_id, id, r, t, t).run();
      return json({ ok: true, id }, 201);
    }
    if (a === 'items' && b && method === 'PATCH') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object') return fail('Invalid body.');
      const ex = await db.prepare('SELECT * FROM items WHERE id=?').bind(b).first();
      if (!ex) return fail('Item not found.', 404);
      const r = normItem({ ...ex, ...body, id: ex.id, galaxy_id: ex.galaxy_id });
      await db.prepare('UPDATE items SET type=?,category_id=?,title=?,summary=?,body=?,act=?,episode=?,sequence=?,tasks=?,refs=?,x=?,y=?,z=?,deleted_at=?,updated_at=? WHERE id=?')
        .bind(r.type, r.category_id, r.title, r.summary, r.body, r.act, r.episode, r.sequence, r.tasks, r.refs, r.x, r.y, r.z, r.deleted_at, now(), b).run();
      return json({ ok: true });
    }
    if (a === 'items' && b && method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM links WHERE from_id=? OR to_id=?').bind(b, b),
        db.prepare('DELETE FROM items WHERE id=?').bind(b)
      ]);
      return json({ ok: true });
    }

    // ----- links -----
    if (a === 'links' && !b && method === 'POST') {
      const body = await readJson(request);
      if (!body?.galaxy_id || !body.from_id || !body.to_id || body.from_id === body.to_id) return fail('Invalid link.');
      const [f, t] = await Promise.all([
        db.prepare('SELECT galaxy_id FROM items WHERE id=?').bind(body.from_id).first(),
        db.prepare('SELECT galaxy_id FROM items WHERE id=?').bind(body.to_id).first()
      ]);
      if (!f || !t || f.galaxy_id !== body.galaxy_id || t.galaxy_id !== body.galaxy_id) return fail('Links must stay within one galaxy.');
      const dup = await db.prepare('SELECT id FROM links WHERE galaxy_id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))').bind(body.galaxy_id, body.from_id, body.to_id, body.to_id, body.from_id).first();
      if (dup) return fail('These bodies are already linked.', 409);
      const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : uid();
      await db.prepare('INSERT INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(id, body.galaxy_id, body.from_id, body.to_id, short(body.label ?? '', 120) || null, body.directed ? 1 : 0).run();
      return json({ id }, 201);
    }
    if (a === 'links' && b && method === 'PATCH') {
      const body = await readJson(request);
      const ex = await db.prepare('SELECT * FROM links WHERE id=?').bind(b).first();
      if (!ex) return fail('Link not found.', 404);
      const label = body && 'label' in body ? short(body.label ?? '', 120) || null : ex.label;
      const directed = body && 'directed' in body ? (body.directed ? 1 : 0) : ex.directed;
      await db.prepare('UPDATE links SET label=?,directed=? WHERE id=?').bind(label, directed, b).run();
      return json({ ok: true });
    }
    if (a === 'links' && b && method === 'DELETE') {
      await db.prepare('DELETE FROM links WHERE id=?').bind(b).run();
      return json({ ok: true });
    }

    // ----- categories -----
    if (a === 'categories' && !b && method === 'POST') {
      const body = await readJson(request);
      const nm = short(body?.name ?? '', 80);
      if (!body || !(await getGalaxy(db, body.galaxy_id)) || !nm || !HEX.test(body.color || '')) return fail('Invalid category.');
      const id = typeof body.id === 'string' && body.id.length <= 64 ? body.id : uid();
      await db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?)').bind(id, body.galaxy_id, nm, body.color).run();
      return json({ id }, 201);
    }
    if (a === 'categories' && b && method === 'PATCH') {
      const body = await readJson(request);
      const nm = short(body?.name ?? '', 80);
      if (!nm || !HEX.test(body?.color || '')) return fail('Invalid category.');
      await db.prepare('UPDATE categories SET name=?,color=? WHERE id=?').bind(nm, body.color, b).run();
      return json({ ok: true });
    }
    if (a === 'categories' && b && method === 'DELETE') {
      await db.batch([
        db.prepare('UPDATE items SET category_id=NULL WHERE category_id=?').bind(b),
        db.prepare('DELETE FROM categories WHERE id=?').bind(b)
      ]);
      return json({ ok: true });
    }

    return fail('Not found.', 404);
  } catch (error) {
    return fail(error?.message || 'Request failed.', 400);
  }
}
