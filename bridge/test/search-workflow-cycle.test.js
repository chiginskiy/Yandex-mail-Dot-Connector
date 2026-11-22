import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOWS_PER_INSTANCE, runSearchCycle } from '../src/search-workflow-cycle.mjs';

const SEARCH_ID = '00000000-0000-4000-8000-000000000010';

test('a >100k-UID search continues across bounded Workflow instances under Free subrequest limits', async () => {
  assert.ok(WINDOWS_PER_INSTANCE > 0 && WINDOWS_PER_INSTANCE <= 12);
  const queued = [{ searchId: SEARCH_ID, run: 0, cycle: 0 }];
  const created = [];
  const seenIDs = new Set();
  const totalWindows = 145;
  let scanned = 0, completed = false, interrupted = 0;
  const env = {
    SITE_ID: 'fixture-site',
    OWNER_SITE_USER_ID: 'fixture-owner',
    DB: { prepare(sql) {
      assert.match(sql, /FROM search_jobs/);
      return { bind(searchId, siteId, ownerId) {
        assert.deepEqual([searchId, siteId, ownerId],
          [SEARCH_ID, env.SITE_ID, env.OWNER_SITE_USER_ID]);
        return { async first() { return { status: 'running', run: 0 }; } };
      } };
    } },
    SEARCH_WORKFLOW: { async create({ id, params }) {
      assert.equal(id, SEARCH_ID + '-0-' + params.cycle);
      assert.equal(seenIDs.has(id), false, 'continuation ID must be new');
      seenIDs.add(id);
      created.push({ id, params });
      queued.push(params);
    } }
  };
  let cycles = 0;
  while (queued.length) {
    const params = queued.shift();
    const stepNames = new Set();
    let externalRequests = 0;
    const step = {
      async do(name, options, callback) {
        assert.equal(stepNames.has(name), false, 'unique step name per cycle');
        stepNames.add(name);
        assert.equal(typeof callback, 'function');
        if (name.startsWith('scan-window-')) {
          assert.equal(options.retries.limit, 8);
          assert.equal(options.timeout, '2 minutes');
        }
        return callback();
      },
      async sleep(name, duration) {
        assert.ok(name.startsWith('pace-window-'));
        assert.equal(duration, '3 seconds');
      }
    };
    const state = await runSearchCycle({
      event: { payload: params }, step, env,
      scanWindow: async () => {
        externalRequests++;
        assert.ok(externalRequests <= 50, 'Free external subrequest cap');
        if (scanned === totalWindows) {
          completed = true;
          return { status: 'complete' };
        }
        scanned++;
        return { status: 'running' };
      },
      markInterrupted: async () => { interrupted++; }
    });
    assert.ok(externalRequests <= WINDOWS_PER_INSTANCE);
    cycles++;
    assert.ok(cycles <= 100, 'must terminate');
    if (state?.status === 'complete') {
      assert.equal(queued.length, 0, 'no continuation after complete');
      break;
    }
  }
  assert.equal(completed, true);
  assert.equal(scanned, totalWindows);
  assert.equal(interrupted, 0);
  assert.ok(cycles > 10, 'large mailbox must span many Workflow instances');
  assert.equal(created.length, cycles - 1);
  assert.deepEqual(created.map(x => x.params.cycle),
    Array.from({ length: cycles - 1 }, (_, i) => i + 1));
});

test('a duplicate deterministic continuation ID is safe on replay', async () => {
  const env = {
    SITE_ID: 'fixture-site', OWNER_SITE_USER_ID: 'fixture-owner',
    DB: { prepare() { return { bind() { return {
      async first() { return { status: 'running', run: 3 }; }
    }; } }; } },
    SEARCH_WORKFLOW: { async create() {
      throw new Error('Conflict (instance.already_exists)');
    } }
  };
  let scans = 0, interrupts = 0, continuations = 0;
  const step = {
    async do(name, options, callback) {
      if (name === 'continue-search') continuations++;
      return callback();
    },
    async sleep() {}
  };
  await runSearchCycle({
    event: { payload: { searchId: SEARCH_ID, run: 3, cycle: 7 } },
    step, env,
    scanWindow: async () => { scans++; return { status: 'running' }; },
    markInterrupted: async () => { interrupts++; }
  });
  assert.equal(scans, WINDOWS_PER_INSTANCE);
  assert.equal(continuations, 1);
  assert.equal(interrupts, 0);
});

test('failed scan leaves job incomplete and never falsely creates a continuation', async () => {
  let interrupted, created = 0;
  const env = {
    SITE_ID: 'fixture-site', OWNER_SITE_USER_ID: 'fixture-owner',
    DB: { prepare() { return { bind() { return {
      async first() { return { status: 'running', run: 0 }; }
    }; } }; } },
    SEARCH_WORKFLOW: { async create() { created++; } }
  };
  const state = await runSearchCycle({
    event: { payload: { searchId: SEARCH_ID, run: 0, cycle: 0 } },
    env,
    step: {
      async do(_name, _options, callback) { return callback(); },
      async sleep() { throw new Error('Must not sleep'); }
    },
    scanWindow: async () => {
      throw new Error('Too many subrequests by single Worker invocation');
    },
    markInterrupted: async (_env, id, code, run) => {
      interrupted = { id, code, run };
    }
  });
  assert.deepEqual(state, { status: 'scan_interrupted' });
  assert.deepEqual(interrupted, {
    id: SEARCH_ID, code: 'scan_interrupted', run: 0
  });
  assert.equal(created, 0);
});
