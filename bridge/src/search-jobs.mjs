// Durable owner-bound exhaustive IMAP search. Only metadata is persisted.
// A "complete" job means every UID window in every requested allowlisted folder
// has been scanned with the IMAP server's search semantics.
import { validateInput, readConfig } from './validation.js';
import { createYandexClient, messageSummary } from './imap.js';
import { createBridgeStore } from './d1-stores.mjs';
import { accessTokenProvider } from './oauth.mjs';
import { requireRateLimit } from './rate-limit.js';
import { limitedText } from './http.mjs';
import { BridgeError } from './errors.js';

const WINDOW = 1000;
const PAGE = 50;
const MAX_RESULTS_PAGE = 50;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FIELDS = ['from', 'to', 'subject', 'text', 'since', 'before', 'unseen'];
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(['queued', 'running', 'complete', 'incomplete', 'reauthorization_required', 'failed']);
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const respond = (data, status = 200) => Response.json(data, { status, headers });
const raise = (status, code) => { throw new BridgeError(status, code); };
const jobKey = env => [env.SITE_ID, env.OWNER_SITE_USER_ID];

export function validateSearchJobInput(input, allowedMailboxes) {
  if (!input || Array.isArray(input) || typeof input !== 'object') raise(400, 'invalid_search_request');
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'resumeSearchId') {
    if (typeof input.resumeSearchId !== 'string' || !JOB_ID.test(input.resumeSearchId)) raise(400, 'invalid_search_id');
    return { resumeSearchId: input.resumeSearchId };
  }
  if (keys.some(key => !['mailboxes', 'mode', ...FIELDS].includes(key))) raise(400, 'unknown_search_field');
  if (input.mode !== 'imap_server') raise(400, 'unsupported_search_mode');
  if (!Array.isArray(input.mailboxes) || input.mailboxes.length < 1 || input.mailboxes.length > 20) raise(400, 'invalid_mailboxes');
  if (new Set(input.mailboxes).size !== input.mailboxes.length || input.mailboxes.some(x => typeof x !== 'string' || !allowedMailboxes.includes(x))) raise(403, 'mailbox_not_allowed');
  const filters = Object.fromEntries(FIELDS.filter(x => Object.hasOwn(input, x)).map(x => [x, input[x]]));
  validateInput('search', { ...filters, mailbox: input.mailboxes[0] }, allowedMailboxes);
  return { mailboxes: input.mailboxes, mode: 'imap_server', filters };
}
export function validateSearchQuery(input, kind) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) raise(400, 'invalid_search_request');
  const allowed = kind === 'results' ? ['searchId', 'limit', 'offset'] : ['searchId'];
  if (Object.keys(input).some(x => !allowed.includes(x))) raise(400, 'unknown_search_field');
  if (typeof input.searchId !== 'string' || !JOB_ID.test(input.searchId)) raise(400, 'invalid_search_id');
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  if (kind === 'results' && (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS_PAGE ||
    !Number.isInteger(offset) || offset < 0 || offset > 10000000)) raise(400, 'invalid_page');
  return { searchId: input.searchId, limit, offset };
}
const findJob = async (env, searchId) =>
  env.DB.prepare('SELECT * FROM search_jobs WHERE id = ? AND site_id = ? AND owner_id = ? AND expires_at > ?')
    .bind(searchId, ...jobKey(env), Date.now()).first();

const countMatches = async (env, searchId) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM search_results WHERE job_id = ?').bind(searchId).first()).n;

async function status(env, searchId) {
  const job = await findJob(env, searchId);
  if (!job) raise(404, 'search_not_found');
  const { results: rows } = await env.DB.prepare('SELECT mailbox, uid_validity AS uidValidity, upper_uid AS upperUid, next_high AS nextHighUid, windows_done AS windowsDone, done FROM search_folders WHERE job_id = ? ORDER BY position ASC').bind(job.id).all();
  const matchedTotal = await countMatches(env, job.id);
  const complete = job.status === 'complete' && rows.every(x => x.done === 1);
  return { searchId: job.id, status: job.status, complete,
    mode: job.mode, scope: rows.map(x => x.mailbox),
    matchedTotal, foldersCompleted: rows.filter(x => x.done === 1).length,
    foldersRequested: rows.length, folders: rows.map(({done, ...row}) => ({...row, complete: done === 1})),
    errorCode: job.error_code, createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(), expiresAt: new Date(job.expires_at).toISOString() };
}

async function start(env, input) {
  if (!env.SEARCH_WORKFLOW?.create) raise(503, 'search_workflow_not_configured');
  const cfg = readConfig(env);
  const parsed = validateSearchJobInput(input, cfg.mailboxes);
  if (parsed.resumeSearchId) {
    const existing = await findJob(env, parsed.resumeSearchId);
    if (!existing) raise(404, 'search_not_found');
    if (!['incomplete', 'reauthorization_required', 'failed'].includes(existing.status)) raise(409, 'search_not_resumable');
    // Resume requires a currently valid read-only grant; never persist the token in a job.
    await accessTokenProvider({ store: createBridgeStore(env.DB), siteId: env.SITE_ID,
      ownerId: env.OWNER_SITE_USER_ID, ownerEmail: env.YANDEX_OWNER_EMAIL })();
    const run = existing.run + 1;
    await env.DB.prepare("UPDATE search_jobs SET status = 'queued', error_code = NULL, run = ?, updated_at = ? WHERE id = ? AND status IN ('incomplete', 'reauthorization_required', 'failed')")
      .bind(run, Date.now(), existing.id).run();
    try { await env.SEARCH_WORKFLOW.create({ id: existing.id + '-' + run, params: { searchId: existing.id, run } }); }
    catch { await env.DB.prepare("UPDATE search_jobs SET status='incomplete', error_code='workflow_start_failed', updated_at=? WHERE id=? AND run=?").bind(Date.now(), existing.id, run).run(); raise(503, 'workflow_start_failed'); }
    return await status(env, existing.id);
  }
  const now = Date.now(), id = crypto.randomUUID();
  const { mailboxes, mode, filters } = parsed;
  const active = await env.DB.prepare("SELECT id, query_json FROM search_jobs WHERE site_id=? AND owner_id=? AND status IN ('queued','running')").bind(...jobKey(env)).first();
  if (active) {
    if (active.query_json === JSON.stringify({ mailboxes, mode, filters })) return await status(env, active.id);
    raise(409, 'search_already_running');
  }
  await accessTokenProvider({ store: createBridgeStore(env.DB), siteId: env.SITE_ID,
    ownerId: env.OWNER_SITE_USER_ID, ownerEmail: env.YANDEX_OWNER_EMAIL })();
  await env.DB.prepare('DELETE FROM search_jobs WHERE site_id=? AND owner_id=? AND expires_at < ?').bind(...jobKey(env), now).run();
  const rows = [env.DB.prepare("INSERT INTO search_jobs (id, site_id, owner_id, mode, query_json, status, created_at, updated_at, expires_at, run) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0)")
    .bind(id, ...jobKey(env), mode, JSON.stringify({mailboxes, mode, filters}), now, now, now + RETENTION_MS)];
  for (const [position, mailbox] of mailboxes.entries()) {
    rows.push(env.DB.prepare('INSERT INTO search_folders(job_id, mailbox, position) VALUES (?, ?, ?)').bind(id, mailbox, position));
  }
  // Transactional creation avoids orphaned folders. The UNIQUE active-job index prevents concurrent jobs.
  try { await env.DB.batch(rows); }
  catch { raise(409, 'search_already_running'); }
  try { await env.SEARCH_WORKFLOW.create({ id: id + '-0', params: { searchId: id, run: 0 } }); }
  catch { await env.DB.prepare("UPDATE search_jobs SET status='incomplete', error_code='workflow_start_failed', updated_at=? WHERE id=?").bind(Date.now(),id).run(); raise(503,'workflow_start_failed'); }
  return await status(env, id);
}

async function results(env, input) {
  const {searchId, limit, offset} = validateSearchQuery(input, 'results');
  const job = await findJob(env, searchId);
  if (!job) raise(404, 'search_not_found');
  const {results: rows} = await env.DB.prepare('SELECT summary_json FROM search_results WHERE job_id=? ORDER BY mailbox ASC, uid DESC LIMIT ? OFFSET ?').bind(job.id, limit, offset).all();
  const total = await countMatches(env, searchId);
  return {searchId, status: job.status, complete: job.status === 'complete',
    matchedTotal: total, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null,
    messages: rows.map(row => JSON.parse(row.summary_json))};
}

export async function handleSearchJobRequest(request, env, authorize) {
  if (request.method !== 'POST' || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || request.headers.has('content-encoding')) raise(415,'json_required');
  const url = new URL(request.url);
  const operation = {'/v1/search-jobs/start':'start','/v1/search-jobs/status':'status','/v1/search-jobs/results':'results'}[url.pathname];
  if (!operation || url.search) raise(404, 'search_route_not_found');
  const raw = await limitedText(request.body, 8192);
  if (!await authorize(request, raw)) raise(401, 'unauthorized');
  let input;
  try { input = JSON.parse(raw); } catch { raise(400,'invalid_json'); }
  if (operation === 'start') return respond(await start(env, input));
  const query = validateSearchQuery(input, operation);
  return respond(operation === 'status' ? await status(env, query.searchId) : await results(env, query));
}

// Execute exactly one bounded window per durable Workflow step.
// For a sparse UID range, an empty result still advances the checkpoint.
export async function scanOneWindow(env, searchId, options = {}) {
  const createClient = options.createClient ?? createYandexClient;
  const store = options.store ?? createBridgeStore(env.DB);
  const job = await findJob(env, searchId);
  if (!job || !['queued','running'].includes(job.status)) return {status: job?.status ?? 'missing'};
  const folder = await env.DB.prepare('SELECT * FROM search_folders WHERE job_id=? AND done=0 ORDER BY position LIMIT 1').bind(searchId).first();
  if (!folder) {
    await env.DB.prepare("UPDATE search_jobs SET status='complete', updated_at=? WHERE id=? AND status IN ('queued','running')").bind(Date.now(),searchId).run();
    return {status:'complete'};
  }
  const cfg = readConfig(env);
  if (!cfg.mailboxes.includes(folder.mailbox)) throw new Error('mailbox_not_allowed');
  const grant = await accessTokenProvider({store,siteId:env.SITE_ID,ownerId:env.OWNER_SITE_USER_ID,ownerEmail:cfg.owner})();
  await requireRateLimit(env.OWNER_LIMITER, 'site:' + env.SITE_ID + ':owner:' + env.OWNER_SITE_USER_ID);
  const client = createClient(cfg.owner, grant.accessToken);
  let lock;
  try {
    await client.connect();
    lock = await client.getMailboxLock(folder.mailbox, {readOnly:true});
    const current = client.mailbox;
    if (!current?.readOnly || !current.uidValidity || !Number.isInteger(current.uidNext)) throw new Error('readonly_mailbox_required');
    const validity = String(current.uidValidity);
    if (folder.uid_validity && folder.uid_validity !== validity) throw new Error('uid_validity_changed');
    let high = folder.next_high;
    if (!folder.uid_validity) {
      high = Math.max(0,current.uidNext-1);
      const snap = await env.DB.prepare('UPDATE search_folders SET uid_validity=?, upper_uid=?, next_high=? WHERE job_id=? AND mailbox=? AND uid_validity IS NULL')
        .bind(validity,high,high,searchId,folder.mailbox).run();
      if (snap.meta?.changes !== 1) throw new Error('concurrent_scan');
    }
    if (high <= 0) {
      await env.DB.prepare('UPDATE search_folders SET done=1, next_high=0 WHERE job_id=? AND mailbox=? AND next_high=0')
        .bind(searchId,folder.mailbox).run();
      return {status:'running'};
    }
    const low = Math.max(1, high - WINDOW + 1);
    const {filters} = JSON.parse(job.query_json);
    const criteria = validateInput('search', {...filters, mailbox:folder.mailbox},cfg.mailboxes).criteria;
    const found = await client.search({...criteria,uid:low + ':' + high},{uid:true});
    if (!Array.isArray(found) || found.length > WINDOW ||
      found.some(uid => !Number.isInteger(uid) || uid < low || uid > high)) throw new Error('invalid_search_result');
    const uids = [...new Set(found)].sort((a,b)=>b-a);
    const query = {uid:true,envelope:true,flags:true,size:true,internalDate:true};
    for (let i=0;i<uids.length;i+=PAGE) {
      const slice=uids.slice(i,i+PAGE);
      const summaries=await client.fetchAll(slice,query,{uid:true});
      if (summaries.length !== slice.length || summaries.some(x=>!slice.includes(x.uid))) throw new Error('message_changed_during_scan');
      const statements=summaries.map(message=>{
        const summary={mailbox:folder.mailbox,uidValidity:validity,...messageSummary(message)};
        return env.DB.prepare('INSERT OR IGNORE INTO search_results(job_id,mailbox,uid_validity,uid,summary_json) VALUES(?,?,?,?,?)')
          .bind(searchId,folder.mailbox,validity,message.uid,JSON.stringify(summary));
      });
      if (statements.length) await env.DB.batch(statements);
    }
    // Cursor moves ONLY after every matched UID is durably stored.
    const nextHigh=low-1;
    const updated=await env.DB.prepare('UPDATE search_folders SET next_high=?, done=?, windows_done=windows_done+1 WHERE job_id=? AND mailbox=? AND uid_validity=? AND next_high=?')
      .bind(nextHigh,nextHigh===0?1:0,searchId,folder.mailbox,validity,high).run();
    if (updated.meta?.changes !== 1) throw new Error('concurrent_scan');
    await env.DB.prepare("UPDATE search_jobs SET status='running', updated_at=? WHERE id=? AND status IN ('queued','running')").bind(Date.now(),searchId).run();
    return {status:'running'};
  } finally { lock?.release(); client.close(); }
}

export async function markSearchInterrupted(env, searchId, code) {
  const safeCode = code === 'reauthorization_required' ? code : 'scan_interrupted';
  await env.DB.prepare("UPDATE search_jobs SET status=?, error_code=?, updated_at=? WHERE id=? AND status IN ('queued','running')")
    .bind(safeCode==='reauthorization_required'?'reauthorization_required':'incomplete',safeCode,Date.now(),searchId).run();
}
