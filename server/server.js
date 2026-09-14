// 《摘星》ZSky P1 后端 —— Express + SQLite + SSE
// 领域口径见 ../DESIGN.md；一切数值以服务器计算为准，客户端纯展示。
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = 3000;
const BASE_RATE = 12;      // 星光/小时
const CAP_HOURS = 12;      // 离线收益封顶
const WELCOME_GIFT = 30;   // 创建星空的见面礼（5 秒甜头）

const db = new Database(__dirname + '/zsky.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  recovery TEXT,
  sky_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_code TEXT UNIQUE NOT NULL,
  starlight INTEGER NOT NULL DEFAULT 0,
  last_collected_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pokes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  from_player INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pokes_sky ON pokes(sky_id, id);
`);

const app = express();
app.use(express.json());

const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const NAMES = ['星野','月见','晚风','拾光','云雀','远山','澄空','小满','白露','枕星','聆汐','逐光'];
const rand = a => a[Math.floor(Math.random() * a.length)];

// 每日星象：按日期哈希稳定产出（晴夜×1.2 / 薄云×1.0 / 多云×0.8）
function weatherOf(d = new Date()) {
  const key = d.toISOString().slice(0, 10);
  const h = parseInt(crypto.createHash('md5').update(key).digest('hex').slice(0, 4), 16);
  const w = h % 10;
  if (w < 5) return { name: '晴夜', mult: 1.2 };
  if (w < 8) return { name: '薄云', mult: 1.0 };
  return { name: '多云', mult: 0.8 };
}
function goldenNow() { const h = new Date().getHours(); return h >= 21 && h < 23; }

// ---- SSE 连接表：playerId -> Set<res>（连接即在线）
const online = new Map();
const isOnline = id => online.has(id);
function sendTo(playerId, event, data) {
  const set = online.get(playerId);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(frame);
}
function partnerOf(p) {
  if (!p.sky_id) return null;
  return db.prepare('SELECT * FROM players WHERE sky_id=? AND id<>?').get(p.sky_id, p.id) || null;
}
function addConn(id, res) {
  const first = !online.has(id);
  if (first) online.set(id, new Set());
  online.get(id).add(res);
  if (first) { const me = db.prepare('SELECT * FROM players WHERE id=?').get(id); const t = partnerOf(me); if (t) sendTo(t.id, 'partner_online', { name: me.name }); }
}
function removeConn(id, res) {
  const set = online.get(id);
  if (!set) return;
  set.delete(res);
  if (!set.size) {
    online.delete(id);
    const me = db.prepare('SELECT * FROM players WHERE id=?').get(id);
    if (me) { const t = partnerOf(me); if (t) sendTo(t.id, 'partner_offline', {}); }
  }
}

// ---- 身份
function authPlayer(req) {
  const token = req.header('x-token') || req.query.token;
  if (!token) return null;
  return db.prepare('SELECT * FROM players WHERE token=?').get(token) || null;
}
function requirePlayer(req, res) {
  const p = authPlayer(req);
  if (!p) { res.status(401).json({ error: 'unauthorized' }); return null; }
  return p;
}
function pubPlayer(p) {
  return { id: p.id, name: p.name, skyId: p.sky_id || null, hasRecovery: !!p.recovery };
}
function pendingOf(sky) {
  const hours = Math.min((now() - sky.last_collected_at) / 3.6e6, CAP_HOURS);
  return Math.floor(hours * BASE_RATE * weatherOf().mult);
}
function skyOf(p) {
  if (!p.sky_id) return null;
  const sky = db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return null;
  const partner = partnerOf(p);
  const c = db.prepare(`SELECT
    SUM(CASE WHEN from_player=? THEN 1 ELSE 0 END) AS mine,
    SUM(CASE WHEN from_player<>? THEN 1 ELSE 0 END) AS theirs
    FROM pokes WHERE sky_id=?`).get(p.id, p.id, sky.id);
  const last = db.prepare('SELECT MAX(id) m FROM pokes WHERE sky_id=?').get(sky.id).m || 0;
  const w = weatherOf();
  return {
    id: sky.id,
    inviteCode: partner ? null : sky.invite_code,
    starlight: sky.starlight,
    pending: pendingOf(sky),
    rate: BASE_RATE,
    weather: w,
    golden: goldenNow(),
    partner: partner ? { name: partner.name, online: isOnline(partner.id) } : null,
    pokes: { mine: c.mine || 0, theirs: c.theirs || 0 },
    lastPokeId: last,
  };
}

// ---- 玩家
app.post('/api/player/init', (req, res) => {
  const existing = authPlayer(req);
  if (existing) return res.json({ token: existing.token, player: pubPlayer(existing), sky: skyOf(existing) });
  const token = crypto.randomBytes(24).toString('hex');
  const name = (req.body && req.body.name) || rand(NAMES);
  const r = db.prepare('INSERT INTO players(token,name,created_at) VALUES(?,?,?)').run(token, name, now());
  const p = db.prepare('SELECT * FROM players WHERE id=?').get(r.lastInsertRowid);
  res.json({ token, player: pubPlayer(p), sky: null });
});

app.post('/api/player/recovery', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const code = String(req.body.code || '').trim();
  if (code.length < 4) return res.status(400).json({ error: '找回码至少 4 位' });
  db.prepare('UPDATE players SET recovery=? WHERE id=?').run(sha(code), p.id);
  res.json({ ok: true });
});

app.post('/api/player/restore', (req, res) => {
  const code = String(req.body.code || '').trim();
  const p = db.prepare('SELECT * FROM players WHERE recovery=?').get(sha(code));
  if (!p) return res.status(404).json({ error: '找回码不存在' });
  res.json({ token: p.token, player: pubPlayer(p), sky: skyOf(p) });
});

// ---- 星空
app.post('/api/sky/create', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (p.sky_id) return res.json({ sky: skyOf(p) });
  const name = req.body && req.body.name;
  if (name) db.prepare('UPDATE players SET name=? WHERE id=?').run(String(name).slice(0, 12), p.id);
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const r = db.prepare('INSERT INTO skies(invite_code,starlight,last_collected_at,created_at) VALUES(?,?,?,?)')
    .run(code, WELCOME_GIFT, now(), now());
  db.prepare('UPDATE players SET sky_id=? WHERE id=?').run(r.lastInsertRowid, p.id);
  const np = db.prepare('SELECT * FROM players WHERE id=?').get(p.id);
  res.json({ sky: skyOf(np) });
});

app.post('/api/sky/join', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (p.sky_id) return res.json({ sky: skyOf(p) });
  const code = String(req.body.code || '').trim().toUpperCase();
  const sky = db.prepare('SELECT * FROM skies WHERE invite_code=?').get(code);
  if (!sky) return res.status(404).json({ error: '邀请码不存在' });
  const members = db.prepare('SELECT COUNT(*) c FROM players WHERE sky_id=?').get(sky.id).c;
  if (members >= 2) return res.status(409).json({ error: '这片星空已经有两个人了' });
  const name = req.body && req.body.name;
  if (name) db.prepare('UPDATE players SET name=? WHERE id=?').run(String(name).slice(0, 12), p.id);
  db.prepare('UPDATE players SET sky_id=? WHERE id=?').run(sky.id, p.id);
  const np = db.prepare('SELECT * FROM players WHERE id=?').get(p.id);
  sendTo(np.id, 'noop', {}); // 占位：确保流存在时不报错
  const t = partnerOf(np);
  if (t) sendTo(t.id, 'partner_online', { name: np.name });
  res.json({ sky: skyOf(np) });
});

app.get('/api/sky/state', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  res.json({ player: pubPlayer(p), sky: skyOf(p) });
});

app.post('/api/sky/collect', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const golden = goldenNow();
  const gained = Math.floor(pendingOf(sky) * (golden ? 2 : 1));
  db.prepare('UPDATE skies SET starlight=starlight+?, last_collected_at=? WHERE id=?').run(gained, now(), sky.id);
  res.json({ gained, golden, starlight: sky.starlight + gained });
});

// ---- 想念 · 戳一戳
app.post('/api/poke', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (!p.sky_id) return res.status(400).json({ error: '还没有星空' });
  const r = db.prepare('INSERT INTO pokes(sky_id,from_player,created_at) VALUES(?,?,?)').run(p.sky_id, p.id, now());
  res.json({ ok: true, id: r.lastInsertRowid });
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'poke', { id: r.lastInsertRowid, at: now(), name: p.name });
});

app.get('/api/poke/timeline', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (!p.sky_id) return res.json({ items: [] });
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const items = db.prepare('SELECT id, from_player, created_at FROM pokes WHERE sky_id=? ORDER BY id DESC LIMIT ?')
    .all(p.sky_id, limit)
    .map(x => ({ id: x.id, mine: x.from_player === p.id, at: x.created_at }));
  res.json({ items });
});

// ---- SSE 实时通道
app.get('/api/events', (req, res) => {
  const p = authPlayer(req);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');
  addConn(p.id, res);
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) { /* 对端已断 */ } }, 25000);
  req.on('close', () => { clearInterval(hb); removeConn(p.id, res); res.end(); });
});

app.listen(PORT, '127.0.0.1', () => console.log('zsky server on', PORT));
