import { Readable } from 'node:stream';
export const TEST_ENV = {YANDEX_OWNER_EMAIL: 'synthetic@example.invalid', BRIDGE_SECRET: 'synthetic-test-fixture-never-a-real-secret', ALLOWED_MAILBOXES: '["INBOX"]'};
export const TEST_GRANT = {owner: TEST_ENV.YANDEX_OWNER_EMAIL, accessToken: 'synthetic-placeholder', scopes: ['mail:imap_ro']};
export function fakeMessage(uid = 8) {
  return {uid, size: 50, flags: new Set(), envelope: {subject: 'Synthetic message', from: [{name: 'Test sender', address: 'sender@example.invalid'}], to: [], date: new Date('2026-01-01')}, bodyStructure: {type: 'text/plain', part: '1'}};
}
export function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls, mailbox: {uidValidity: 42n, uidNext: 9, exists: 2, readOnly: true},
    async connect() { calls.push(['connect']); },
    close() { calls.push(['close']); },
    async getMailboxLock(name, options) { calls.push(['lock', name, options]); return {release() {calls.push(['release']);}}; },
    async search(query, options) { calls.push(['search', query, options]); return [7, 8]; },
    async fetchAll(uids, query, options) { calls.push(['fetchAll', uids, query, options]); return uids.map(fakeMessage); },
    async fetchOne(uid, query, options) { calls.push(['fetchOne', uid, query, options]); return fakeMessage(uid); },
    async download(uid, part, options) {calls.push(['download', uid, part, options]); return {meta:{}, content:Readable.from([Buffer.from('Synthetic body')])};},
    ...overrides,
  };
}
