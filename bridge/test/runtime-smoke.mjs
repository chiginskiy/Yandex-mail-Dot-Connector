import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { TEST_ENV } from './fake-client.js';
execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','test/wrangler.jsonc','--outdir','../dist/runtime'],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const mf=new Miniflare({...convertV4MiniflareOptions({modules:true,scriptPath:'dist/runtime/runtime-entry.js',compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],bindings:TEST_ENV}),telemetry:{enabled:false}});
try {
  for(const [operation,input] of [['list',{}],['search',{subject:'synthetic'}],['read',{uid:8,uidValidity:'42'}]]) {
    const result=await mf.dispatchFetch(`https://bridge.example.invalid/v1/messages/${operation}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${TEST_ENV.BRIDGE_SECRET}`},body:JSON.stringify(input)});
    assert.equal(result.status,200);const body=await result.json();assert.equal(body.uidValidity,'42');
    if(operation==='read')assert.equal(body.text,'Synthetic body');else assert.equal(body.messages.length,2);
  }
  const denied=await mf.dispatchFetch('https://bridge.example.invalid/v1/messages/list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);
  const call=async(path,input)=>mf.dispatchFetch('https://bridge.example.invalid'+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${TEST_ENV.BRIDGE_SECRET}`},body:JSON.stringify(input)});
  const folders=await call('/v1/mailboxes/discover',{});assert.equal(folders.status,200);assert.equal((await folders.json()).sentMailbox,'ServerSent');
  const html=await call('/v1/messages/read',{uid:9,uidValidity:'42'});assert.equal(html.status,200);const htmlBody=await html.json();assert.equal(htmlBody.text,'Safe & HTML');assert.equal(htmlBody.textSource,'html_to_text');assert.equal(htmlBody.attachments.length,1);
  const attachment=await call('/v1/messages/attachment',{uid:9,uidValidity:'42',part:'2',offset:0});assert.equal(attachment.status,200);const chunk=await attachment.json();assert.equal(Buffer.from(chunk.dataBase64,'base64').toString(),'YWJj\r\nZA==');assert.equal(chunk.done,true);
  console.log('PASS: real local Cloudflare workerd runtime; synthetic list/search/read, HTML fallback, Sent discovery, exact attachment chunk, auth rejection');
} finally {await mf.dispose();}
