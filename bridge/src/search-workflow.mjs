// Cloudflare durable runner: job data/progress live in private D1, not Workflow event payloads.
// No mail credentials, message bodies, or attachment bytes enter Workflow state.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { scanOneWindow, markSearchInterrupted } from './search-jobs.mjs';

const WINDOWS_PER_INSTANCE = 400; // below the 1,024-step Free allowance

export class ExhaustiveMailSearchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { searchId, run = 0, cycle = 0 } = event.payload ?? {};
    if (typeof searchId !== 'string' || typeof run !== 'number' ||
        !Number.isInteger(cycle) || cycle < 0 || cycle > 1000000) return;
    try {
      for (let i = 0; i < WINDOWS_PER_INSTANCE; i++) {
        const state = await step.do('scan-window-' + i, {
          retries: { limit: 8, delay: '60 seconds', backoff: 'constant' },
          timeout: '2 minutes'
        }, async () => {
          const current = await this.env.DB.prepare('SELECT status, run FROM search_jobs WHERE id=? AND site_id=? AND owner_id=?')
            .bind(searchId, this.env.SITE_ID, this.env.OWNER_SITE_USER_ID).first();
          if (!current || current.run !== run || !['queued','running'].includes(current.status))
            return { status: 'stopped' };
          return await scanOneWindow(this.env, searchId);
        });
        if (state.status !== 'running') return state;
        // Shared 30/min owner limiter also applies; leave headroom for interactive reads.
        await step.sleep('pace-window-' + i, '3 seconds');
      }
      // Re-enter with another instance before the per-instance step limit.
      // A deterministic ID makes a replayed continuation safe.
      await step.do('continue-search', { retries: { limit: 3, delay: '15 seconds', backoff: 'constant' } }, async () => {
        const next = searchId + '-' + run + '-' + (cycle + 1);
        try {
          await this.env.SEARCH_WORKFLOW.create({ id: next,
            params: { searchId, run, cycle: cycle + 1 } });
        } catch (error) {
          // A duplicate deterministic instance ID means the continuation already exists.
          if (!/already exists|already in use|conflict/i.test(String(error?.message ?? ''))) throw error;
        }
        return true;
      });
    } catch (error) {
      // A read-only grant expires deliberately without refresh tokens.
      const code = error?.message === 'Reauthorization required'
        ? 'reauthorization_required' : 'scan_interrupted';
      await markSearchInterrupted(this.env, searchId, code, run);
      return { status: code };
    }
  }
}
