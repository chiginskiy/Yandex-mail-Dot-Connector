// Cloudflare durable runner: job data/progress live in private D1, not Workflow event payloads.
// No mail credentials, message bodies, or attachment bytes enter Workflow state.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { scanOneWindow, markSearchInterrupted } from './search-jobs.mjs';
import { runSearchCycle } from './search-workflow-cycle.mjs';

export class ExhaustiveMailSearchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runSearchCycle({
      event, step, env: this.env,
      scanWindow: scanOneWindow,
      markInterrupted: markSearchInterrupted
    });
  }
}
