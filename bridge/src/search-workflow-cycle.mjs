// Bound external IMAP connections and D1 calls per Workflow instance.
// Workers Free permits only 50 external subrequests and 1,000 Cloudflare-service
// subrequests per instance, irrespective of the 1,024 Workflow-step allowance.
// A new instance has a fresh budget while the job cursor/results remain in D1.
export const WINDOWS_PER_INSTANCE = 12;

// Kept independent of cloudflare:workers so the actual cycle orchestration can be
// regression-tested under a bounded synthetic subrequest budget in Node.
export async function runSearchCycle({ event, step, env, scanWindow, markInterrupted }) {
  const { searchId, run = 0, cycle = 0 } = event.payload ?? {};
  if (typeof searchId !== 'string' || typeof run !== 'number' ||
      !Number.isInteger(cycle) || cycle < 0 || cycle > 1000000) return;

  try {
    for (let i = 0; i < WINDOWS_PER_INSTANCE; i++) {
      const state = await step.do('scan-window-' + i, {
        retries: { limit: 8, delay: '60 seconds', backoff: 'constant' },
        timeout: '2 minutes'
      }, async () => {
        const current = await env.DB.prepare(
          'SELECT status, run FROM search_jobs WHERE id=? AND site_id=? AND owner_id=?'
        ).bind(searchId, env.SITE_ID, env.OWNER_SITE_USER_ID).first();
        if (!current || current.run !== run || !['queued', 'running'].includes(current.status))
          return { status: 'stopped' };
        return await scanWindow(env, searchId);
      });
      if (state.status !== 'running') return state;
      // Shared 30/min owner limiter also applies; leave headroom for interactive reads.
      await step.sleep('pace-window-' + i, '3 seconds');
    }

    // Deterministic child ID makes retries of the continuation idempotent.
    // Trigger another Workflow instance before exhausting the Free subrequest budget.
    await step.do('continue-search', {
      retries: { limit: 3, delay: '15 seconds', backoff: 'constant' }
    }, async () => {
      const next = searchId + '-' + run + '-' + (cycle + 1);
      try {
        await env.SEARCH_WORKFLOW.create({
          id: next, params: { searchId, run, cycle: cycle + 1 }
        });
      } catch (error) {
        // The child may have been created before a retry/replay.
        if (!/already exists|already in use|conflict|instance\.already_exists/i.test(
          String(error?.message ?? '')
        )) throw error;
      }
      return true;
    });
  } catch (error) {
    // Expired read-only grants are never refreshed silently.
    const code = error?.message === 'Reauthorization required'
      ? 'reauthorization_required' : 'scan_interrupted';
    await markInterrupted(env, searchId, code, run);
    return { status: code };
  }
}
