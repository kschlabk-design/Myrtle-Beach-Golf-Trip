import crypto from 'node:crypto';
import { redis } from './_store.js';

// The PIN lives only in the Vercel environment variable SCORER_PIN. It is never sent to viewers' phones.
const MAX_FAILS = 8;          // wrong guesses allowed per phone/network...
const LOCK_SECONDS = 15 * 60; // ...before a 15-minute lockout

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function samePin(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns { ok: true } or { ok: false, status, error }.
export async function checkPin(req, pin) {
  const expected = process.env.SCORER_PIN;
  if (!expected) return { ok: false, status: 500, error: 'The scorer PIN is not set up on the server yet (SCORER_PIN).' };
  const key = `mbt:fail:${clientIp(req)}`;
  const fails = Number(await redis('GET', key)) || 0;
  if (fails >= MAX_FAILS) {
    const ttl = Number(await redis('TTL', key)) || LOCK_SECONDS;
    return { ok: false, status: 429, error: `Too many wrong PINs. Try again in ${Math.ceil(ttl / 60)} minutes.` };
  }
  if (!samePin(pin, expected)) {
    const n = Number(await redis('INCR', key));
    if (n === 1) await redis('EXPIRE', key, LOCK_SECONDS);
    const left = MAX_FAILS - n;
    return { ok: false, status: 401, error: left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.' };
  }
  if (fails) await redis('DEL', key);
  return { ok: true };
}
