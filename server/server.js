// 《摘星》ZSky P1 后端 v0.2 —— Express + SQLite + SSE
// 一切数值以服务器计算为准；星光为情侣共享资产。
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const PORT = 3000;
const BASE_RATE = 12;        // 产出速率基数（展示与批产计算）
const OBS_BONUS = 4;         // 观星台每级 +4/h
const CONS_BONUS = 3;        // 每个星座 +3/h
const BANK_HOURS = 3;        // 星光最多囤 3 小时
const WELCOME_GIFT = 30;     // 创建见面礼
const PARTNER_ACTIVE_H = 48; // 伴侣 48h 内活跃 → +30%
const DAILY_REWARD = 4;      // 双人任务奖励
const GIFT_COST = [4, 10, 24];     // 小星/亮星/彩星
const GIFT_NAMES = ['小星', '亮星', '彩星'];
const MSG_COST = 2;          // 星语瓶
const MSG_DELAY_H = 6;       // 星语瓶 6 小时后才能开启
const CUSTOM_COST = 4;       // 画一座自定义星座
const CUSTOM_MAX = 3;        // 最多 3 座
const CUSTOM_STARS = [3, 8]; // 每座 3-8 颗星
const CONS_NAMES = ['天琴座', '天鹅座', '仙后座', '猎户座', '天鹰座', '大熊座'];
const CONS_COST = i => 6 + 4 * i;  // 第 i+1 个星座（0 基）
const OBS_COST = level => 8 * level; // 升到 level+1 级
const BINARY_LEVEL_GATE = 6; // 观星台+星座总等级 ≥6 解锁双星
const DRAW_COST = 1;         // 抽奖：每颗星光一次
const WISH_MAX = 6;          // 心愿单最多 6 项
const DEFAULT_WISH = ['一个拥抱', '一杯奶茶', '看一场电影', '睡前故事', '一次晚饭', '一起看日出'];

const db = new Database(__dirname + '/zsky.db');
db.pragma('journal_mode = WAL');
try { db.exec('ALTER TABLE skies ADD COLUMN anniversary TEXT'); } catch (e) { /* 已存在 */ }
try { db.exec('ALTER TABLE players ADD COLUMN zodiac INTEGER'); } catch (e) { /* 已存在 */ }
try { db.exec('ALTER TABLE skies ADD COLUMN eco_v2 INTEGER DEFAULT 0'); } catch (e) { /* 已存在 */ }
db.prepare('UPDATE skies SET starlight=starlight*5, eco_v2=1 WHERE eco_v2=0').run(); // 经济 v2 迁移：存量 ×5 保值
const ZODIAC = [['白羊座', '♈'], ['金牛座', '♉'], ['双子座', '♊'], ['巨蟹座', '♋'], ['狮子座', '♌'], ['处女座', '♍'], ['天秤座', '♎'], ['天蝎座', '♏'], ['射手座', '♐'], ['摩羯座', '♑'], ['水瓶座', '♒'], ['双鱼座', '♓']];
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
CREATE TABLE IF NOT EXISTS custom_cons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  stars TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cc_sky ON custom_cons(sky_id, id);
CREATE TABLE IF NOT EXISTS wishlists (
  player_id INTEGER PRIMARY KEY,
  items TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sky_id INTEGER NOT NULL,
  prize TEXT NOT NULL,
  from_player INTEGER NOT NULL,
  to_player INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tk_sky ON tickets(sky_id, id);
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
const pubPlayer = p => ({ id: p.id, name: p.name, skyId: p.sky_id || null, hasRecovery: !!p.recovery, zodiac: p.zodiac ?? null });

// ---- 成长与数值
function dayIndex(sky) {
  if (sky.anniversary) { // 初识日期按自然日计（北京时间）
    const d1 = new Date(sky.anniversary + 'T00:00:00+08:00');
    const d2 = new Date(dayKey() + 'T00:00:00+08:00');
    return Math.max(1, Math.round((d2 - d1) / 86400e3) + 1);
  }
  return Math.floor((now() - sky.created_at) / 86400e3) + 1;
}
const milestoneOf = day => (day === 100 || day === 520 || day === 1000 || (day > 0 && day % 365 === 0)) ? day : null;
const consGateOf = (sky, count) => null; // 星座无日期门控，星光即门票
function rateOf(sky, partner) {
  const obs = (sky.obs_level - 1) * OBS_BONUS;
  const cons = sky.const_count * CONS_BONUS;
  const base = BASE_RATE + obs + cons;
  const partnerActive = partner && (now() - partner.last_active) < PARTNER_ACTIVE_H * 3600e3;
  return { base, obs, cons, partnerActive, total: base * (partnerActive ? 1.3 : 1) };
}
function pendingOf(sky, partner) {
  const hours = Math.floor(Math.min((now() - sky.last_collected_at) / 3.6e6, BANK_HOURS));
  const batch = Math.max(1, Math.round(rateOf(sky, partner).total / 5));
  return { hours, batch, amount: hours * batch * (goldenNow() ? 2 : 1) };
}
const binaryUnlocked = sky => sky.obs_level - 1 + sky.const_count >= BINARY_LEVEL_GATE;

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
  const day = dayIndex(sky);
  const milestone = milestoneOf(day);
  if (milestone && !db.prepare('SELECT 1 FROM chronicle WHERE sky_id=? AND kind=?').get(sky.id, 'milestone:' + milestone)) {
    chron(sky.id, 'milestone:' + milestone, `🎉 在一起第 ${milestone} 天——从初识到今夜，星光作证`);
  }
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
  const customCons = db.prepare('SELECT id,name,stars,created_at FROM custom_cons WHERE sky_id=? ORDER BY id').all(sky.id)
    .map(c => ({ id: c.id, name: c.name, stars: JSON.parse(c.stars), at: c.created_at }));
  const chrCount = db.prepare('SELECT COUNT(*) c FROM chronicle WHERE sky_id=?').get(sky.id).c;
  const cInfo = pendingOf(sky, partner);
  const nextInMin = Math.max(0, Math.ceil((sky.last_collected_at + 3600e3 - now()) / 60000));
  return {
    id: sky.id,
    inviteCode: partner ? null : sky.invite_code,
    starlight: sky.starlight,
    collect: { hours: cInfo.hours, batch: cInfo.batch, amount: cInfo.amount, nextInMin },
    rate: r,
    weather: weatherOf(),
    golden: goldenNow(),
    day,
    milestone,
    anniversary: sky.anniversary || null,
    observatory: { level: sky.obs_level, nextCost: OBS_COST(sky.obs_level), bonus: r.obs },
    constellations: { count: sky.const_count, names: CONS_NAMES.slice(0, sky.const_count), next: consNext },
    customCons,
    binary: { unlocked: binaryUnlocked(sky), name: sky.binary_name },
    gifts: { received: gifts.filter(g => !g.mine), given: gifts.filter(g => g.mine).length, total: giftCount },
    messages: { items: msgs, unread: msgs.filter(m => !m.mine && !m.opened && m.openable).length },
    daily: dailyOf(p, sky),
    partner: partner ? { name: partner.name, online: isOnline(partner.id), lastActive: partner.last_active, zodiac: partner.zodiac ?? null } : null,
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
app.post('/api/player/rename', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '名字不能为空' });
  db.prepare('UPDATE players SET name=? WHERE id=?').run(name, p.id);
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'rename', { name });
  res.json({ ok: true, name });
});
app.post('/api/player/zodiac', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const z = req.body.zodiac;
  if (!Number.isInteger(z) || z < 0 || z > 11) return res.status(400).json({ error: '星座参数不合法' });
  db.prepare('UPDATE players SET zodiac=? WHERE id=?').run(z, p.id);
  const np = P(p.id);
  const t = partnerOf(np);
  if (t) sendTo(t.id, 'zodiac', { zodiac: z, name: np.name });
  if (np.sky_id && t && t.zodiac != null &&
      !db.prepare('SELECT 1 FROM chronicle WHERE sky_id=? AND kind=?').get(np.sky_id, 'zodiac_pair')) {
    chron(np.sky_id, 'zodiac_pair', `💫 星座合鸣：${ZODIAC[z][1]} ${ZODIAC[z][0]} × ${ZODIAC[t.zodiac][1]} ${ZODIAC[t.zodiac][0]}`);
  }
  res.json({ ok: true, zodiac: z });
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
  const c = pendingOf(sky, partnerOf(p));
  if (c.hours < 1) {
    const next = Math.max(1, Math.ceil((sky.last_collected_at + 3600e3 - now()) / 60000));
    return res.status(400).json({ error: '下一批星光约 ' + next + ' 分钟后汇聚完成' });
  }
  db.prepare('UPDATE skies SET starlight=starlight+?, last_collected_at=? WHERE id=?').run(c.amount, now(), sky.id);
  markDaily(p.id, 'collected');
  res.json({ gained: c.amount, golden: goldenNow(), starlight: sky.starlight + c.amount });
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
  if (!binaryUnlocked(sky)) return res.status(400).json({ error: '双星尚未成形（观星台+星座总等级 6 解锁）' });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '名字不能为空' });
  const first = !sky.binary_name;
  db.prepare('UPDATE skies SET binary_name=? WHERE id=?').run(name, sky.id);
  if (first) chron(sky.id, 'binary', `💫 双星被命名为「${name}」——两颗星，永远绕转`);
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'binary', { name });
  res.json({ ok: true, name });
});

// ---- 自定义星座：亲手画一座
app.post('/api/cons/custom', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const count = db.prepare('SELECT COUNT(*) c FROM custom_cons WHERE sky_id=?').get(sky.id).c;
  if (count >= CUSTOM_MAX) return res.status(400).json({ error: `最多画 ${CUSTOM_MAX} 座星座` });
  const name = String(req.body.name || '').trim().slice(0, 12);
  if (!name) return res.status(400).json({ error: '给星座起个名字' });
  let stars = req.body.stars;
  if (!Array.isArray(stars) || stars.length < CUSTOM_STARS[0] || stars.length > CUSTOM_STARS[1])
    return res.status(400).json({ error: `每座星座 ${CUSTOM_STARS[0]}-${CUSTOM_STARS[1]} 颗星` });
  for (const s of stars) {
    if (!Array.isArray(s) || s.length !== 2 || !s.every(v => typeof v === 'number' && v >= 0 && v <= 1))
      return res.status(400).json({ error: '星的位置数据不合法' });
  }
  if (sky.starlight < CUSTOM_COST) return res.status(400).json({ error: `星光不足，画星座需要 ${CUSTOM_COST}` });
  db.prepare('UPDATE skies SET starlight=starlight-? WHERE id=?').run(CUSTOM_COST, sky.id);
  const r = db.prepare('INSERT INTO custom_cons(sky_id,name,stars,created_by,created_at) VALUES(?,?,?,?,?)')
    .run(sky.id, name, JSON.stringify(stars), p.id, now());
  chron(sky.id, 'cc:' + r.lastInsertRowid, count === 0
    ? `✏️ 你们画下了第一座星座「${name}」，全世界仅此一座`
    : `✏️ 「${name}」升起在你们的夜空`);
  res.json({ ok: true, id: r.lastInsertRowid, cost: CUSTOM_COST, starlight: sky.starlight - CUSTOM_COST });
  const t = partnerOf(p);
  if (t) sendTo(t.id, 'cc', { name, stars });
});

// ---- 初识日期
app.post('/api/sky/anniversary', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const d = String(req.body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const t = new Date(d + 'T00:00:00+08:00');
  if (isNaN(t.getTime())) return res.status(400).json({ error: '日期不合法' });
  if (t.getTime() > now()) return res.status(400).json({ error: '初识之日还不能是未来' });
  const first = !sky.anniversary;
  db.prepare('UPDATE skies SET anniversary=? WHERE id=?').run(d, sky.id);
  if (first) chron(sky.id, 'anni', `🗓 你们的故事始于 ${d}，往后的每一天都有星光`);
  else chron(sky.id, 'anni_chg', `🗓 初识日期改为了 ${d}`);
  const tp = partnerOf(p);
  if (tp) sendTo(tp.id, 'anni', { date: d });
  res.json({ ok: true, date: d });
});

// ---- 心愿单与抽奖：礼物由对方设定
app.get('/api/wishlist', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const mine = db.prepare('SELECT items FROM wishlists WHERE player_id=?').get(p.id);
  const t = partnerOf(p);
  const theirs = t ? db.prepare('SELECT items FROM wishlists WHERE player_id=?').get(t.id) : null;
  res.json({
    mine: mine ? JSON.parse(mine.items) : [],
    theirs: theirs ? JSON.parse(theirs.items) : null,
    defaults: DEFAULT_WISH,
  });
});
app.post('/api/wishlist', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const items = (Array.isArray(req.body.items) ? req.body.items : [])
    .slice(0, WISH_MAX).map(s => String(s || '').trim().slice(0, 16)).filter(Boolean);
  const json = JSON.stringify(items);
  db.prepare('INSERT INTO wishlists(player_id,items) VALUES(?,?) ON CONFLICT(player_id) DO UPDATE SET items=?')
    .run(p.id, json, json);
  res.json({ ok: true, items });
});
app.post('/api/draw', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const sky = p.sky_id && db.prepare('SELECT * FROM skies WHERE id=?').get(p.sky_id);
  if (!sky) return res.status(400).json({ error: '还没有星空' });
  const t = partnerOf(p);
  if (!t) return res.status(400).json({ error: '等 Ta 加入后就能为 Ta 抽心愿' });
  if (sky.starlight < DRAW_COST) return res.status(400).json({ error: '星光不足，先去收集' });
  const wl = db.prepare('SELECT items FROM wishlists WHERE player_id=?').get(t.id);
  const parsed = wl ? JSON.parse(wl.items) : [];
  const pool = parsed.length ? parsed : DEFAULT_WISH;
  const prize = pool[Math.floor(Math.random() * pool.length)];
  db.prepare('UPDATE skies SET starlight=starlight-? WHERE id=?').run(DRAW_COST, sky.id);
  db.prepare('INSERT INTO tickets(sky_id,prize,from_player,to_player,created_at) VALUES(?,?,?,?,?)')
    .run(sky.id, prize, p.id, t.id, now());
  if (!db.prepare('SELECT 1 FROM chronicle WHERE sky_id=? AND kind=?').get(sky.id, 'wish:' + prize)) {
    chron(sky.id, 'wish:' + prize, `🎁 心愿「${prize}」第一次被抽中，记得兑现`);
  }
  markDaily(p.id, 'poked'); // 抽心愿也算今日互动
  res.json({ ok: true, prize, starlight: sky.starlight - DRAW_COST });
  sendTo(t.id, 'prize', { prize, name: p.name });
});
app.get('/api/tickets', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  if (!p.sky_id) return res.json({ items: [] });
  const items = db.prepare('SELECT id,prize,from_player,to_player,created_at,redeemed FROM tickets WHERE sky_id=? ORDER BY id DESC LIMIT 50').all(p.sky_id)
    .map(x => ({ id: x.id, prize: x.prize, mine: x.from_player === p.id, at: x.created_at, redeemed: !!x.redeemed }));
  res.json({ items });
});
app.post('/api/ticket/redeem', (req, res) => {
  const p = requirePlayer(req, res); if (!p) return;
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.body.id);
  if (!t || t.sky_id !== p.sky_id) return res.status(404).json({ error: '心愿券不存在' });
  if (t.to_player !== p.id) return res.status(403).json({ error: '只有心愿主人能兑现' });
  if (!t.redeemed) db.prepare('UPDATE tickets SET redeemed=1 WHERE id=?').run(t.id);
  res.json({ ok: true });
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
