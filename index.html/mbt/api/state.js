import crypto from 'node:crypto';
import { checkPin } from './_auth.js';
import { redis, send, readBody, storeConfigured, TRIP_KEY } from './_store.js';

const MAX_BYTES = 900 * 1024;

function validState(s) {
  return s && typeof s === 'object' && !Array.isArray(s) &&
    Array.isArray(s.players) && Array.isArray(s.courses) && Array.isArray(s.days) &&
    s.stakes && typeof s.stakes === 'object' && s.trip && typeof s.trip === 'object';
}

export default async function handler(req, res) {
  if (!storeConfigured()) return send(res, 500, { error: 'The database is not connected yet.' });
  try {
    if (req.method === 'GET') {
      const raw = await redis('GET', TRIP_KEY);
      return send(res, 200, { state: raw ? JSON.parse(raw) : null });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const auth = await checkPin(req, req.headers['x-scorer-pin']);
      if (!auth.ok) return send(res, auth.status, { error: auth.error });

      const body = await readBody(req);
      if (!body || !validState(body.state)) return send(res, 400, { error: 'That trip data is incomplete, so nothing was saved.' });

      const raw = await redis('GET', TRIP_KEY);
      const current = raw ? JSON.parse(raw) : null;
      // Refuse to overwrite a newer save unless the scorer chose to.
      if (current && body.baseRev !== current.rev && !body.force) {
        return send(res, 409, { error: 'A newer version was saved from another device.', state: current });
      }

      const next = { ...body.state, rev: crypto.randomBytes(6).toString('hex'), savedAt: new Date().toISOString() };
      const json = JSON.stringify(next);
      if (Buffer.byteLength(json) > MAX_BYTES) return send(res, 413, { error: 'The trip data is too large to save.' });
      await redis('SET', TRIP_KEY, json);
      // Keep the last few saves in case one ever needs to be recovered.
      await redis('LPUSH', 'mbt:history', json);
      await redis('LTRIM', 'mbt:history', 0, 29);
      return send(res, 200, { state: next });
    }

    return send(res, 405, { error: 'Method not allowed.' });
  } catch (e) {
    return send(res, 500, { error: 'The server hit an error. Your edits are still on your phone. Try again.' });
  }
}
