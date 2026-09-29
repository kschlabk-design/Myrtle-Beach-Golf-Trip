// Local stand-in for Vercel: serves public/, runs api/* handlers, and fakes Upstash's REST API in memory.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4321);
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${PORT}/__redis`;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
process.env.SCORER_PIN = process.env.SCORER_PIN ?? '12345'; // test PIN only

const db = new Map(); const exp = new Map();
function alive(k) { if (exp.has(k) && exp.get(k) < Date.now()) { db.delete(k); exp.delete(k); } return db.has(k); }
function runRedis([cmd, ...a]) {
  cmd = String(cmd).toUpperCase(); const k = a[0];
  switch (cmd) {
    case 'GET': return alive(k) ? db.get(k) : null;
    case 'SET': db.set(k, String(a[1])); exp.delete(k); return 'OK';
    case 'DEL': { const had = alive(k); db.delete(k); exp.delete(k); return had ? 1 : 0; }
    case 'INCR': { const v = (alive(k) ? Number(db.get(k)) : 0) + 1; db.set(k, String(v)); return v; }
    case 'EXPIRE': exp.set(k, Date.now() + Number(a[1]) * 1000); return 1;
    case 'TTL': return alive(k) && exp.has(k) ? Math.ceil((exp.get(k) - Date.now()) / 1000) : -1;
    case 'LPUSH': { const l = alive(k) ? db.get(k) : []; l.unshift(...a.slice(1)); db.set(k, l); return l.length; }
    case 'LTRIM': { if (alive(k)) db.set(k, db.get(k).slice(Number(a[1]), Number(a[2]) + 1)); return 'OK'; }
    case 'FLUSHALL': db.clear(); exp.clear(); return 'OK';
    default: throw new Error('unsupported ' + cmd);
  }
}
const types = { '.html': 'text/html', '.png': 'image/png', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__redis') {
    let b = ''; for await (const c of req) b += c;
    if (req.headers.authorization !== 'Bearer test-token') { res.statusCode = 401; return res.end('{"error":"bad token"}'); }
    try { const result = runRedis(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ result })); }
    catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: e.message })); }
  }
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5).replace(/[^a-z]/g, '');
    const file = path.join(root, 'api', name + '.js');
    if (!fs.existsSync(file) || name.startsWith('_')) { res.statusCode = 404; return res.end(); }
    const mod = await import(url.pathToFileURL(file).href);
    return mod.default(req, res);
  }
  let p = path.join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log('dev server on', PORT));
