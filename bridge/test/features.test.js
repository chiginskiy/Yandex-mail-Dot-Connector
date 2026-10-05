import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createWorker } from '../src/worker.js';
import { htmlToText, inspectMime, safeFilename } from '../src/mime.js';
import { LIMITS } from '../src/validation.js';
import { fakeClient, fakeMessage, TEST_ENV, TEST_GRANT } from './fake-client.js';

const attachment = (part='2', props={}) => ({part,type:'application/octet-stream',disposition:'attachment',dispositionParameters:{filename:'sample.bin'},encoding:'base64',size:8,...props});
const tree = nodes => ({type:'multipart/mixed',childNodes:nodes});
function harness(overrides={}) {
  const client=fakeClient(overrides);
  const worker=createWorker({getAccessToken:async()=>TEST_GRANT,createClient:()=>client});
  return {client,call:async(path,body={},env=TEST_ENV)=>worker.fetch(new Request('https://bridge.example.invalid'+path,{method:'POST',headers:{authorization:`Bearer ${TEST_ENV.BRIDGE_SECRET}`,'content-type':'application/json'},body:JSON.stringify(body)}),env)};
}
const read=(h)=>h.call('/v1/messages/read',{uid:8,uidValidity:'42'});
const input={uid:8,uidValidity:'42',part:'2',offset:0};
const download=(h,body=input)=>h.call('/v1/messages/attachment',body);

test('HTML parsing yields text and entities only, no active/hidden/remote content',()=>{
  const html='<!doctype html><html><head><title>secret head</title><style>secret css</style></head><body><p>Hello&nbsp;&amp; привет</p><script>secret script</script><img src="https://evil.invalid/track" onerror="secret handler"><a href="javascript:secret">visible link</a><div hidden>secret hidden</div><div style="display: none">secret css hidden</div><iframe>secret iframe</iframe><svg><text>secret svg</text></svg><p>End<br>line</p></body></html>';
  const result=htmlToText(html);
  assert.equal(result.truncated,false);assert.match(result.text,/Hello & привет/);assert.match(result.text,/visible link/);assert.match(result.text,/End\nline/);
  assert.doesNotMatch(result.text,/secret|evil|javascript|src|onerror/);
});
test('HTML malformed markup and large UTF8 output stay bounded without replacement character from truncation',()=>{
  const result=htmlToText('<p>'+('я'.repeat(50000))+'<script>hidden');
  assert.ok(Buffer.byteLength(result.text)<=LIMITS.textBytes);assert.equal(result.truncated,true);assert.ok(!result.text.includes('\ufffd'));
});
test('plain text is preferred over HTML regardless order; attached and forwarded parts excluded',async()=>{
  const structure=tree([{part:'1',type:'text/html'},attachment('2',{type:'text/plain'}),{part:'3',type:'message/rfc822',childNodes:[{part:'3.1',type:'text/plain'}]},{part:'4',type:'text/plain'}]);
  const h=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:structure})});
  const response=await read(h);const body=await response.json();assert.equal(response.status,200);assert.equal(body.textSource,'plain');assert.equal(body.attachments.length,2);assert.equal(body.attachmentsIncluded,false);assert.equal(h.client.calls.find(c=>c[0]==='download')[2],'4');
});
test('HTML fallback has conversion provenance and independent 128KiB source/32KiB text limits',async()=>{
  const h=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:{part:'1',type:'text/html'}}),download:async()=>({content:Readable.from([Buffer.from('<p>HTML &amp; body</p><script>bad()</script>')])})});
  const body=await(await read(h)).json();assert.equal(body.text,'HTML & body');assert.equal(body.textSource,'html_to_text');assert.equal(body.htmlConversion.remoteContentLoaded,false);
  const big=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:{part:'1',type:'text/html'}}),download:async()=>({content:Readable.from([Buffer.alloc(LIMITS.htmlBytes+1,65)])})});
  const b=await(await read(big)).json();assert.equal(b.bodyStatus,'truncated');assert.equal(b.htmlConversion.sourceTruncated,true);assert.equal(b.htmlConversion.textTruncated,true);assert.equal(Buffer.byteLength(b.text),LIMITS.textBytes);
});
test('MIME inspection bounds trees and metadata, safe filenames cannot contain paths or Windows device names',()=>{
  assert.equal(safeFilename('../../CON.txt','2'),'_.._CON.txt');assert.equal(safeFilename('CON.txt','2'),'_CON.txt');assert.equal(safeFilename('','2'),'attachment-2.bin');assert.equal(safeFilename('a\r\nb\\c.txt','2'),'a__b_c.txt');
  const m=inspectMime(tree(Array.from({length:150},(_,i)=>attachment(String(i+1)))));assert.equal(m.attachments.length,LIMITS.attachments);assert.equal(m.attachmentsTruncated,true);
  assert.equal(inspectMime(attachment('1',{size:LIMITS.attachmentEncodedBytes+1})).attachments[0].downloadable,false);
});
test('folder discovery trusts extension Sent only; lists metadata without selecting a mailbox',async()=>{
  let options;const h=harness({list:async value=>{options=value;return [{path:'INBOX',flags:new Set()},{path:'Отправленные',flags:new Set(['\\Sent']),specialUse:'\\Sent',specialUseSource:'extension'},{path:'Sent',flags:new Set(),specialUse:'\\Sent',specialUseSource:'name'}];}});
  const r=await h.call('/v1/mailboxes/discover');const body=await r.json();assert.equal(r.status,200);assert.equal(options,undefined);assert.equal(body.sentMailbox,'Отправленные');assert.equal(body.folders[1].allowed,false);assert.equal(body.requiresExplicitConfiguration,true);assert.ok(!h.client.calls.some(c=>c[0]==='lock'));
  const denied=await h.call('/v1/messages/list',{mailbox:'Отправленные'});assert.equal(denied.status,403);
  const enabled=await h.call('/v1/messages/list',{mailbox:'Отправленные'},{...TEST_ENV,ALLOWED_MAILBOXES:'["INBOX","Отправленные"]'});assert.equal(enabled.status,200);
});
test('unknown, guessed, multiple, or truncated Sent candidates never become an automatic choice',async()=>{
  for(const entries of [[{path:'Sent',flags:new Set(),specialUse:'\\Sent',specialUseSource:'name'}],[{path:'Sent',flags:new Set(['\\Sent']),specialUse:'\\Sent',specialUseSource:'extension'},{path:'Other',flags:new Set(['\\Sent'])}],Array.from({length:101},(_,i)=>({path:'Folder'+i,flags:new Set()}))]){
    const h=harness({list:async()=>entries});const b=await(await h.call('/v1/mailboxes/discover')).json();assert.equal(b.sentMailbox,null);
  }
});
test('attachment endpoint returns exact partial transfer bytes, identity and hash, never calls download',async()=>{
  const raw=Buffer.from('YWJj\r\nZA==');let query;
  const h=harness({fetchOne:async(uid,q)=>{if(q.bodyStructure)return{...fakeMessage(),bodyStructure:tree([attachment('2',{size:raw.length})])};query=q;return{uid,bodyParts:new Map([['2',raw]])};}});
  const r=await download(h);const b=await r.json();assert.equal(r.status,200);assert.equal(b.dataBase64,raw.toString('base64'));assert.equal(b.nextOffset,raw.length);assert.equal(b.done,true);assert.equal(b.chunkSha256,createHash('sha256').update(raw).digest('hex'));assert.match(b.metadataFingerprint,/^[a-f0-9]{64}$/);assert.equal(b.maxDecodedBytes,20971520);assert.deepEqual(query.bodyParts,[{key:'2',start:0,maxLength:raw.length}]);assert.ok(!h.client.calls.some(c=>c[0]==='download'));
});
test('attachment byte ranges preserve binary/legacy charset and split MIME encodings unmodified',async()=>{
  const raw=Buffer.concat([Buffer.alloc(LIMITS.attachmentChunkBytes-1,65),Buffer.from('=D0=CF\r\n=\r\n')]);
  const calls=[];const h=harness({fetchOne:async(uid,q)=>{if(q.bodyStructure)return{...fakeMessage(),bodyStructure:tree([attachment('2',{size:raw.length,encoding:'quoted-printable',type:'text/plain',parameters:{charset:'windows-1251'}})])};const p=q.bodyParts[0];calls.push(p);return{uid,bodyParts:new Map([['2',raw.subarray(p.start,p.start+p.maxLength)]])};}});
  const first=await(await download(h)).json();const last=await(await download(h,{...input,offset:first.nextOffset})).json();assert.equal(first.done,false);assert.equal(last.done,true);assert.deepEqual(Buffer.concat([Buffer.from(first.dataBase64,'base64'),Buffer.from(last.dataBase64,'base64')]),raw);assert.equal(calls[0].maxLength,LIMITS.attachmentChunkBytes);assert.equal(first.metadataFingerprint,last.metadataFingerprint);
});
test('stale UIDVALIDITY, arbitrary parts, missing attachments, invalid offset and upstream size errors fail closed',async()=>{
  const h=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:tree([attachment()]),bodyParts:new Map([['2',Buffer.from('short')]])})});
  for(const [body,status]of[[{...input,uidValidity:'41'},409],[{...input,part:'2.MIME'},400],[{...input,part:'1'},404],[{...input,offset:-1},400],[{...input,offset:8},400],[{...input,offset:9},400],[{...input,length:100},400],[input,502]])assert.equal((await download(h,body)).status,status);
});
test('oversized/unsupported attachments have metadata but cannot be downloaded; empty files work',async()=>{
  for(const [props,status]of[[{size:LIMITS.attachmentEncodedBytes+1},413],[{size:LIMITS.attachmentBytes+1,encoding:'binary'},413],[{encoding:'x-custom'},422],[{size:undefined},422]]){
    const h=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:tree([attachment('2',props)])})});assert.equal((await download(h)).status,status);
  }
  const empty=harness({fetchOne:async()=>({...fakeMessage(),bodyStructure:tree([attachment('2',{size:0})])})});const b=await(await download(empty)).json();assert.equal(b.dataBase64,'');assert.equal(b.nextOffset,0);assert.equal(b.done,true);
});

test('20 MiB decoded and 64 MiB encoded boundaries retain 128 KiB reads and response cap',async()=>{
  assert.equal(LIMITS.attachmentBytes,20*1024*1024);
  assert.equal(LIMITS.attachmentEncodedBytes,64*1024*1024);
  assert.equal(LIMITS.attachmentChunkBytes,128*1024);
  assert.equal(LIMITS.responseBytes,256*1024);
  for(const encoding of ['binary','7bit','8bit','base64','quoted-printable']){
    const cap=['base64','quoted-printable'].includes(encoding)?LIMITS.attachmentEncodedBytes:LIMITS.attachmentBytes;
    for(const difference of [-1,0,1]){
      const size=cap+difference;
      const metadata=inspectMime(attachment('2',{size,encoding})).attachments[0];
      assert.equal(metadata.maxDecodedBytes,LIMITS.attachmentBytes);
      assert.equal(metadata.downloadable,difference<=0);
      const ranges=[];
      const h=harness({fetchOne:async(uid,q)=>{
        if(q.bodyStructure)return{...fakeMessage(),bodyStructure:tree([attachment('2',{size,encoding})])};
        const range=q.bodyParts[0];ranges.push(range);
        return{uid,bodyParts:new Map([['2',Buffer.alloc(range.maxLength,65)]])};
      }});
      const response=await download(h);
      assert.equal(response.status,difference>0?413:200);
      if(difference>0){assert.equal(ranges.length,0);continue;}
      const text=await response.text(), chunk=JSON.parse(text);
      assert.ok(Buffer.byteLength(text)<LIMITS.responseBytes);
      assert.equal(Buffer.from(chunk.dataBase64,'base64').length,LIMITS.attachmentChunkBytes);
      assert.equal(ranges[0].maxLength,LIMITS.attachmentChunkBytes);
      assert.equal(chunk.nextOffset,LIMITS.attachmentChunkBytes);
      assert.equal(chunk.done,false);
    }
  }
});
