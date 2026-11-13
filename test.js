// Smoke test: node test.js  (uses a temporary DB)
process.env.DB_FILE = ':memory:';
const assert = require('assert');
const app = require('./server');
const srv = app.listen(0, async () => {
  const base = `http://localhost:${srv.address().port}/api`;
  let tok = '';
  const call = async (p, m = 'GET', b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b && JSON.stringify(b) });
    return { s: r.status, d: await r.json() };
  };
  try {
    tok = (await call('/auth/register', 'POST', { email: 'a@b.co', password: 'secret1' })).d.token;
    assert.equal((await call('/auth/login', 'POST', { email: 'a@b.co', password: 'bad' })).s, 401);
    // A manager can sign in again after ending their previous browser session.
    tok = '';
    const login = await call('/auth/login', 'POST', { email: 'a@b.co', password: 'secret1' });
    assert.equal(login.s, 200);
    tok = login.d.token;
    const q = (await call('/queues', 'POST', { name: 'Front desk' })).d;
    for (const n of ['Asha', 'Ben', 'Chitra']) await call(`/queues/${q.id}/tokens`, 'POST', { name: n });
    let d = (await call('/queues/' + q.id)).d;
    assert.deepEqual(d.waiting.map(t => t.name), ['Asha', 'Ben', 'Chitra']);
    await call(`/tokens/${d.waiting[2].id}/move`, 'POST', { direction: 'up' });
    d = (await call('/queues/' + q.id)).d;
    assert.deepEqual(d.waiting.map(t => t.name), ['Asha', 'Chitra', 'Ben']);
    await call(`/tokens/${d.waiting[1].id}/cancel`, 'POST');
    await call(`/queues/${q.id}/serve`, 'POST');
    d = (await call('/queues/' + q.id)).d;
    assert.equal(d.serving[0].name, 'Asha'); assert.equal(d.waiting.length, 1);
    const a = (await call('/analytics')).d;
    assert.equal(a.totals.cancelled, 1); assert.ok(a.trend.length >= 4);
    console.log('All checks passed');
  } catch (e) { console.error('FAILED', e); process.exitCode = 1; }
  finally { srv.close(); }
});
