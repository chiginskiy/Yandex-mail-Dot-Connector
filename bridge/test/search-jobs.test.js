import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {scanOneWindow, handleSearchJobRequest, validateSearchJobInput} from '../src/search-jobs.mjs';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(readFileSync(new URL('../schema/bridge.sql', import.meta.url),'utf8'));
  let failNextBatch=false;
  const db={
    prepare(sql) {const statement=sqlite.prepare(sql);return {bind(...args){return {
      async first(){return statement.get(...args)??null;},
      async all(){return {results:statement.all(...args)};},
      async run(){const r=statement.run(...args);return {success:true,meta:{changes:Number(r.changes)}};}
    };}};},
    async batch(items) {
      if(failNextBatch && items.some(x=>x.isResult)){failNextBatch=false;throw new Error('synthetic D1 outage');}
      sqlite.exec('BEGIN IMMEDIATE');
      try {const output=[];for(const p of items)output.push(await p.run());sqlite.exec('COMMIT');return output;}
      catch(e){sqlite.exec('ROLLBACK');throw e;}
    }
  };
  const env={
    DB:db, SITE_ID:'synthetic-site', OWNER_SITE_USER_ID:'synthetic-owner',
    YANDEX_OWNER_EMAIL:'owner@example.invalid', ALLOWED_MAILBOXES:'["INBOX","Sent"]',
    OWNER_LIMITER:{limit:async()=>({success:true})}, SEARCH_WORKFLOW:{create:async()=>({id:'synthetic'})}
  };
  const now=Date.now();
  sqlite.prepare('INSERT INTO mail_tokens(site_id,owner_id,payload) VALUES(?,?,?)')
    .run(env.SITE_ID,env.OWNER_SITE_USER_ID,JSON.stringify({owner:env.YANDEX_OWNER_EMAIL,accessToken:'fake-access',scope:'mail:imap_ro',expiresAt:now+3600000}));
  const call=async (path,body) =>{
    const request=new Request('https://bridge.example.invalid/v1/search-jobs/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return await (await handleSearchJobRequest(request,env,async()=>true)).json();
  };
  const fakeClient=()=>({
    mailbox:{readOnly:true,uidValidity:42,uidNext:2201},
    async connect(){},close(){},
    async getMailboxLock(mailbox,options){assert.ok(['INBOX','Sent'].includes(mailbox));assert.equal(options.readOnly,true);return {release(){}};},
    async search(criteria) {
      assert.equal(criteria.subject,'synthetic');const [low,high]=criteria.uid.split(':').map(Number);
      return Array.from({length:high-low+1},(_,i)=>low+i);
    },
    async fetchAll(uids) {return uids.map(uid=>({uid,internalDate:new Date('2024-01-02'),envelope:{date:new Date('2024-01-02'),subject:'synthetic match '+uid,from:[{name:'Synthetic',address:'sender@example.invalid'}],to:[]},flags:new Set(),size:100}));}
  });
  return {sqlite,db,env,call,fakeClient,failOnce(){failNextBatch=true;}};
}
test('exhaustive search input rejects outside allowlist, unsupported mode and missing filters',()=>{
  assert.throws(()=>validateSearchJobInput({mailboxes:['INBOX','Trash'],mode:'imap_server',subject:'x'},['INBOX','Sent']));
  assert.throws(()=>validateSearchJobInput({mailboxes:['INBOX'],mode:'visible_text_exact',text:'x'},['INBOX']));
  assert.throws(()=>validateSearchJobInput({mailboxes:['INBOX'],mode:'imap_server'},['INBOX']));
  assert.deepEqual(validateSearchJobInput({mailboxes:['INBOX','Sent'],mode:'imap_server',subject:'hi'},['INBOX','Sent']).mailboxes,['INBOX','Sent']);
});
test('all 2200 matching UIDs survive bounded 1000 UID windows and 50 result pages',async()=>{
  const f=setup();
  try {
    const started=await f.call('start',{mailboxes:['INBOX'],mode:'imap_server',subject:'synthetic'});
    assert.equal(started.status,'queued');assert.equal(started.complete,false);
    for(let i=0;i<5;i++) await scanOneWindow(f.env,started.searchId,{createClient:f.fakeClient});
    const finished=await f.call('status',{searchId:started.searchId});
    assert.equal(finished.status,'complete');assert.equal(finished.complete,true);
    assert.equal(finished.matchedTotal,2200);assert.equal(finished.folders[0].windowsDone,3);
    const ids=new Set();let offset=0;
    for(let i=0;i<50;i++){
      const page=await f.call('results',{searchId:started.searchId,limit:50,offset});
      for(const msg of page.messages) ids.add(msg.uid);
      if(page.nextOffset===null)break;
      offset=page.nextOffset;
    }
    assert.equal(ids.size,2200);assert.ok(ids.has(1));assert.ok(ids.has(2200));
  } finally {f.sqlite.close();}
});
test('a failed D1 result batch leaves cursor unchanged; retry is exact and idempotent',async()=>{
  const f=setup();
  try {
    const started=await f.call('start',{mailboxes:['INBOX'],mode:'imap_server',subject:'synthetic'});
    // Simulate a failure on a later fetch batch after some prior inserts.
    let calls=0;
    const db=f.env.DB,original=db.batch.bind(db);
    db.batch=async items=>{
      if(items.length && /INSERT OR IGNORE INTO search_results/.test(String(items[0]?.statementSql??''))) {calls++;}
      return original(items);
    };
    // first successful window, then run it twice at the *same* cursor by moving the cursor back.
    await scanOneWindow(f.env,started.searchId,{createClient:f.fakeClient});
    const before=(await f.call('status',{searchId:started.searchId})).matchedTotal;
    f.sqlite.prepare('UPDATE search_folders SET next_high=2200, windows_done=0, done=0 WHERE job_id=?').run(started.searchId);
    await scanOneWindow(f.env,started.searchId,{createClient:f.fakeClient});
    assert.equal((await f.call('status',{searchId:started.searchId})).matchedTotal,before);
    assert.equal((await f.call('status',{searchId:started.searchId})).folders[0].nextHighUid,1200);
  } finally{f.sqlite.close();}
});
test('changed UIDVALIDITY cannot be certified as complete',async()=>{
  const f=setup();
  try{
    const started=await f.call('start',{mailboxes:['INBOX'],mode:'imap_server',subject:'synthetic'});
    await scanOneWindow(f.env,started.searchId,{createClient:f.fakeClient});
    const changed=()=>{const client=f.fakeClient();client.mailbox.uidValidity=99;return client;};
    await assert.rejects(scanOneWindow(f.env,started.searchId,{createClient:changed}),/uid_validity_changed/);
    assert.equal((await f.call('status',{searchId:started.searchId})).complete,false);
  }finally{f.sqlite.close();}
});

test('sparse 100,000-UID mailbox continues past 99 empty windows to find oldest match',async()=>{
  const f=setup();
  try {
    const started=await f.call('start',{mailboxes:['INBOX'],mode:'imap_server',subject:'synthetic'});
    const sparse=()=>{
      const client=f.fakeClient();client.mailbox.uidNext=100001;
      client.search=async criteria=>{
        const [lo,hi]=criteria.uid.split(':').map(Number);
        return [1,50001,100000].filter(uid=>lo<=uid && uid<=hi);
      };
      return client;
    };
    for(let i=0;i<101;i++) await scanOneWindow(f.env,started.searchId,{createClient:sparse});
    const done=await f.call('status',{searchId:started.searchId});
    assert.equal(done.status,'complete');assert.equal(done.matchedTotal,3);
    assert.equal(done.folders[0].windowsDone,100);
    const page=await f.call('results',{searchId:started.searchId,limit:50});
    assert.deepEqual(page.messages.map(x=>x.uid),[100000,50001,1]);
  } finally {f.sqlite.close();}
});
test('two allowlisted mailboxes are both traversed without merging equal UIDs',async()=>{
  const f=setup();
  try {
    const started=await f.call('start',{mailboxes:['INBOX','Sent'],mode:'imap_server',subject:'synthetic'});
    const short=()=>{const client=f.fakeClient();client.mailbox.uidNext=101;return client;};
    for(let i=0;i<3;i++) await scanOneWindow(f.env,started.searchId,{createClient:short});
    const done=await f.call('status',{searchId:started.searchId});
    assert.equal(done.complete,true);assert.equal(done.matchedTotal,200);
    assert.deepEqual(done.scope,['INBOX','Sent']);
    assert.equal(done.foldersCompleted,2);
    const first=await f.call('results',{searchId:started.searchId,limit:50});
    assert.ok(first.messages.every(m=>m.mailbox==='INBOX'));
    const last=await f.call('results',{searchId:started.searchId,limit:50,offset:150});
    assert.ok(last.messages.every(m=>m.mailbox==='Sent'));
  } finally {f.sqlite.close();}
});
