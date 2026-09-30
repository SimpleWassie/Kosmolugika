const TYPES = new Set(['scene','character','location','prop','lore','note']);
const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);
const uid = () => crypto.randomUUID();
const time = () => Math.floor(Date.now() / 1000);
const readJson = async request => { try { return await request.json(); } catch { return null; } };
const cleanText = (value, max, required = false) => typeof value === 'string' && value.length <= max && (!required || value.trim()) ? value.trim() : null;
const getGalaxy = (db, id) => db.prepare('SELECT * FROM galaxies WHERE id=?').bind(id).first();
function validateItem(item) {
  if (!item || !TYPES.has(item.type) || !cleanText(item.title, 300, true)) return 'A valid type and non-empty title are required.';
  if (cleanText(item.summary ?? '', 1200) === null || cleanText(item.body ?? '', 50000) === null) return 'Summary or body is too long.';
  if (!Array.isArray(item.tasks) || item.tasks.length > 500 || !Array.isArray(item.refs) || item.refs.length > 100) return 'Invalid tasks or references.';
  return null;
}
async function upsertGalaxy(db, payload) {
  if (!payload || typeof payload !== 'object' || !payload.id || !cleanText(payload.name, 160, true)) throw new Error('Galaxy needs an id and a name.');
  const t = time();
  await db.prepare('INSERT INTO galaxies(id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at').bind(payload.id, payload.name.trim(), payload.created_at || t, t).run();
  for (const [table,rows] of [['links',payload.links||[]],['items',payload.items||[]],['categories',payload.categories||[]]]) {
    if(rows.length){const ids=rows.map(row=>row.id);await db.prepare(`DELETE FROM ${table} WHERE galaxy_id=? AND id NOT IN (${ids.map(()=>'?').join(',')})`).bind(payload.id,...ids).run()}
    else await db.prepare(`DELETE FROM ${table} WHERE galaxy_id=?`).bind(payload.id).run();
  }
  for (const c of (payload.categories || [])) await db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color').bind(c.id, payload.id, String(c.name).slice(0,80), /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#a99af6').run();
  for (const i of (payload.items || [])) {
    const error = validateItem(i); if (error) throw new Error(error);
    await db.prepare(`INSERT INTO items(id,galaxy_id,type,category_id,title,summary,body,act,episode,sequence,tasks,refs,x,y,z,deleted_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,category_id=excluded.category_id,title=excluded.title,summary=excluded.summary,body=excluded.body,act=excluded.act,episode=excluded.episode,sequence=excluded.sequence,tasks=excluded.tasks,refs=excluded.refs,x=excluded.x,y=excluded.y,z=excluded.z,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at`)
      .bind(i.id,payload.id,i.type,i.category_id||null,i.title.trim(),i.summary||'',i.body||'',i.act||null,i.episode||null,i.sequence||null,JSON.stringify(i.tasks||[]),JSON.stringify(i.refs||[]),Number(i.x)||0,Number(i.y)||0,Number(i.z)||0,i.deleted_at||null,i.created_at||t,t).run();
  }
  for (const l of (payload.links || [])) if (l.from_id !== l.to_id) await db.prepare('INSERT OR REPLACE INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(l.id,payload.id,l.from_id,l.to_id,l.label||null,l.directed?1:0).run();
}
async function loadGalaxy(db,id) {
  const galaxy=await getGalaxy(db,id); if(!galaxy)return null;
  const [cats,items,links]=await Promise.all([
    db.prepare('SELECT * FROM categories WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM items WHERE galaxy_id=?').bind(id).all(),
    db.prepare('SELECT * FROM links WHERE galaxy_id=?').bind(id).all()
  ]);
  return {...galaxy,categories:cats.results,items:items.results.map(i=>({...i,tasks:parse(i.tasks),refs:parse(i.refs)})),links:links.results};
}
const parse=s=>{try{return JSON.parse(s||'[]')}catch{return[]}};
async function copyGalaxy(db,id) {
  const g=await loadGalaxy(db,id);if(!g)return null;const map=new Map([[g.id,uid()]]), copy={...g,id:map.get(g.id),name:g.name+' (copy)',created_at:time(),updated_at:time()};
  copy.categories=g.categories.map(c=>{map.set(c.id,uid());return {...c,id:map.get(c.id),galaxy_id:copy.id}});
  copy.items=g.items.map(i=>{map.set(i.id,uid());return {...i,id:map.get(i.id),galaxy_id:copy.id,category_id:map.get(i.category_id)||null,created_at:time(),updated_at:time()}});
  copy.links=g.links.map(l=>({...l,id:uid(),galaxy_id:copy.id,from_id:map.get(l.from_id),to_id:map.get(l.to_id)}));
  await db.batch([db.prepare('INSERT INTO galaxies(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(copy.id,copy.name,copy.created_at,copy.updated_at),...copy.categories.map(c=>db.prepare('INSERT INTO categories(id,galaxy_id,name,color) VALUES(?,?,?,?)').bind(c.id,copy.id,c.name,c.color)),...copy.items.map(i=>db.prepare('INSERT INTO items(id,galaxy_id,type,category_id,title,summary,body,act,episode,sequence,tasks,refs,x,y,z,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(i.id,copy.id,i.type,i.category_id,i.title,i.summary,i.body,i.act,i.episode,i.sequence,JSON.stringify(i.tasks),JSON.stringify(i.refs),i.x,i.y,i.z,i.deleted_at,i.created_at,i.updated_at)),...copy.links.map(l=>db.prepare('INSERT INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(l.id,copy.id,l.from_id,l.to_id,l.label,l.directed))]);
  return copy;
}
export async function onRequest({request,env,params}) {
  const db=env.DB;if(!db)return fail('D1 binding DB is not configured.',503);
  const url=new URL(request.url),parts=url.pathname.split('/').filter(Boolean).slice(1),method=request.method;
  try {
    if(parts[0]==='galaxies'&&parts.length===1&&method==='GET')return json((await db.prepare('SELECT g.*,COUNT(DISTINCT i.id) item_count FROM galaxies g LEFT JOIN items i ON i.galaxy_id=g.id AND i.deleted_at IS NULL GROUP BY g.id ORDER BY g.updated_at DESC').all()).results);
    if(parts[0]==='galaxies'&&parts.length===1&&method==='POST'){
      const b=await readJson(request);if(!cleanText(b?.name,160,true))return fail('Galaxy name required.');const id=b.id||uid(),t=time();
      if(b.categories||b.items)await upsertGalaxy(db,{...b,id,created_at:t,updated_at:t});else await db.prepare('INSERT INTO galaxies VALUES(?,?,?,?)').bind(id,b.name.trim(),t,t).run();return json({id,name:b.name.trim(),created_at:t,updated_at:t,categories:[],items:[],links:[]},201);
    }
    if(parts[0]==='galaxies'&&parts[1]){
      const id=parts[1],g=await getGalaxy(db,id);if(!g)return fail('Galaxy not found.',404);
      if(parts.length===2&&method==='GET')return json(await loadGalaxy(db,id));
      if(parts.length===2&&method==='PATCH'){const b=await readJson(request);if(!cleanText(b?.name,160,true))return fail('Galaxy name required.');await db.prepare('UPDATE galaxies SET name=?,updated_at=? WHERE id=?').bind(b.name.trim(),time(),id).run();return json({ok:true})}
      if(parts.length===2&&method==='DELETE'){await db.prepare('DELETE FROM galaxies WHERE id=?').bind(id).run();return json({ok:true})}
      if(parts[2]==='duplicate'&&method==='POST')return json(await copyGalaxy(db,id),201);
      if(parts[2]==='export'&&method==='GET')return json(await loadGalaxy(db,id));
      if(parts[2]==='sync'&&method==='PUT'){const b=await readJson(request);if(b?.id!==id)return fail('Galaxy id mismatch.');await upsertGalaxy(db,b);return json({ok:true,updated_at:time()})}
    }
    if(parts[0]==='import'&&method==='POST'){const b=await readJson(request);if(!b?.categories||!b?.items)return fail('Invalid galaxy backup.');b.id=uid();b.name=String(b.name||'Imported galaxy').slice(0,150)+' (import)';b.created_at=b.updated_at=time();b.categories.forEach(c=>{c.id=uid();c.galaxy_id=b.id});const ids=new Map();b.items.forEach(i=>{const old=i.id;i.id=uid();ids.set(old,i.id);i.galaxy_id=b.id});b.links=(b.links||[]).map(l=>({...l,id:uid(),galaxy_id:b.id,from_id:ids.get(l.from_id),to_id:ids.get(l.to_id)}));await upsertGalaxy(db,b);return json({id:b.id},201)}
    if(parts[0]==='items'&&method==='POST'){const b=await readJson(request);const error=validateItem(b);if(error)return fail(error);if(!await getGalaxy(db,b.galaxy_id))return fail('Galaxy not found.',404);const t=time();await db.prepare('INSERT INTO items(id,galaxy_id,type,category_id,title,summary,body,act,episode,sequence,tasks,refs,x,y,z,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(b.id||uid(),b.galaxy_id,b.type,b.category_id||null,b.title.trim(),b.summary||'',b.body||'',b.act||null,b.episode||null,b.sequence||null,JSON.stringify(b.tasks||[]),JSON.stringify(b.refs||[]),b.x||0,b.y||0,b.z||0,b.deleted_at||null,t,t).run();return json({ok:true},201)}
    if(parts[0]==='items'&&parts[1]&&method==='PATCH'){const b=await readJson(request);const existing=await db.prepare('SELECT * FROM items WHERE id=?').bind(parts[1]).first();if(!existing)return fail('Item not found.',404);const i={...existing,...b};if(b.tasks)i.tasks=b.tasks;if(b.refs)i.refs=b.refs;const error=validateItem({...i,tasks:i.tasks||parse(i.tasks),refs:i.refs||parse(i.refs)});if(error)return fail(error);await db.prepare('UPDATE items SET type=?,category_id=?,title=?,summary=?,body=?,act=?,episode=?,sequence=?,tasks=?,refs=?,x=?,y=?,z=?,deleted_at=?,updated_at=? WHERE id=?').bind(i.type,i.category_id,i.title,i.summary,i.body,i.act,i.episode,i.sequence,JSON.stringify(Array.isArray(i.tasks)?i.tasks:parse(i.tasks)),JSON.stringify(Array.isArray(i.refs)?i.refs:parse(i.refs)),i.x,i.y,i.z,i.deleted_at||null,time(),parts[1]).run();return json({ok:true})}
    if(parts[0]==='items'&&parts[1]&&method==='DELETE'){await db.prepare('DELETE FROM items WHERE id=?').bind(parts[1]).run();return json({ok:true})}
    if(parts[0]==='items'&&parts[1]==='batch-positions'&&method==='POST'){const b=await readJson(request);if(!Array.isArray(b?.positions)||b.positions.length>1000)return fail('Invalid positions.');await db.batch(b.positions.map(p=>db.prepare('UPDATE items SET x=?,y=?,z=?,updated_at=? WHERE id=?').bind(Number(p.x)||0,Number(p.y)||0,Number(p.z)||0,time(),p.id)));return json({ok:true})}
    if(parts[0]==='links'&&method==='POST'){const b=await readJson(request);if(!b?.galaxy_id||!b.from_id||!b.to_id||b.from_id===b.to_id)return fail('Invalid link.');const [a,c]=await Promise.all([db.prepare('SELECT galaxy_id FROM items WHERE id=?').bind(b.from_id).first(),db.prepare('SELECT galaxy_id FROM items WHERE id=?').bind(b.to_id).first()]);if(!a||!c||a.galaxy_id!==b.galaxy_id||c.galaxy_id!==b.galaxy_id)return fail('Links must stay within one galaxy.');const id=uid();await db.prepare('INSERT INTO links(id,galaxy_id,from_id,to_id,label,directed) VALUES(?,?,?,?,?,?)').bind(id,b.galaxy_id,b.from_id,b.to_id,cleanText(b.label||'',120)||null,b.directed?1:0).run();return json({id},201)}
    if(parts[0]==='links'&&parts[1]&&method==='PATCH'){const b=await readJson(request);await db.prepare('UPDATE links SET label=?,directed=? WHERE id=?').bind(cleanText(b?.label||'',120)||null,b?.directed?1:0,parts[1]).run();return json({ok:true})}
    if(parts[0]==='links'&&parts[1]&&method==='DELETE'){await db.prepare('DELETE FROM links WHERE id=?').bind(parts[1]).run();return json({ok:true})}
    if(parts[0]==='categories'&&method==='POST'){const b=await readJson(request);if(!await getGalaxy(db,b?.galaxy_id)||!cleanText(b?.name,80,true)||!/^#[0-9a-f]{6}$/i.test(b?.color||''))return fail('Invalid category.');const id=uid();await db.prepare('INSERT INTO categories VALUES(?,?,?,?)').bind(id,b.galaxy_id,b.name.trim(),b.color).run();return json({id},201)}
    if(parts[0]==='categories'&&parts[1]&&method==='PATCH'){const b=await readJson(request);if(!cleanText(b?.name,80,true)||!/^#[0-9a-f]{6}$/i.test(b?.color||''))return fail('Invalid category.');await db.prepare('UPDATE categories SET name=?,color=? WHERE id=?').bind(b.name.trim(),b.color,parts[1]).run();return json({ok:true})}
    if(parts[0]==='categories'&&parts[1]&&method==='DELETE'){await db.prepare('UPDATE items SET category_id=NULL WHERE category_id=?').bind(parts[1]).run();await db.prepare('DELETE FROM categories WHERE id=?').bind(parts[1]).run();return json({ok:true})}
    return fail('Not found.',404);
  } catch(error) { return fail(error.message||'Request failed.',400); }
}

