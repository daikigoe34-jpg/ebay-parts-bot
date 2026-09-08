// Personal state is owned by the Sites dispatch identity, never a client key.
// The hosting platform authenticates/forwards this header before our Worker.
const NAMESPACES = new Set(['main', 'shipping', 'queue']);
const MAX_BYTES = 2_000_000;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();

function json(value, status = 200, extra = {}) {
  return Response.json(value, {status, headers:{
    'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff', ...extra,
  }});
}
function problem(error, status, extra) { return json({error}, status, extra); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validJson(value) {
  const pending = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [entry, depth] = pending.pop();
    if (++count > 200_000 || depth > 32) return false;
    if (entry === null || typeof entry === 'boolean') continue;
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) return false; continue; }
    if (typeof entry === 'string') { if (entry.length > 1_000_000) return false; continue; }
    if (typeof entry !== 'object') return false;
    const entries = Object.entries(entry);
    if (entries.length > 10_000) return false;
    for (const [key, child] of entries) {
      if (BAD_KEYS.has(key) || key.length > 500) return false;
      pending.push([child, depth + 1]);
    }
  }
  return true;
}

async function readBody(request) {
  const announced = request.headers.get('content-length');
  if (announced && Number(announced) > MAX_BYTES) throw new RangeError('size');
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10_000); });
  try {
    while (true) {
      const {done, value} = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new RangeError('size');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  } finally {
    clearTimeout(timer);
    // Do not await an untrusted request stream's cancellation.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* Already closed. */ }
  }
}

async function userKeyFor(identity) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(`part-scout-workspace-v1:${identity}`));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}
function envelope(userKey, row) {
  return {schemaVersion:1, userKey, revision:row?.revision || 0,
    data:row ? JSON.parse(row.data_json) : null, updatedAt:row?.updated_at || null};
}

export async function handleWorkspace(request, env) {
  const url = new URL(request.url);
  const match = /^\/api\/workspace\/([^/]+)$/.exec(url.pathname);
  if (!match || !NAMESPACES.has(match[1])) return problem('not_found', 404);
  if (!['GET', 'PUT'].includes(request.method)) return problem('method_not_allowed', 405, {Allow:'GET, PUT'});
  const identity = request.headers.get('oai-authenticated-user-id')?.trim();
  if (!identity || identity.length > 2048) return problem('sign_in_required', 401);
  let input;
  if (request.method === 'PUT') {
    if (request.headers.get('origin') !== url.origin) return problem('origin_not_allowed', 403);
    if (!/^[a-f0-9]{64}$/.test(request.headers.get('x-part-scout-user-key') || '')) return problem('user_key_required', 400);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return problem('json_required', 415);
    }
    try { input = await readBody(request); }
    catch (error) { return problem(error instanceof RangeError ? 'payload_too_large' : 'invalid_request', error instanceof RangeError ? 413 : 400); }
    if (!record(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'baseRevision') || !Object.hasOwn(input, 'data')
      || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision >= Number.MAX_SAFE_INTEGER
      || !record(input.data) || !validJson(input.data)) return problem('invalid_request', 400);
  }
  if (!env?.DB?.prepare) return problem('storage_unavailable', 503);
  try {
    const userKey = await userKeyFor(identity);
    // Bind the preceding read to this write even if the browser's login changed.
    // The header cannot choose an owner: dispatch identity remains authoritative.
    if (request.method === 'PUT' && request.headers.get('x-part-scout-user-key') !== userKey) return problem('account_changed', 403);
    const namespace = match[1];
    const read = () => env.DB.prepare('SELECT revision, data_json, updated_at FROM workspace_documents WHERE user_key = ? AND namespace = ?')
      .bind(userKey, namespace).first();
    if (request.method === 'GET') return json(envelope(userKey, await read()));
    const value = JSON.stringify(input.data);
    const updated = new Date().toISOString();
    // Both branches are single atomic conditional statements. A nonzero base
    // never creates a missing document; simultaneous base-zero inserts cannot win.
    const row = input.baseRevision === 0
      ? await env.DB.prepare('INSERT INTO workspace_documents (user_key, namespace, revision, data_json, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT (user_key, namespace) DO NOTHING RETURNING revision, data_json, updated_at')
        .bind(userKey, namespace, value, updated).first()
      : await env.DB.prepare('UPDATE workspace_documents SET revision = revision + 1, data_json = ?, updated_at = ? WHERE user_key = ? AND namespace = ? AND revision = ? RETURNING revision, data_json, updated_at')
        .bind(value, updated, userKey, namespace, input.baseRevision).first();
    if (row) return json(envelope(userKey, row));
    return json({...envelope(userKey, await read()), error:'revision_conflict'}, 409);
  } catch (_) { return problem('storage_unavailable', 503); }
}
