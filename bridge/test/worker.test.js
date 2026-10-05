import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createWorker } from '../src/worker.js';
import { imapOptions } from '../src/imap.js';
import { LIMITS } from '../src/validation.js';
import { fakeClient, fakeMessage, TEST_ENV, TEST_GRANT } from './fake-client.js';

function request(operation = 'list', body = {}, extra = {}) {
  return new Request(`https://bridge.example.invalid/v1/messages/${operation}`, {method:'POST', headers:{authorization:`Bearer ${TEST_ENV.BRIDGE_SECRET}`,'content-type':'application/json',...extra.headers}, body:typeof body === 'string' ? body : JSON.stringify(body), ...extra});
}
function harness(overrides = {}, options = {}) {
  const client = fakeClient(overrides);
  let created = 0;
  const worker = createWorker({getAccessToken:async()=>TEST_GRANT,createClient:()=>{created++;return client;},...options});
  return {client,worker,get created(){return created;},fetch:(r=request(),env=TEST_ENV)=>worker.fetch(r,env)};
}
test('unauthenticated, weak secret, unknown endpoint, and write routes never connect', async () => {
  const h = harness();
  for (const r of [request('list',{}, {headers:{'content-type':'application/json'}}),request('delete'),request('send'),request('list',{}, {headers:{authorization:'Bearer wrong','content-type':'application/json'}})]) assert.ok([401,404].includes((await h.fetch(r)).status));
  assert.equal((await h.fetch(request(),{...TEST_ENV,BRIDGE_SECRET:'short'})).status,503);
  assert.equal(h.created,0);
});
test('default token provider fails closed instead of accepting manually pasted token', async () => {
  const worker = createWorker();
  const r = await worker.fetch(request(),{...TEST_ENV,YANDEX_ACCESS_TOKEN:'should-not-be-used'});
  assert.equal(r.status,503); assert.deepEqual(await r.json(),{error:{code:'oauth_setup_required'}});
});
test('reject malformed fields, dates, CRLF, out of range, query strings, oversized and non-JSON bodies',async()=>{
  const h = harness();
  for (const [op,body] of [['list',{host:'evil.invalid'}],['list',{mailbox:'INBOX\r\nDELETE'}],['list',{limit:51}],['list',{limit:0}],['list',{beforeUid:-1}],['search',{}],['search',{since:'2026-02-30'}],['search',{unseen:'yes'}],['read',{uid:3,uidValidity:42}],['read',{uid:0,uidValidity:'42'}],['list',[]],['list','{']]) assert.equal((await h.fetch(request(op,body))).status,400,JSON.stringify(body));
  assert.equal((await h.fetch(request('list',{mailbox:'Sent'}))).status,403);
  assert.equal((await h.fetch(request('list',' '.repeat(9000)))).status,413);
  assert.equal((await h.fetch(request('list',{}, {headers:{authorization:`Bearer ${TEST_ENV.BRIDGE_SECRET}`,'content-type':'text/plain'}}))).status,415);
  assert.equal((await h.fetch(new Request('https://bridge.example.invalid/v1/messages/list?secret=x',request()))).status,400);
  assert.equal(h.created,0);
});
test('list is bounded, sorted newest first, read-only and closes connection',async()=>{
  const h = harness(); const r = await h.fetch(request('list',{limit:1})); const body = await r.json();
  assert.equal(r.status,200); assert.deepEqual(body.messages.map(m=>m.uid),[8]); assert.equal(body.nextBeforeUid,8); assert.equal(body.uidValidity,'42');
  assert.deepEqual(h.client.calls.find(c=>c[0]==='lock'),['lock','INBOX',{readOnly:true}]);
  assert.deepEqual(h.client.calls.find(c=>c[0]==='search').slice(1),[{uid:'1:8'},{uid:true}]);
  assert.ok(h.client.calls.some(c=>c[0]==='release')); assert.ok(h.client.calls.some(c=>c[0]==='close'));
});
test('empty UID windows retain a cursor; upper bounds never use IMAP reversed ranges',async()=>{
  const h = harness({mailbox:{uidValidity:42n,uidNext:10000,exists:1,readOnly:true},search:async()=>[]});
  const body = await (await h.fetch(request('search',{subject:'absent'}))).json();
  assert.deepEqual(body.scannedUidRange,{fromUid:9000,toUid:9999}); assert.equal(body.nextBeforeUid,9000);
  const end = await (await h.fetch(request('list',{beforeUid:1}))).json(); assert.equal(end.nextBeforeUid,null); assert.deepEqual(end.messages,[]);
});
test('search maps only allowed fields and dates without raw IMAP',async()=>{
  const h = harness(); await h.fetch(request('search',{from:'example.invalid',to:'recipient@example.invalid',subject:'test',text:'hello',unseen:true,since:'2026-01-01',before:'2026-02-01'}));
  const q = h.client.calls.find(c=>c[0]==='search')[1]; assert.equal(q.to,'recipient@example.invalid'); assert.equal(q.seen,false); assert.equal(q.body,'hello'); assert.equal(q.since.toISOString(),'2026-01-01T00:00:00.000Z'); assert.equal(q.uid,'1:8');
});
test('read requires same UIDVALIDITY and prevents stale UID lookup',async()=>{
  const h = harness(); const r = await h.fetch(request('read',{uid:8,uidValidity:'41'}));
  assert.equal(r.status,409); assert.ok(!h.client.calls.some(c=>c[0]==='fetchOne'));
});
test('read has bounded text and never marks messages Seen',async()=>{
  const h = harness(); const body = await (await h.fetch(request('read',{uid:8,uidValidity:'42'}))).json();
  assert.equal(body.text,'Synthetic body'); assert.equal(body.attachmentsIncluded,false); assert.equal(body.bodyStatus,'ok');
  const options = h.client.calls.find(c=>c[0]==='download')[3]; assert.equal(options.maxBytes,LIMITS.textBytes+1); assert.equal(options.uid,true);
  assert.ok(!h.client.calls.some(c=>/Flags|Store|append|delete/i.test(c[0])));
});
test('text truncation is explicit and attached text is never the message body',async()=>{
  const h = harness({download:async()=>({content:Readable.from([Buffer.alloc(LIMITS.textBytes+1,65)])})});
  const body = await (await h.fetch(request('read',{uid:8,uidValidity:'42'}))).json(); assert.equal(body.text.length,LIMITS.textBytes); assert.equal(body.truncated,true);
  for(const structure of [{type:'text/plain',disposition:'attachment'}, {type:'message/rfc822',childNodes:[{type:'text/plain'}]}]) {
    const h2=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:structure})});
    const b=await(await h2.fetch(request('read',{uid:8,uidValidity:'42'}))).json(); assert.equal(b.bodyStatus,'no_supported_text'); assert.ok(!h2.client.calls.some(c=>c[0]==='download'));
  }
});
test('owner and broad OAuth scopes fail closed before socket creation',async()=>{
  for(const grant of [{...TEST_GRANT,owner:'someone@example.invalid'},{...TEST_GRANT,scopes:['mail:imap_full']},{...TEST_GRANT,scopes:['mail:imap_ro','mail:smtp']}]) {
    const h=harness({}, {getAccessToken:async()=>grant}); assert.equal((await h.fetch()).status,503);assert.equal(h.created,0);
  }
});
test('upstream errors and malformed IMAP output are not reflected',async()=>{
  for(const overrides of [{connect:async()=>{throw new Error('synthetic-private-detail');}},{mailbox:{readOnly:false}},{search:async()=>[999999]}]) {
    const h=harness(overrides); const r=await h.fetch(); assert.equal(r.status,502); const text=await r.text(); assert.ok(!text.includes('synthetic-private-detail'));
  }
});
test('operation timeout closes active sockets and late token does not create a socket',async()=>{
  const h=harness({connect:()=>new Promise(()=>{})},{operationTimeoutMs:10}); assert.equal((await h.fetch()).status,504); assert.ok(h.client.calls.some(c=>c[0]==='close'));
  const h2=harness({}, {operationTimeoutMs:5,getAccessToken:async()=>{await new Promise(r=>setTimeout(r,20));return TEST_GRANT;}});
  assert.equal((await h2.fetch()).status,504); await new Promise(r=>setTimeout(r,30));assert.equal(h2.created,0);
});
test('signature hook receives exact bounded request bytes',async()=>{
  let got;const h=harness({}, {authorizeRequest:async(r,e,b)=>{got=b.toString();return true;}});
  const r=await h.fetch(request('list',' { "limit": 1 } '));assert.equal(r.status,200);assert.equal(got,' { "limit": 1 } ');
  const denied=harness({}, {authorizeRequest:async()=>false});assert.equal((await denied.fetch()).status,401);assert.equal(denied.created,0);
});
test('production IMAP settings are fixed TLS993 with all logging disabled',()=>{
  const o=imapOptions(TEST_GRANT.owner,TEST_GRANT.accessToken);assert.equal(o.host,'imap.yandex.com');assert.equal(o.port,993);assert.equal(o.secure,true);assert.equal(o.logger,false);assert.equal(o.logRaw,false);assert.equal(o.emitLogs,false);assert.equal(o.disableAutoIdle,true);assert.equal(o.auth.pass,undefined);assert.equal(o.tls?.rejectUnauthorized,undefined);
});
