// ============================================================
//  CodeCollab -- Server
//  Node.js + Express + PostgreSQL + bcryptjs
//  Para Render.com (gratis, persistente)
// ============================================================

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const { Pool } = require('pg');
const path    = require('path');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── POSTGRES ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function dbGet(sql, params = []) {
  const res = await query(sql, params);
  return res.rows[0] || null;
}

async function dbAll(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

async function dbRun(sql, params = []) {
  await query(sql, params);
}

async function dbInsert(sql, params = []) {
  // Convierte INSERT ... VALUES (...) a INSERT ... VALUES (...) RETURNING id
  const returning = sql.trim().toUpperCase().includes('RETURNING') ? sql : sql + ' RETURNING id';
  const res = await query(returning, params);
  return res.rows[0]?.id || null;
}

function ok(res, data)       { res.json({ ok: true, ...data }); }
function fail(res, msg, code){ res.status(code || 400).json({ ok: false, error: msg }); }
function clean(str)          { return String(str || '').replace(/[^\x00-\x7F]/g, '').trim(); }

const COLORS = [
  'linear-gradient(135deg,#00ff9d,#00f7ff)',
  'linear-gradient(135deg,#a855f7,#ec4899)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#3b82f6,#06b6d4)',
  'linear-gradient(135deg,#10b981,#6366f1)',
];

// ── SCHEMA ──────────────────────────────────────────────────
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL,
      password   TEXT NOT NULL,
      bio        TEXT DEFAULT '',
      color      TEXT DEFAULT '#00ff9d',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS channels (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT DEFAULT 'public',
      owner_id   INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id INTEGER,
      user_id    INTEGER,
      joined_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      channel_id INTEGER,
      user_id    INTEGER,
      author     TEXT NOT NULL,
      username   TEXT NOT NULL,
      text       TEXT NOT NULL,
      is_system  BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      language    TEXT DEFAULT 'html',
      visibility  TEXT DEFAULT 'private',
      owner_id    INTEGER,
      stars       INTEGER DEFAULT 0,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS snippets (
      id       SERIAL PRIMARY KEY,
      name     TEXT NOT NULL,
      lang     TEXT NOT NULL,
      code     TEXT NOT NULL,
      owner_id INTEGER,
      saved_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const count = await dbGet('SELECT COUNT(*) as c FROM channels');
  if (parseInt(count.c) === 0) {
    await query("INSERT INTO channels (name, type) VALUES ('general','public'),('code-review','public'),('random','public')");
    console.log('[DB] Canales por defecto creados.');
  }
  console.log('[DB] PostgreSQL listo.');
}

// ── AUTH ────────────────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
  try {
    let { username, name, password } = req.body;
    username = clean(username).toLowerCase();
    name     = clean(name);
    if (!username || !name || !password) return fail(res, 'Todos los campos son requeridos.');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail(res, 'Username: 3-20 caracteres, letras/numeros/guion bajo.');
    if (password.length < 6) return fail(res, 'Password minimo 6 caracteres.');
    if (await dbGet('SELECT id FROM users WHERE username=$1', [username])) return fail(res, 'Username ya en uso.');

    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const hash  = bcrypt.hashSync(password, 10);
    const id    = await dbInsert('INSERT INTO users (username,name,password,color) VALUES ($1,$2,$3,$4)', [username, name, hash, color]);

    const pubChannels = await dbAll("SELECT id FROM channels WHERE type='public'");
    for (const ch of pubChannels) {
      await query('INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ch.id, id]);
    }

    const user = await dbGet('SELECT id,username,name,bio,color,created_at FROM users WHERE id=$1', [id]);
    ok(res, { user });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/login', async (req, res) => {
  try {
    let { username, password } = req.body;
    username = clean(username).toLowerCase();
    if (!username || !password) return fail(res, 'Username y password requeridos.');
    const user = await dbGet('SELECT * FROM users WHERE username=$1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) return fail(res, 'Usuario o password incorrectos.');
    const { password: _, ...safe } = user;
    ok(res, { user: safe });
  } catch(e) { fail(res, e.message); }
});

app.get('/api/users/search', async (req, res) => {
  try {
    const q = '%' + clean(req.query.q || '').toLowerCase() + '%';
    const users = await dbAll('SELECT id,username,name,color FROM users WHERE username ILIKE $1 OR name ILIKE $1 LIMIT 8', [q]);
    ok(res, { users });
  } catch(e) { fail(res, e.message); }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const user = await dbGet('SELECT id,username,name,bio,color,created_at FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    if (!user) return fail(res, 'Usuario no encontrado.', 404);
    ok(res, { user });
  } catch(e) { fail(res, e.message); }
});

app.put('/api/users/:username', async (req, res) => {
  try {
    await dbRun('UPDATE users SET name=$1,bio=$2 WHERE username=$3', [clean(req.body.name), clean(req.body.bio), req.params.username.toLowerCase()]);
    const user = await dbGet('SELECT id,username,name,bio,color FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    ok(res, { user });
  } catch(e) { fail(res, e.message); }
});

// ── CHANNELS ────────────────────────────────────────────────

app.get('/api/channels', async (req, res) => {
  try {
    const username = clean(req.query.username || '').toLowerCase();
    const user     = username ? await dbGet('SELECT id FROM users WHERE username=$1', [username]) : null;
    const base = `SELECT c.*,u.username as owner_username,
      (SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) as member_count
      FROM channels c LEFT JOIN users u ON u.id=c.owner_id`;
    const channels = user
      ? await dbAll(base + ` WHERE c.type='public' OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id=$1) ORDER BY c.created_at ASC`, [user.id])
      : await dbAll(base + ` WHERE c.type='public' ORDER BY c.created_at ASC`);
    ok(res, { channels });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/channels', async (req, res) => {
  try {
    let { name, type, username } = req.body;
    name = clean(name).replace(/\s+/g,'-').toLowerCase();
    if (!name) return fail(res, 'Nombre requerido.');
    const owner = await dbGet('SELECT id FROM users WHERE username=$1', [clean(username).toLowerCase()]);
    const id    = await dbInsert('INSERT INTO channels (name,type,owner_id) VALUES ($1,$2,$3)', [name, type||'public', owner?.id||null]);
    if (owner) await query('INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, owner.id]);
    const ch = await dbGet('SELECT c.*,(SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) as member_count FROM channels c WHERE c.id=$1', [id]);
    ok(res, { channel: ch });
  } catch(e) { fail(res, e.message); }
});

app.delete('/api/channels/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM messages WHERE channel_id=$1',        [req.params.id]);
    await dbRun('DELETE FROM channel_members WHERE channel_id=$1', [req.params.id]);
    await dbRun('DELETE FROM channels WHERE id=$1',                [req.params.id]);
    ok(res, { deleted: true });
  } catch(e) { fail(res, e.message); }
});

app.get('/api/channels/:id/members', async (req, res) => {
  try {
    const members = await dbAll(`SELECT u.id,u.username,u.name,u.color,cm.joined_at
      FROM channel_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.channel_id=$1 ORDER BY cm.joined_at ASC`, [req.params.id]);
    ok(res, { members });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/channels/:id/members', async (req, res) => {
  try {
    const { username, inviter_username } = req.body;
    const target = await dbGet('SELECT id,username,name FROM users WHERE username=$1', [clean(username).toLowerCase()]);
    if (!target) return fail(res, `Usuario "@${username}" no encontrado.`, 404);
    const exists = await dbGet('SELECT 1 FROM channel_members WHERE channel_id=$1 AND user_id=$2', [req.params.id, target.id]);
    if (exists) return fail(res, `@${username} ya es miembro.`);
    await query('INSERT INTO channel_members (channel_id,user_id) VALUES ($1,$2)', [req.params.id, target.id]);
    const inv = await dbGet('SELECT name FROM users WHERE username=$1', [clean(inviter_username).toLowerCase()]);
    const msg = `${inv?.name||inviter_username} agrego a @${target.username} al canal.`;
    await query("INSERT INTO messages (channel_id,author,username,text,is_system) VALUES ($1,'system','system',$2,TRUE)", [req.params.id, msg]);
    broadcast(req.params.id, { type:'member_added' });
    ok(res, { user: target });
  } catch(e) { fail(res, e.message); }
});

app.delete('/api/channels/:id/members/:username', async (req, res) => {
  try {
    const ch     = await dbGet('SELECT * FROM channels WHERE id=$1', [req.params.id]);
    if (!ch) return fail(res, 'Canal no encontrado.', 404);
    const kicker = await dbGet('SELECT id,name FROM users WHERE username=$1', [clean(req.body.kicker_username).toLowerCase()]);
    if (!kicker || String(ch.owner_id) !== String(kicker.id)) return fail(res, 'Solo el dueno puede expulsar miembros.');
    const target = await dbGet('SELECT id FROM users WHERE username=$1', [clean(req.params.username).toLowerCase()]);
    if (!target) return fail(res, 'Usuario no encontrado.', 404);
    await query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [ch.id, target.id]);
    await query("INSERT INTO messages (channel_id,author,username,text,is_system) VALUES ($1,'system','system',$2,TRUE)", [ch.id, `${kicker.name} expulso a @${req.params.username}.`]);
    broadcast(ch.id, { type:'member_removed' });
    ok(res, { removed: true });
  } catch(e) { fail(res, e.message); }
});

// ── MESSAGES ────────────────────────────────────────────────

app.get('/api/channels/:id/messages', async (req, res) => {
  try {
    const since = req.query.since;
    const msgs  = since
      ? await dbAll(`SELECT m.*,u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.channel_id=$1 AND m.created_at>$2 ORDER BY m.created_at ASC`, [req.params.id, since])
      : await dbAll(`SELECT m.*,u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.channel_id=$1 ORDER BY m.created_at ASC LIMIT 200`, [req.params.id]);
    ok(res, { messages: msgs });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/channels/:id/messages', async (req, res) => {
  try {
    let { text, username, name } = req.body;
    text = String(text||'').replace(/[^\x00-\x7F]/g,'').trim();
    if (!text) return fail(res, 'Mensaje vacio.');
    const user = await dbGet('SELECT id FROM users WHERE username=$1', [clean(username).toLowerCase()]);
    const id   = await dbInsert('INSERT INTO messages (channel_id,user_id,author,username,text,is_system) VALUES ($1,$2,$3,$4,$5,FALSE)',
      [req.params.id, user?.id||null, clean(name), clean(username).toLowerCase(), text]);
    const msg  = await dbGet(`SELECT m.*,u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.id=$1`, [id]);
    broadcast(req.params.id, msg);
    ok(res, { message: msg });
  } catch(e) { fail(res, e.message); }
});

// ── PROJECTS ────────────────────────────────────────────────

app.get('/api/projects', async (req, res) => {
  try {
    const username = clean(req.query.username||'').toLowerCase();
    const user     = username ? await dbGet('SELECT id FROM users WHERE username=$1',[username]) : null;
    const projects = user
      ? await dbAll("SELECT p.*,u.username as owner_username FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.visibility!='private' OR p.owner_id=$1 ORDER BY p.created_at DESC",[user.id])
      : await dbAll("SELECT p.*,u.username as owner_username FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.visibility='public' ORDER BY p.created_at DESC");
    ok(res, { projects });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/projects', async (req, res) => {
  try {
    let { name, description, language, visibility, username } = req.body;
    name = clean(name);
    if (!name) return fail(res, 'Nombre requerido.');
    const owner = await dbGet('SELECT id FROM users WHERE username=$1',[clean(username).toLowerCase()]);
    const id    = await dbInsert('INSERT INTO projects (name,description,language,visibility,owner_id) VALUES ($1,$2,$3,$4,$5)',
      [name, clean(description), language||'html', visibility||'private', owner?.id||null]);
    ok(res, { project: await dbGet('SELECT * FROM projects WHERE id=$1',[id]) });
  } catch(e) { fail(res, e.message); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try { await dbRun('DELETE FROM projects WHERE id=$1',[req.params.id]); ok(res,{deleted:true}); }
  catch(e) { fail(res, e.message); }
});

app.put('/api/projects/:id/star', async (req, res) => {
  try {
    await dbRun('UPDATE projects SET stars=stars+1 WHERE id=$1',[req.params.id]);
    ok(res, { project: await dbGet('SELECT * FROM projects WHERE id=$1',[req.params.id]) });
  } catch(e) { fail(res, e.message); }
});

// ── SNIPPETS ────────────────────────────────────────────────

app.get('/api/snippets', async (req, res) => {
  try {
    const username = clean(req.query.username||'').toLowerCase();
    const user     = username ? await dbGet('SELECT id FROM users WHERE username=$1',[username]) : null;
    ok(res, { snippets: user ? await dbAll('SELECT * FROM snippets WHERE owner_id=$1 ORDER BY saved_at DESC',[user.id]) : [] });
  } catch(e) { fail(res, e.message); }
});

app.post('/api/snippets', async (req, res) => {
  try {
    const { name, lang, code, username } = req.body;
    if (!clean(name)) return fail(res, 'Nombre requerido.');
    const owner = await dbGet('SELECT id FROM users WHERE username=$1',[clean(username).toLowerCase()]);
    const id    = await dbInsert('INSERT INTO snippets (name,lang,code,owner_id) VALUES ($1,$2,$3,$4)',
      [clean(name), clean(lang), String(code||''), owner?.id||null]);
    ok(res, { snippet: await dbGet('SELECT * FROM snippets WHERE id=$1',[id]) });
  } catch(e) { fail(res, e.message); }
});

app.delete('/api/snippets/:id', async (req, res) => {
  try { await dbRun('DELETE FROM snippets WHERE id=$1',[req.params.id]); ok(res,{deleted:true}); }
  catch(e) { fail(res, e.message); }
});

// ── STATS ────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const username = clean(req.query.username||'').toLowerCase();
    const user     = username ? await dbGet('SELECT id FROM users WHERE username=$1',[username]) : null;
    ok(res, { stats: {
      projects: parseInt((await dbGet(user?'SELECT COUNT(*) as c FROM projects WHERE owner_id=$1':'SELECT COUNT(*) as c FROM projects', user?[user.id]:[])).c),
      messages: parseInt((await dbGet('SELECT COUNT(*) as c FROM messages WHERE is_system=FALSE')).c),
      snippets: parseInt((await dbGet(user?'SELECT COUNT(*) as c FROM snippets WHERE owner_id=$1':'SELECT COUNT(*) as c FROM snippets', user?[user.id]:[])).c),
      channels: parseInt((await dbGet('SELECT COUNT(*) as c FROM channels')).c),
      users:    parseInt((await dbGet('SELECT COUNT(*) as c FROM users')).c),
    }});
  } catch(e) { fail(res, e.message); }
});

// ── SSE LIVE CHAT ────────────────────────────────────────────

const sseClients = new Map();

app.get('/api/channels/:id/live', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const channelId = String(req.params.id);
  if (!sseClients.has(channelId)) sseClients.set(channelId, new Set());
  sseClients.get(channelId).add(res);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseClients.get(channelId)?.delete(res); });
});

function broadcast(channelId, data) {
  const clients = sseClients.get(String(channelId));
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) { try { client.write(payload); } catch {} }
}

// ── FALLBACK ─────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── INICIO ───────────────────────────────────────────────────

initDB().then(() => {
  http.createServer(app).listen(PORT, () => {
    console.log(`\n[CodeCollab] http://localhost:${PORT}`);
    console.log(`[DB] PostgreSQL conectado\n`);
  });
}).catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
