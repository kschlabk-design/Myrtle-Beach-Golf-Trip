// End-to-end: viewer and scorer phones against the local server.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_ROOT + '/')('playwright');
const BASE = 'http://127.0.0.1:4321';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const b = await chromium.launch();
const errs = [];
const mk = async () => { const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); return p; };

// fresh server: GET returns null
let r = await (await fetch(BASE + '/api/state')).json(); ok(r.state === null, 'empty database returns no state');

// simulate the old demo already saved on the server before the 2026 setup
const fs = await import('node:fs');
const demo = JSON.parse(fs.readFileSync(new URL('../src/seed.json', import.meta.url)));
demo.demo = true; demo.rev = 'old-demo'; demo.savedAt = '2020-01-01T00:00:00.000Z';
await fetch(BASE + '/__redis', { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: JSON.stringify(['SET', 'mbt:trip', JSON.stringify(demo)]) });

const viewer = await mk(); await viewer.goto(BASE); await viewer.waitForTimeout(600);
ok(await viewer.$('.tab[data-t="admin"]') === null, 'viewer has no Scorer tab');
ok(!!(await viewer.$('.scorer-link')), 'viewer sees Scorer login link');
ok((await viewer.$eval('.brand small', x => x.innerText)).length > 0, 'viewer loads seed data');
ok(!(await viewer.evaluate(() => document.body.innerText)).includes('Demo data'), 'older data on the server is ignored; 2026 setup shows');
ok((await viewer.$eval('.tee .time', x => x.innerText)).startsWith('9:05'), 'Day 1 first tee time is 9:05');


// unauthenticated write rejected
r = await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: {} }) });
ok(r.status === 401, 'save without PIN is rejected (' + r.status + ')');

const scorer = await mk(); await scorer.goto(BASE); await scorer.waitForTimeout(500);
await scorer.click('.scorer-link');
for (const d of '11111') await scorer.click(`[data-a="pinkey"][data-v="${d}"]`);
await scorer.click('[data-a="pingo"]'); await scorer.waitForTimeout(400);
ok(/Wrong PIN/.test(await scorer.$eval('.sheet .err', x => x.innerText)), 'wrong PIN shows error: ' + await scorer.$eval('.sheet .err', x => x.innerText));
for (const d of '12345') await scorer.click(`[data-a="pinkey"][data-v="${d}"]`);
await scorer.click('[data-a="pingo"]'); await scorer.waitForTimeout(500);
ok(!!(await scorer.$('.tab[data-t="admin"][aria-current="page"]')), 'right PIN opens Scorer tab');

// enter a change: Day 1 first group first player hole 1 -> 3, publish
await scorer.click('.day-chip >> nth=0'); await scorer.click('[data-a="asub"][data-m="scores"]').catch(() => {});
await scorer.click('.cell >> nth=0'); await scorer.click('.kp button[data-v="2"]');
ok(await scorer.$eval('[data-a="publish"]', x => !x.disabled), 'Publish enabled after edit');
await scorer.click('[data-a="publish"]'); await scorer.waitForTimeout(600);
r = await (await fetch(BASE + '/api/state')).json();
ok(r.state && r.state.demo === false && r.state.players.some(p => p.nick === 'Special'), 'first publish replaced the old demo with the 2026 setup');
const firstPid = r.state.days[0].groups[0].playerIds[0];
ok(r.state.days[0].scores[firstPid][0] === 2, 'published score is on the server');

// viewer picks it up (simulate the 30s poll by reload)
await viewer.reload(); await viewer.waitForTimeout(700);
const vs = await viewer.evaluate(() => JSON.parse(localStorage.getItem('mbt-cache-v1')).state.rev);
ok(vs === r.state.rev, 'viewer has the new version after refresh');

// conflict: second scorer device publishes, first then publishes stale edit
const scorer2 = await mk(); await scorer2.goto(BASE); await scorer2.waitForTimeout(500);
await scorer2.click('.scorer-link'); for (const d of '12345') await scorer2.click(`[data-a="pinkey"][data-v="${d}"]`); await scorer2.click('[data-a="pingo"]'); await scorer2.waitForTimeout(500);
await scorer2.click('.day-chip >> nth=0'); await scorer2.click('.cell >> nth=1'); await scorer2.click('.kp button[data-v="7"]'); await scorer2.click('[data-a="publish"]'); await scorer2.waitForTimeout(500);
await scorer.click('.cell >> nth=2'); await scorer.click('.kp button[data-v="6"]'); await scorer.click('[data-a="publish"]'); await scorer.waitForTimeout(500);
ok(!!(await scorer.$('[data-a="remote-load"]')), 'stale publish is blocked and offers a choice');
await scorer.click('[data-a="remote-load"]'); await scorer.waitForTimeout(200);
r = await (await fetch(BASE + '/api/state')).json();
ok(r.state.days[0].scores[firstPid][1] === 7, 'other device\'s save was not overwritten');

// draft survives closing the app
await scorer.click('.cell >> nth=3'); await scorer.click('.kp button[data-v="9"]');
await scorer.reload(); await scorer.waitForTimeout(700);
ok(await scorer.$eval('[data-a="publish"]', x => !x.disabled), 'unpublished edit survives a reload');

// offline publish
await scorer.context().setOffline(true);
await scorer.click('[data-a="publish"]'); await scorer.waitForTimeout(400);
ok(/No signal/.test(await scorer.$eval('.toast', x => x.innerText).catch(() => '')), 'offline publish keeps edits and says so');
await scorer.context().setOffline(false);
await scorer.click('[data-a="publish"]'); await scorer.waitForTimeout(500);
r = await (await fetch(BASE + '/api/state')).json();
ok(r.state.days[0].scores[firstPid][3] === 9, 'publish succeeds once back online');

// viewer offline still shows cached data
await viewer.context().setOffline(true); await viewer.reload().catch(() => {}); 
await viewer.context().setOffline(false);

// lockout after 8 wrong PINs
let last;
for (let i = 0; i < 9; i++) last = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ pin: '00000' }) });
ok(last.status === 429, 'locked out after 8 wrong PINs (' + last.status + ')');
const good = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ pin: '12345' }) });
ok(good.status === 429, 'even the right PIN waits out the lockout');
const other = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '8.8.8.8' }, body: JSON.stringify({ pin: '12345' }) });
ok(other.status === 200, 'a different phone is not locked out');

// PIN is not in the page
const html = await (await fetch(BASE + '/')).text();
ok(!html.includes('12345'), 'PIN does not appear anywhere in the page source');

// logout
await scorer.click('[data-a="logout"]'); await scorer.waitForTimeout(200);
ok(await scorer.$('.tab[data-t="admin"]') === null, 'log out hides Scorer tab');

ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
await b.close();
console.log(fails ? fails + ' FAILED' : 'ALL E2E PASS');
process.exit(fails ? 1 : 0);
