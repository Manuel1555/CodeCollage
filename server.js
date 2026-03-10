// ============================================================
//  CodeCollab -- Server
//  Node.js + Express + sql.js (SQLite puro JS) + bcryptjs
//
//  NO necesita compilacion - funciona en Windows sin Visual Studio
//
//  Uso:
//    npm install
//    node server.js
//
//  Base de datos: ./codecollab.db
// ============================================================

const express   = require('express');
const cors      = require('cors');
const bcrypt    = require('bcryptjs');
const initSqlJs = require('sql.js');
const path      = require('path');
const http      = require('http');
const fs        = require('fs');

const app     = express();
const PORT    = 3000;
const DB_PATH = path.join(__dirname, 'codecollab.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB SETUP con sql.js ─────────────────────────────────────
let db;
let saveTimer;

function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }, 300);
}

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] Base de datos cargada: codecollab.db');
  } else {
    db = new SQL.Database();
    console.log('[DB] Nueva base de datos creada: codecollab.db');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    UNIQUE NOT NULL,
      name        TEXT    NOT NULL,
      password    TEXT    NOT NULL,
      bio         TEXT    DEFAULT '',
      color       TEXT    DEFAULT '#00ff9d',
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      type        TEXT    DEFAULT 'public',
      owner_id    INTEGER,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id  INTEGER,
      user_id     INTEGER,
      joined_at   TEXT    DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id  INTEGER,
      user_id     INTEGER,
      author      TEXT    NOT NULL,
      username    TEXT    NOT NULL,
      text        TEXT    NOT NULL,
      is_system   INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      language    TEXT    DEFAULT 'html',
      visibility  TEXT    DEFAULT 'private',
      owner_id    INTEGER,
      stars       INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS snippets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      lang        TEXT    NOT NULL,
      code        TEXT    NOT NULL,
      owner_id    INTEGER,
      saved_at    TEXT    DEFAULT (datetime('now'))
    );
  `);

  const count = dbGet('SELECT COUNT(*) as c FROM channels');
  if (!count || count.c === 0) {
    dbRun("INSERT INTO channels (name, type) VALUES ('general', 'public')");
    dbRun("INSERT INTO channels (name, type) VALUES ('code-review', 'public')");
    dbRun("INSERT INTO channels (name, type) VALUES ('random', 'public')");
    console.log('[DB] Canales por defecto creados.');
  }

  saveDB();
}

// ── HELPERS ─────────────────────────────────────────────────
function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbInsert(sql, params = []) {
  db.run(sql, params);
  const row = dbGet('SELECT last_insert_rowid() as id');
  saveDB();
  return row ? row.id : null;
}

function ok(res, data)       { res.json({ ok: true, ...data }); }
function err(res, msg, code) { res.status(code || 400).json({ ok: false, error: msg }); }
function clean(str)          { return String(str || '').replace(/[^\x00-\x7F]/g, '').trim(); }

const COLORS = [
  'linear-gradient(135deg,#00ff9d,#00f7ff)',
  'linear-gradient(135deg,#a855f7,#ec4899)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#3b82f6,#06b6d4)',
  'linear-gradient(135deg,#10b981,#6366f1)',
];

// ── AUTH ────────────────────────────────────────────────────

app.post('/api/signup', (req, res) => {
  let { username, name, password } = req.body;
  username = clean(username).toLowerCase();
  name     = clean(name);
  if (!username || !name || !password) return err(res, 'Todos los campos son requeridos.');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return err(res, 'Username: 3-20 caracteres, letras/numeros/guion bajo.');
  if (password.length < 6) return err(res, 'La contrasena debe tener minimo 6 caracteres.');
  if (dbGet('SELECT id FROM users WHERE username = ?', [username])) return err(res, 'Username ya en uso.');

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const hash  = bcrypt.hashSync(password, 10);
  const id    = dbInsert('INSERT INTO users (username, name, password, color) VALUES (?, ?, ?, ?)', [username, name, hash, color]);

  for (const ch of dbAll("SELECT id FROM channels WHERE type = 'public'")) {
    dbRun('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [ch.id, id]);
  }

  ok(res, { user: dbGet('SELECT id, username, name, bio, color, created_at FROM users WHERE id = ?', [id]) });
});

app.post('/api/login', (req, res) => {
  let { username, password } = req.body;
  username = clean(username).toLowerCase();
  if (!username || !password) return err(res, 'Username y password requeridos.');
  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) return err(res, 'Usuario o contrasena incorrectos.');
  const { password: _, ...safe } = user;
  ok(res, { user: safe });
});

app.get('/api/users/search', (req, res) => {
  const q = clean(req.query.q || '').toLowerCase();
  ok(res, { users: q
    ? dbAll("SELECT id, username, name, color FROM users WHERE username LIKE ? OR LOWER(name) LIKE ? LIMIT 8", [`%${q}%`, `%${q}%`])
    : dbAll("SELECT id, username, name, color FROM users LIMIT 50") });
});

app.get('/api/users/:username', (req, res) => {
  const user = dbGet('SELECT id, username, name, bio, color, created_at FROM users WHERE username = ?', [req.params.username.toLowerCase()]);
  if (!user) return err(res, 'Usuario no encontrado.', 404);
  ok(res, { user });
});

app.put('/api/users/:username', (req, res) => {
  dbRun('UPDATE users SET name = ?, bio = ? WHERE username = ?', [clean(req.body.name), clean(req.body.bio), req.params.username.toLowerCase()]);
  ok(res, { user: dbGet('SELECT id, username, name, bio, color FROM users WHERE username = ?', [req.params.username.toLowerCase()]) });
});

// ── CHANNELS ────────────────────────────────────────────────

app.get('/api/channels', (req, res) => {
  const username = clean(req.query.username || '').toLowerCase();
  const user     = username ? dbGet('SELECT id FROM users WHERE username = ?', [username]) : null;
  const sql = `SELECT c.*, u.username as owner_username,
    (SELECT COUNT(*) FROM channel_members WHERE channel_id = c.id) as member_count
    FROM channels c LEFT JOIN users u ON u.id = c.owner_id`;
  ok(res, { channels: user
    ? dbAll(sql + ` WHERE c.type='public' OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id=?) ORDER BY c.created_at ASC`, [user.id])
    : dbAll(sql + ` WHERE c.type='public' ORDER BY c.created_at ASC`) });
});

app.post('/api/channels', (req, res) => {
  let { name, type, username } = req.body;
  name = clean(name).replace(/\s+/g, '-').toLowerCase();
  if (!name) return err(res, 'Nombre requerido.');
  const owner = dbGet('SELECT id FROM users WHERE username = ?', [clean(username).toLowerCase()]);
  const id    = dbInsert('INSERT INTO channels (name, type, owner_id) VALUES (?, ?, ?)', [name, type || 'public', owner ? owner.id : null]);
  if (owner) dbRun('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)', [id, owner.id]);
  ok(res, { channel: dbGet('SELECT c.*, (SELECT COUNT(*) FROM channel_members WHERE channel_id=c.id) as member_count FROM channels c WHERE c.id=?', [id]) });
});

app.delete('/api/channels/:id', (req, res) => {
  dbRun('DELETE FROM messages WHERE channel_id = ?',       [req.params.id]);
  dbRun('DELETE FROM channel_members WHERE channel_id = ?',[req.params.id]);
  dbRun('DELETE FROM channels WHERE id = ?',               [req.params.id]);
  ok(res, { deleted: true });
});

app.get('/api/channels/:id/members', (req, res) => {
  ok(res, { members: dbAll(`SELECT u.id, u.username, u.name, u.color, cm.joined_at
    FROM channel_members cm JOIN users u ON u.id=cm.user_id
    WHERE cm.channel_id=? ORDER BY cm.joined_at ASC`, [req.params.id]) });
});

app.post('/api/channels/:id/members', (req, res) => {
  const { username, inviter_username } = req.body;
  const target = dbGet('SELECT id, username, name FROM users WHERE username=?', [clean(username).toLowerCase()]);
  if (!target) return err(res, `Usuario "@${username}" no encontrado.`, 404);
  if (dbGet('SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?', [req.params.id, target.id])) return err(res, `@${username} ya es miembro.`);
  dbRun('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)', [req.params.id, target.id]);
  const inv = dbGet('SELECT name FROM users WHERE username=?', [clean(inviter_username).toLowerCase()]);
  const msg = `${inv ? inv.name : inviter_username} agrego a @${target.username} al canal.`;
  dbInsert("INSERT INTO messages (channel_id, user_id, author, username, text, is_system) VALUES (?, NULL, 'system', 'system', ?, 1)", [req.params.id, msg]);
  broadcast(req.params.id, { type: 'member_added' });
  ok(res, { user: target });
});

app.delete('/api/channels/:id/members/:username', (req, res) => {
  const ch     = dbGet('SELECT * FROM channels WHERE id=?', [req.params.id]);
  if (!ch) return err(res, 'Canal no encontrado.', 404);
  const kicker = dbGet('SELECT id, name FROM users WHERE username=?', [clean(req.body.kicker_username).toLowerCase()]);
  if (!kicker || String(ch.owner_id) !== String(kicker.id)) return err(res, 'Solo el dueno del canal puede expulsar miembros.');
  const target = dbGet('SELECT id FROM users WHERE username=?', [clean(req.params.username).toLowerCase()]);
  if (!target) return err(res, 'Usuario no encontrado.', 404);
  dbRun('DELETE FROM channel_members WHERE channel_id=? AND user_id=?', [ch.id, target.id]);
  dbInsert("INSERT INTO messages (channel_id, user_id, author, username, text, is_system) VALUES (?, NULL, 'system', 'system', ?, 1)", [ch.id, `${kicker.name} expulso a @${req.params.username}.`]);
  broadcast(ch.id, { type: 'member_removed' });
  ok(res, { removed: true });
});

// ── MESSAGES ────────────────────────────────────────────────

app.get('/api/channels/:id/messages', (req, res) => {
  const since = req.query.since;
  ok(res, { messages: since
    ? dbAll(`SELECT m.*, u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.channel_id=? AND m.created_at>? ORDER BY m.created_at ASC`, [req.params.id, since])
    : dbAll(`SELECT m.*, u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.channel_id=? ORDER BY m.created_at ASC LIMIT 200`, [req.params.id]) });
});

app.post('/api/channels/:id/messages', (req, res) => {
  let { text, username, name } = req.body;
  text = String(text || '').replace(/[^\x00-\x7F]/g, '').trim();
  if (!text) return err(res, 'Mensaje vacio.');
  const user = dbGet('SELECT id FROM users WHERE username=?', [clean(username).toLowerCase()]);
  const id   = dbInsert("INSERT INTO messages (channel_id, user_id, author, username, text, is_system) VALUES (?, ?, ?, ?, ?, 0)",
    [req.params.id, user ? user.id : null, clean(name), clean(username).toLowerCase(), text]);
  const msg = dbGet(`SELECT m.*, u.color as user_color FROM messages m LEFT JOIN users u ON u.username=m.username WHERE m.id=?`, [id]);
  broadcast(req.params.id, msg);
  ok(res, { message: msg });
});

// ── PROJECTS ────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  const username = clean(req.query.username || '').toLowerCase();
  const user     = username ? dbGet('SELECT id FROM users WHERE username=?', [username]) : null;
  ok(res, { projects: user
    ? dbAll("SELECT p.*, u.username as owner_username FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.visibility!='private' OR p.owner_id=? ORDER BY p.created_at DESC", [user.id])
    : dbAll("SELECT p.*, u.username as owner_username FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.visibility='public' ORDER BY p.created_at DESC") });
});

app.post('/api/projects', (req, res) => {
  let { name, description, language, visibility, username } = req.body;
  name = clean(name);
  if (!name) return err(res, 'Nombre requerido.');
  const owner = dbGet('SELECT id FROM users WHERE username=?', [clean(username).toLowerCase()]);
  const id    = dbInsert('INSERT INTO projects (name, description, language, visibility, owner_id) VALUES (?, ?, ?, ?, ?)',
    [name, clean(description), language || 'html', visibility || 'private', owner ? owner.id : null]);
  ok(res, { project: dbGet('SELECT * FROM projects WHERE id=?', [id]) });
});

app.delete('/api/projects/:id', (req, res) => { dbRun('DELETE FROM projects WHERE id=?', [req.params.id]); ok(res, { deleted: true }); });

app.put('/api/projects/:id/star', (req, res) => {
  dbRun('UPDATE projects SET stars=stars+1 WHERE id=?', [req.params.id]);
  ok(res, { project: dbGet('SELECT * FROM projects WHERE id=?', [req.params.id]) });
});

// ── SNIPPETS ────────────────────────────────────────────────

app.get('/api/snippets', (req, res) => {
  const username = clean(req.query.username || '').toLowerCase();
  const user     = username ? dbGet('SELECT id FROM users WHERE username=?', [username]) : null;
  ok(res, { snippets: user ? dbAll('SELECT * FROM snippets WHERE owner_id=? ORDER BY saved_at DESC', [user.id]) : [] });
});

app.post('/api/snippets', (req, res) => {
  const { name, lang, code, username } = req.body;
  if (!clean(name)) return err(res, 'Nombre requerido.');
  const owner = dbGet('SELECT id FROM users WHERE username=?', [clean(username).toLowerCase()]);
  const id    = dbInsert('INSERT INTO snippets (name, lang, code, owner_id) VALUES (?, ?, ?, ?)',
    [clean(name), clean(lang), String(code || ''), owner ? owner.id : null]);
  ok(res, { snippet: dbGet('SELECT * FROM snippets WHERE id=?', [id]) });
});

app.delete('/api/snippets/:id', (req, res) => { dbRun('DELETE FROM snippets WHERE id=?', [req.params.id]); ok(res, { deleted: true }); });

// ── STATS ────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const username = clean(req.query.username || '').toLowerCase();
  const user     = username ? dbGet('SELECT id FROM users WHERE username=?', [username]) : null;
  ok(res, { stats: {
    projects: dbGet(user ? 'SELECT COUNT(*) as c FROM projects WHERE owner_id=?' : 'SELECT COUNT(*) as c FROM projects', user ? [user.id] : []).c,
    messages: dbGet('SELECT COUNT(*) as c FROM messages WHERE is_system=0').c,
    snippets: dbGet(user ? 'SELECT COUNT(*) as c FROM snippets WHERE owner_id=?' : 'SELECT COUNT(*) as c FROM snippets', user ? [user.id] : []).c,
    channels: dbGet('SELECT COUNT(*) as c FROM channels').c,
    users:    dbGet('SELECT COUNT(*) as c FROM users').c,
  }});
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
  if (!clients || !clients.size) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) { try { client.write(payload); } catch {} }
}

// ── FALLBACK ─────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── GUARDAR AL CERRAR ────────────────────────────────────────

process.on('SIGINT', () => {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log('\n[DB] Guardado. Hasta luego!');
  process.exit(0);
});

// ── INICIO ───────────────────────────────────────────────────

initDB().then(() => {
  http.createServer(app).listen(PORT, () => {
    console.log(`\n[CodeCollab] http://localhost:${PORT}`);
    console.log(`[DB]         ${DB_PATH}\n`);
  });
}).catch(e => { console.error('[ERROR]', e); process.exit(1); });
