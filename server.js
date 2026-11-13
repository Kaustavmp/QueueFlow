const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'queueflow.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS managers(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queues(id INTEGER PRIMARY KEY, manager_id INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens(
  id INTEGER PRIMARY KEY, queue_id INTEGER NOT NULL, number INTEGER NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', position INTEGER NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, queue_id INTEGER NOT NULL, ts INTEGER NOT NULL, length INTEGER NOT NULL);
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' }); } };
const clean = s => (typeof s === 'string' ? s.trim().slice(0, 80) : '');

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.user = jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
const ownQueue = (req, res) => {
  const q = db.prepare('SELECT * FROM queues WHERE id=? AND manager_id=?').get(req.params.id, req.user.id);
  if (!q) res.status(404).json({ error: 'Queue not found.' });
  return q;
};
const ownToken = (req, res) => {
  const t = db.prepare(`SELECT t.* FROM tokens t JOIN queues q ON q.id=t.queue_id WHERE t.id=? AND q.manager_id=?`).get(req.params.id, req.user.id);
  if (!t) res.status(404).json({ error: 'Token not found.' });
  return t;
};
const waitingLen = qid => db.prepare(`SELECT COUNT(*) c FROM tokens WHERE queue_id=? AND status='waiting'`).get(qid).c;
const logLen = qid => db.prepare('INSERT INTO events(queue_id,ts,length) VALUES(?,?,?)').run(qid, Date.now(), waitingLen(qid));

// ---- Auth
const issue = m => ({ token: jwt.sign({ id: m.id, email: m.email }, SECRET, { expiresIn: '12h' }), email: m.email });
app.post('/api/auth/register', wrap((req, res) => {
  const email = clean(req.body.email).toLowerCase(), pw = req.body.password || '';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM managers WHERE email=?').get(email)) return res.status(409).json({ error: 'That email is already registered.' });
  const id = db.prepare('INSERT INTO managers(email,password) VALUES(?,?)').run(email, bcrypt.hashSync(pw, 10)).lastInsertRowid;
  res.json(issue({ id, email }));
}));
app.post('/api/auth/login', wrap((req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const m = db.prepare('SELECT * FROM managers WHERE email=?').get(email);
  if (!m || !bcrypt.compareSync(req.body.password || '', m.password)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json(issue(m));
}));

// ---- Queues
app.get('/api/queues', auth, wrap((req, res) => {
  res.json(db.prepare(`SELECT q.id,q.name,q.created_at,
    (SELECT COUNT(*) FROM tokens WHERE queue_id=q.id AND status='waiting') waiting
    FROM queues q WHERE manager_id=? ORDER BY q.id`).all(req.user.id));
}));
app.post('/api/queues', auth, wrap((req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Give the queue a name.' });
  const id = db.prepare('INSERT INTO queues(manager_id,name,created_at) VALUES(?,?,?)').run(req.user.id, name, Date.now()).lastInsertRowid;
  logLen(id);
  res.json({ id, name, waiting: 0 });
}));
app.delete('/api/queues/:id', auth, wrap((req, res) => {
  const q = ownQueue(req, res); if (!q) return;
  db.transaction(() => { for (const t of ['tokens', 'events']) db.prepare(`DELETE FROM ${t} WHERE queue_id=?`).run(q.id); db.prepare('DELETE FROM queues WHERE id=?').run(q.id); })();
  res.json({ ok: true });
}));
app.get('/api/queues/:id', auth, wrap((req, res) => {
  const q = ownQueue(req, res); if (!q) return;
  const get = s => db.prepare(`SELECT * FROM tokens WHERE queue_id=? AND status=? ORDER BY position`).all(q.id, s);
  res.json({ queue: q, waiting: get('waiting'), serving: get('serving'),
    recent: db.prepare(`SELECT * FROM tokens WHERE queue_id=? AND status IN ('served','cancelled') ORDER BY ended_at DESC LIMIT 8`).all(q.id) });
}));

// ---- Tokens
app.post('/api/queues/:id/tokens', auth, wrap((req, res) => {
  const q = ownQueue(req, res); if (!q) return;
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Enter the person\u2019s name.' });
  const r = db.prepare(`SELECT COALESCE(MAX(number),0)+1 n, COALESCE(MAX(position),0)+1 p FROM tokens WHERE queue_id=?`).get(q.id);
  const id = db.prepare('INSERT INTO tokens(queue_id,number,name,position,created_at) VALUES(?,?,?,?,?)').run(q.id, r.n, name, r.p, Date.now()).lastInsertRowid;
  logLen(q.id);
  res.json(db.prepare('SELECT * FROM tokens WHERE id=?').get(id));
}));
app.post('/api/tokens/:id/move', auth, wrap((req, res) => {
  const t = ownToken(req, res); if (!t) return;
  if (t.status !== 'waiting') return res.status(400).json({ error: 'Only waiting tokens can be moved.' });
  const up = req.body.direction === 'up';
  const n = db.prepare(`SELECT * FROM tokens WHERE queue_id=? AND status='waiting' AND position ${up ? '<' : '>'} ? ORDER BY position ${up ? 'DESC' : 'ASC'} LIMIT 1`).get(t.queue_id, t.position);
  if (!n) return res.json({ ok: true });
  db.transaction(() => { const s = db.prepare('UPDATE tokens SET position=? WHERE id=?'); s.run(n.position, t.id); s.run(t.position, n.id); })();
  res.json({ ok: true });
}));
app.post('/api/queues/:id/serve', auth, wrap((req, res) => {
  const q = ownQueue(req, res); if (!q) return;
  const top = db.prepare(`SELECT * FROM tokens WHERE queue_id=? AND status='waiting' ORDER BY position LIMIT 1`).get(q.id);
  if (!top) return res.status(400).json({ error: 'Nobody is waiting in this queue.' });
  db.transaction(() => {
    // finish any token still being served so only one is active
    db.prepare(`UPDATE tokens SET status='served', ended_at=? WHERE queue_id=? AND status='serving'`).run(Date.now(), q.id);
    db.prepare(`UPDATE tokens SET status='serving', started_at=? WHERE id=?`).run(Date.now(), top.id);
    logLen(q.id);
  })();
  res.json({ ok: true });
}));
app.post('/api/tokens/:id/complete', auth, wrap((req, res) => {
  const t = ownToken(req, res); if (!t) return;
  if (t.status !== 'serving') return res.status(400).json({ error: 'This token is not being served.' });
  db.prepare(`UPDATE tokens SET status='served', ended_at=? WHERE id=?`).run(Date.now(), t.id);
  res.json({ ok: true });
}));
app.post('/api/tokens/:id/cancel', auth, wrap((req, res) => {
  const t = ownToken(req, res); if (!t) return;
  if (!['waiting', 'serving'].includes(t.status)) return res.status(400).json({ error: 'This token is already closed.' });
  db.prepare(`UPDATE tokens SET status='cancelled', ended_at=? WHERE id=?`).run(Date.now(), t.id);
  logLen(t.queue_id);
  res.json({ ok: true });
}));

// ---- Analytics
app.get('/api/analytics', auth, wrap((req, res) => {
  const qs = db.prepare('SELECT id,name FROM queues WHERE manager_id=?').all(req.user.id);
  const sel = req.query.queue_id ? qs.filter(q => String(q.id) === String(req.query.queue_id)) : qs;
  if (req.query.queue_id && !sel.length) return res.status(404).json({ error: 'Queue not found.' });
  const ids = sel.map(q => q.id), ph = ids.map(() => '?').join(',') || 'NULL';
  const toks = db.prepare(`SELECT * FROM tokens WHERE queue_id IN (${ph})`).all(...ids);
  const count = s => toks.filter(t => t.status === s).length;
  const started = toks.filter(t => t.started_at);
  const waits = started.map(t => t.started_at - t.created_at);
  const svc = toks.filter(t => t.status === 'served' && t.started_at).map(t => t.ended_at - t.started_at);
  const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
  const since = Date.now() - 24 * 3600e3;
  const trend = db.prepare(`SELECT ts, SUM(length) length FROM (SELECT queue_id, ts, length FROM events WHERE queue_id IN (${ph}) AND ts>?) GROUP BY ts ORDER BY ts`).all(...ids, since);
  const recentWaits = started.sort((a, b) => a.started_at - b.started_at).slice(-15)
    .map(t => ({ number: t.number, name: t.name, wait: t.started_at - t.created_at }));
  res.json({
    queues: qs, totals: { waiting: count('waiting'), serving: count('serving'), served: count('served'), cancelled: count('cancelled'), total: toks.length },
    avgWait: avg(waits), maxWait: waits.length ? Math.max(...waits) : 0, avgService: avg(svc),
    peakLength: trend.reduce((m, e) => Math.max(m, e.length), 0), trend, recentWaits
  });
}));

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`QueueFlow running at http://localhost:${PORT}`));
module.exports = app;
