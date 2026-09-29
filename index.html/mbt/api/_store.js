// Tiny Upstash Redis client over its REST API (no dependencies).
// Vercel's Upstash integration sets either UPSTASH_REDIS_REST_* or KV_REST_API_* variables.
const BASE = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const TRIP_KEY = 'mbt:trip';

export function storeConfigured() {
  return Boolean(BASE && TOKEN);
}

export async function redis(...command) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `Database error ${res.status}`);
  return body.result;
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return null; }
}
