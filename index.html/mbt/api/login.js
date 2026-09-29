import { checkPin } from './_auth.js';
import { send, readBody, storeConfigured } from './_store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (!storeConfigured()) return send(res, 500, { error: 'The database is not connected yet.' });
  try {
    const body = (await readBody(req)) || {};
    const auth = await checkPin(req, body.pin);
    if (!auth.ok) return send(res, auth.status, { error: auth.error });
    return send(res, 200, { ok: true });
  } catch (e) {
    return send(res, 500, { error: 'Login failed. Check your signal and try again.' });
  }
}
