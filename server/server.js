// 《摘星》ZSky P1 后端 v0.2 —— Express + SQLite + SSE
// 一切数值以服务器计算为准；星光为情侣共享资产。
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = 3000;
const BASE_RATE = 12;        // 基础星光/小时
const OBS_BONUS = 4;         // 观星台每级 +4/h
const CONS_BONUS = 3;        // 每个星座 +3/h
const CAP_HOURS = 12;        // 离线封顶
const WELCOME_GIFT = 30;     // 创建见面礼
const PARTNER_ACTIVE_H = 48; // 伴侣 48h 内活跃 → +30%
const DAILY_REWARD = 20;     // 双人任务奖励
const GIFT_COST = [20, 50, 120];   // 小星/亮星/彩星
const GIFT_NAMES = ['小星', '亮星', '彩星'];
const MSG_COST = 10;         // 星语瓶
const MSG_DELAY_H = 6;       // 星语瓶 6 小时后才能开启
const CONS_NAMES = ['天琴座', '天鹅座', '仙后座', '猎户座', '天鹰座', '大熊座'];
const CONS_COST = i => 30 + 20 * i; // 第 i+1 个星座（0 基）
const OBS_COST = level => 40 * level; // 升到 level+1 级
const BINARY_LEVEL_GATE = 6; // 观星台+星座总等级 ≥6 或 第12天 解锁双星

const db = new Database(__dirname + '/zsky.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  recovery TEXT,
  sky_id INTEGER,
  last_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_code TEXT UNIQUE NOT NULL,
  starlight INTEGER NOT NULL DEFAULT 0,
  obs_level INTEGER NOT NULL DEFAULT 1,
  const_count INTEGER NOT NULL DEFAULT 0,
  binary_name TEXT,
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
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  from_player INTEGER NOT NULL,
  type INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gifts_sky ON gifts(sky_id, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  from_player INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_sky ON messages(sky_id, id);
CREATE TABLE IF NOT EXISTS daily (
  player_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  collected INTEGER NOT NULL DEFAULT 0,
  poked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);
CREATE TABLE IF NOT EXISTS daily_claim (
  sky_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (sky_id, day)
);
CREATE TABLE IF NOT EXISTS chronicle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chr_sky ON chronicle(sky_id, id);
`);

const app = express();
app.use(express.json());

const now = () => Date.now();
const dayKey = (d = new Date()) => {
  const z = new Date(d.getTime() + 8 * 3600e3); // 统一按北京时间记日
  return z.toISOString().slice(0, 10);
};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const NAMES = ['星野', '月见', '晚风', '拾光', '云雀', '远山', '澄空', '小满', '白露', '枕星', '聆汐', '逐光'];
const rand = a => a[Math.floor(Math.random() * a.length)];

function weatherOf(d = new Date()) {
  const key = dayKey(d);
  const h = parseInt(crypto.createHash('md5').update(key).digest('hex').slice(0, 4), 16);
  const w = h % 10;
  if (w < 5) return { name: '晴夜', mult: 1.2 };
  if (w < 8) return { name: '薄云', mult: 1.0 };
  return { name: '多云', mult: 0.8 };
}
const goldenNow = () => { const h = new Date(Date.now() + 8 * 3600e3).getUTCHours(); return h >= 21 && h < 23; };

// ---- SSE 连接表
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
  if (first) { const me = P(id); if (me) { const t = partnerOf(me); if (t) sendTo(t.id, 'partner_online', { name: me.name }); } }
}
function removeConn(id, res) {
  const set = online.get(id);
  if (!set) return;
  set.delete(res);
  if (!set.size) {
    online.delete(id);
    const me = P(id); if (me) { const t = partnerOf(me); if (t) sendTo(t.id, 'partner_offline', {}); }
  }
}
const P = id => db.prepare('SELECT * FROM players WHERE id=?').get(id);

// ---- 身份
function authPlayer(req) {
  const token = req.header('x-token') || req.query.token;
  if (!token) return null;
  const p = db.prepare('SELECT * FROM players WHERE token=?').get(token) || null;
  if (p) db.prepare('UPDATE players SET last_active=? WHERE id=?').run(now(), p.id);
  return p;
}
function requirePlayer(req, res) {
  const p = authPlayer(req);
  if (!p) { res.status(401).json({ error: 'unauthorized' }); return null; }
  return p;
}
const pubPlayer = p => ({ id: p.id, name: p.name, skyId: p.sky_id || null, hasRecovery: !!p.recovery });

// ---- 成长与数值
const dayIndex = sky => Math.floor((now() - sky.created_at) / 86400e3) + 1;
function consGateOf(sky, count) {
  const d = dayIndex(sky);
  if (count >= 2 && d < 4) return '第 4 天起可继续点亮';
  if (count >= 4 && d < 8) return '第 8 天起可继续点亮';
  return null;
}
function rateOf(sky, partner) {
  const obs = (sky.obs_level - 1) * OBS_BONUS;
  const cons = sky.const_count * CONS_BONUS;
  const base = BASE_RATE + obs + cons;
  const partnerActive = partner && (now() - partner.last_active) < PARTNER_ACTIVE_H * 3600e3;
  return { base, obs, cons, partnerActive, total: base * (partnerActive ? 1.3 : 1) };
}
function pendingOf(sky, partner) {
  const hours = Math.min((now() - sky.last_collected_at) / 3.6e6, CAP_HOURS);
  const r = rateOf(sky, partner);
  return Math.floor(hours * r.total * weatherOf().mult);
}
const binaryUnlocked = sky => sky.obs_level - 1 + sky.const_count >= BINARY_LEVEL_GATE || dayIndex(sky) >= 12;

// ---- 星历
function chron(skyId, kind, text) {
  db.prepare('INSERT INTO chronicle(sky_id,kind,text,created_at) VALUES(?,?,?,?)').run(skyId, kind, text, now());
}
function ensureDayEntry(p, sky) {
  const d = dayIndex(sky), key = 'day:' + d;
  const has = db.prepare('SELECT 1 FROM chronicle WHERE sky_id=? AND kind=?').get(sky.id, key);
  if (has) return;
  const c = db.prepare('SELECT COUNT(*) c FROM pokes WHERE sky_id=?').get(sky.id).c;
  chron(sky.id, key, `第 ${d} 天 · 你们互相想念了 ${c} 次`);
}

// ---- 每日任务
function dailyOf(p, sky) {
  const day = dayKey();
  const me = db.prepare('SELECT * FROM daily WHERE player_id=? AND day=?').get(p.id, day) || { collected: 0, poked: 0 };
  const t = partnerOf(p);
  const ta = t ? (db.prepare('SELECT * FROM daily WHERE player_id=? AND day=?').get(t.id, day) || { collected: 0, poked: 0 }) : { collected: 0, poked: 0 };
  const claimed = !!db.prepare('SELECT 1 FROM daily_claim WHERE sky_id=? AND day=?').get(sky.id, day);
  const claimable = !claimed && t && me.collected && me.poked && ta.collected && ta.poked;
  return { me, ta, reward: DAILY_REWARD, claimable, claimed };
}
function markDaily(playerId, field) {
  db.prepare(`INSERT INTO daily(player_id,day,${field}) VALUES(?,?,1)
    ON CONFLICT(player_id,day) DO UPDATE SET ${field}=1`).run(playerId, dayKey());
}

// ---- 状态聚合
function skyOf(p) {
  if (!p.sky_id) return null;
  const sky = db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return null;
  const partner = partnerOf(p);
  ensureDayEntry(p, sky);
  const c = db.prepare(`SELECT
    SUM(CASE WHEN from_player=? THEN 1 ELSE 0 END) AS mine,
    SUM(CASE WHEN from_player<>? THEN 1 ELSE 0 END) AS theirs
    FROM pokes WHERE sky_id=?`).get(p.id, p.id, sky.id);
  const last = db.prepare('SELECT MAX(id) m FROM pokes WHERE sky_id=?').get(sky.id).m || 0;
  const r = rateOf(sky, partner);
  const gifts = db.prepare('SELECT id,type,x,y,created_at,from_player FROM gifts WHERE sky_id=? ORDER BY id DESC LIMIT 80').all(sky.id)
    .map(g => ({ ...g, mine: g.from_player === p.id }));
  const giftCount = db.prepare('SELECT COUNT(*) c FROM gifts WHERE sky_id=?').get(sky.id).c;
  const msgs = db.prepare('SELECT id,from_player,text,created_at,opened_at FROM messages WHERE sky_id=? ORDER BY id DESC LIMIT 30').all(sky.id)
    .map(m => {
      const mine = m.from_player === p.id;
      const openable = now() >= m.created_at + MSG_DELAY_H * 3600e3;
      return {
        id: m.id, mine, at: m.created_at,
        text: (!mine && m.opened_at) || mine ? m.text : null, // 密封中不返回内容
        opened: !!m.opened_at, openable,
        openAt: m.created_at + MSG_DELAY_H * 3600e3,
      };
    });
  const consNextIdx = sky.const_count;
  const consNext = consNextIdx < CONS_NAMES.length ? {
    name: CONS_NAMES[consNextIdx], cost: CONS_COST(consNextIdx),
    locked: consGateOf(sky, consNextIdx),
  } : null;
  const chrCount = db.prepare('SELECT COUNT(*) c FROM chronicle WHERE sky_id=?').get(sky.id).c;
  return {
    id: sky.id,
    inviteCode: partner ? null : sky.invite_code,
    starlight: sky.starlight,
    pending: pendingOf(sky, partner),
    rate: r,
    weather: weatherOf(),
    golden: goldenNow(),
    day: dayIndex(sky),
    observatory: { level: sky.obs_level, nextCost: OBS_COST(sky.obs_level), bonus: r.obs },
    constellations: { count: sky.const_count, names: CONS_NAMES.slice(0, sky.const_count), next: consNext },
    binary: { unlocked: binaryUnlocked(sky), name: sky.binary_name },
    gifts: { received: gifts.filter(g => !g.mine), given: gifts.filter(g => g.mine).length, total: giftCount },
    messages: { items: msgs, unread: msgs.filter(m => !m.mine && !m.opened && m.openable).length },
    daily: dailyOf(p, sky),
    partner: partner ? { name: partner.name, online: isOnline(partner.id), lastActive: partner.last_active } : null,
    pokes: { mine: c.mine || 0, theirs: c.theirs || 0 },
    lastPokeId: last,
    chronicleCount: chrCount,
  };
}

// ---- 玩家
app.post('/api/player/init', (req, res) => {
  const existing = authPlayer(req);
  if (existing) return res.json({ token: existing.token, player: pubPlayer(existing), sky: skyOf(existing) });
  const token = crypto.randomBytes(24).toString('hex');
  const name = (req.body && req.body.name) || rand(NAMES);
  const r = db.prepare('INSERT INTO players(token,name,last_active,created_at) VALUES(?,?,?,?)').run(token, name, now(), now());
  const p = P(r.lastInsertRowid);
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
  const np = P(p.id);
  chron(r.lastInsertRowid, 'create', `✨ 一片新的星空诞生了`);
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
  const np = P(p.id);
  const t = partnerOf(np);
  chron(sky.id, 'join', `🌟 ${t ? t.name : ''} 与 ${np.name} 的星相遇了`);
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
  const gained = Math.floor(pendingOf(sky, partnerOf(p)) * (golden ? 2 : 1));
  db.prepare('UPDATE skies SET starlight=starlight+?, last_collected_at=? WHERE id=?').run(gained, now(), sky.id);
  if (gained > 0) markDaily(p.id, 'collected');
  res.json({ gained, golden, starlight: sky.starlight + gained });
});

// ---- 成长：观星台 / 星座 / 双星
app.post('/api/sky/upgrade', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const cost = OBS_COST(sky.obs_level);
  if (sky.starlight < cost) return res.status(400).json({ error: `星光不足，升级需要 ${cost}` });
  db.prepare('UPDATE skies SET starlight=starlight-?, obs_level=obs_level+1 WHERE id=?').run(cost, sky.id);
  chron(sky.id, 'obs', `🔭 观星台升到 ${sky.obs_level + 1} 级，星光更快汇聚`);
  res.json({ ok: true, level: sky.obs_level + 1, cost, starlight: sky.starlight - cost });
});
app.post('/api/sky/constellation', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const idx = sky.const_count;
  if (idx >= CONS_NAMES.length) return res.status(400).json({ error: '所有星座都已点亮' });
  const gate = consGateOf(sky, idx);
  if (gate) return res.status(400).json({ error: gate });
  const cost = CONS_COST(idx);
  if (sky.starlight < cost) return res.status(400).json({ error: `星光不足，点亮需要 ${cost}` });
  db.prepare('UPDATE skies SET starlight=starlight-?, const_count=const_count+1 WHERE id=?').run(cost, sky.id);
  const cname = CONS_NAMES[idx];
  chron(sky.id, 'cons:' + idx, `✦ 点亮了${cname}，夜空更亮了一些`);
  res.json({ ok: true, name: cname, cost, starlight: sky.starlight - cost });
});
app.post('/api/binary/name', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  if (!binaryUnlocked(sky)) return res.status(400).json({ error: '双星尚未成形（总等级 6 或第 12 天解锁）' });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '名字不能为空' });
  const first = !sky.binary_name;
  db.prepare('UPDATE skies SET binary_name=? WHERE id=?').run(name, sky.id);
  if (first) chron(sky.id, 'binary', `💫 双星被命名为「${name}」——两颗星，永远绕转`);
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'binary', { name });
  res.json({ ok: true, name });
});

// ---- 摘星送 Ta
app.post('/api/gift', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const type = [0, 1, 2].includes(req.body.type) ? req.body.type : 0;
  const cost = GIFT_COST[type];
  if (sky.starlight < cost) return res.status(400).json({ error: `星光不足，${GIFT_NAMES[type]}需要 ${cost}` });
  const x = +(0.06 + Math.random() * 0.88).toFixed(3), y = +(0.06 + Math.random() * 0.6).toFixed(3);
  db.prepare('UPDATE skies SET starlight=starlight-? WHERE id=?').run(cost, sky.id);
  const r = db.prepare('INSERT INTO gifts(sky_id,from_player,type,x,y,created_at) VALUES(?,?,?,?,?,?)')
    .run(sky.id, p.id, type, x, y, now());
  const total = db.prepare('SELECT COUNT(*) c FROM gifts WHERE sky_id=?').get(sky.id).c;
  if (total === 1) chron(sky.id, 'gift:1', `💫 第一颗星被摘下，送给了 Ta`);
  if (total === 10) chron(sky.id, 'gift:10', `💫 第十颗星！Ta 的夜空渐渐璀璨`);
  if (total === 50) chron(sky.id, 'gift:50', `💫 第五十颗星，银河为证`);
  markDaily(p.id, 'poked'); // 送星也算今日互动
  res.json({ ok: true, id: r.lastInsertRowid, type, x, y, cost, starlight: sky.starlight - cost });
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'gift', { id: r.lastInsertRowid, type, x, y, name: p.name });
});
app.get('/api/gifts', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  res.json({ sky: skyOf(p) ? { gifts: skyOf(p).gifts } : null });
});

// ---- 星语瓶
app.post('/api/message', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const text = String(req.body.text || '').trim().slice(0, 50);
  if (!text) return res.status(400).json({ error: '写点什么吧' });
  if (sky.starlight < MSG_COST) return res.status(400).json({ error: `星光不足，星语瓶需要 ${MSG_COST}` });
  db.prepare('UPDATE skies SET starlight=starlight-? WHERE id=?').run(MSG_COST, sky.id);
  const r = db.prepare('INSERT INTO messages(sky_id,from_player,text,created_at) VALUES(?,?,?,?)')
    .run(sky.id, p.id, text, now());
  res.json({ ok: true, id: r.lastInsertRowid, openAt: now() + MSG_DELAY_H * 3600e3, starlight: sky.starlight - MSG_COST });
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'message', { id: r.lastInsertRowid, name: p.name, openAt: now() + MSG_DELAY_H * 3600e3 });
});
app.post('/api/message/open', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(req.body.id);
  if (!m || m.sky_id !== p.sky_id) return res.status(404).json({ error: '星语瓶不存在' });
  if (m.from_player === p.id) return res.status(400).json({ error: '这是你送出的瓶子' });
  if (m.opened_at) return res.json({ ok: true, text: m.text, already: true });
  if (now() < m.created_at + MSG_DELAY_H * 3600e3) return res.status(400).json({ error: '瓶子还在漂来的路上' });
  db.prepare('UPDATE messages SET opened_at=? WHERE id=?').run(now(), m.id);
  res.json({ ok: true, text: m.text });
});

// ---- 想念 · 戳一戳
app.post('/api/poke', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (!p.sky_id) return res.status(400).json({ error: '还没有星空' });
  const r = db.prepare('INSERT INTO pokes(sky_id,from_player,created_at) VALUES(?,?,?)').run(p.sky_id, p.id, now());
  markDaily(p.id, 'poked');
  const total = db.prepare('SELECT COUNT(*) c FROM pokes WHERE sky_id=?').get(p.sky_id).c;
  if (total === 1) chron(p.sky_id, 'poke:1', `💌 第一次想念，流星为你划过`);
  if (total === 100) chron(p.sky_id, 'poke:100', `💌 第 100 次想念`);
  if (total === 500) chron(p.sky_id, 'poke:500', `💌 第 500 次想念，想念成了习惯`);
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

// ---- 每日双人任务领奖
app.post('/api/daily/claim', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const d = dailyOf(p, sky);
  if (d.claimed) return res.status(400).json({ error: '今天的奖励已经领过啦' });
  if (!d.claimable) return res.status(400).json({ error: '两人都完成收集和想念后才能领取' });
  db.prepare('INSERT INTO daily_claim(sky_id,day) VALUES(?,?)').run(sky.id, dayKey());
  db.prepare('UPDATE skies SET starlight=starlight+? WHERE id=?').run(DAILY_REWARD, sky.id);
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'daily', { reward: DAILY_REWARD });
  res.json({ ok: true, reward: DAILY_REWARD, starlight: sky.starlight + DAILY_REWARD });
});

// ---- 星历
app.get('/api/chronicle', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (!p.sky_id) return res.json({ items: [] });
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  const items = db.prepare('SELECT id,text,created_at FROM chronicle WHERE sky_id=? ORDER BY id DESC LIMIT ?')
    .all(p.sky_id, limit);
  res.json({ items });
});

// ---- SSE
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
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch (e) { } }, 25000);
  req.on('close', () => { clearInterval(hb); removeConn(p.id, res); res.end(); });
});

app.listen(PORT, '127.0.0.1', () => console.log('zsky server v0.2 on', PORT));
