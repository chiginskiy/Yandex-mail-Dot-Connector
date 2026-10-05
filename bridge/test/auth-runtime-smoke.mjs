import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { TEST_ENV, TEST_GRANT } from './fake-client.js';
import { signedBridgeRequest } from '../src/signing.mjs';

execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','test/wrangler.auth.jsonc','--outdir','../dist/auth-runtime'],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
// Ephemeral synthetic signing keys, never associated with an account or live access.
const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const env={...TEST_ENV,BRIDGE_ORIGIN:'https://bridge.example.invalid',SITE_ORIGIN:'https://private-site.example.invalid',SITE_ID:'synthetic-site',OWNER_SITE_USER_ID:'synthetic-owner',SITE_PUBLIC_KEY_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.publicKey)),YANDEX_CLIENT_ID:'synthetic-client'};
let tokenRequests=0, unexpectedRequests=0;
const outboundService=async request=>{
  if(request.url!=='https://oauth.yandex.ru/token'){unexpectedRequests++;return new Response('Unexpected synthetic outbound request',{status:500});}
  tokenRequests++;
  assert.equal(request.method,'POST');
  const body=new URLSearchParams(await request.text());
  assert.equal(body.get('grant_type'),'authorization_code');
  const code=body.get('code');
  if(code?.startsWith('synthetic-redirect-'))return new Response(JSON.stringify({access_token:'must-not-use',token_type:'bearer',expires_in:3600}),{status:Number(code.slice(-3)),headers:{location:'https://redirect-target.example.invalid/collect','content-type':'application/json'}});
  assert.equal(code,'synthetic-code');
  return Response.json({access_token:TEST_GRANT.accessToken,token_type:'bearer',expires_in:3600,scope:'mail:imap_ro'});
};
const mf=new Miniflare({...convertV4MiniflareOptions({modules:true,scriptPath:'dist/auth-runtime/auth-runtime-entry.js',compatibilityDate:'2026-09-01',compatibilityFlags:['nodejs_compat'],bindings:env,outboundService,d1Databases:['DB'],ratelimits:{PERIMETER_LIMITER:{namespace_id:'71001',simple:{limit:120,period:60}},OWNER_LIMITER:{namespace_id:'71002',simple:{limit:30,period:60}}}}),telemetry:{enabled:false}});
const signed=(path,body)=>signedBridgeRequest({url:new URL(path,env.BRIDGE_ORIGIN).href,body:JSON.stringify(body),siteId:env.SITE_ID,ownerId:env.OWNER_SITE_USER_ID,privateKey:pair.privateKey});
const dispatch=async request=>mf.dispatchFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body:await request.text(),redirect:'manual'});
try {
  const db=await mf.getD1Database('DB');
  for(const statement of (await readFile('schema/bridge.sql','utf8')).split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  const initial=await dispatch(await signed('/v1/oauth/start',{}));assert.equal(initial.status,200,await initial.clone().text());
  const authorization=new URL((await initial.json()).authorizationUrl);assert.equal(authorization.origin,'https://oauth.yandex.ru');assert.equal(authorization.searchParams.get('scope'),'mail:imap_ro');assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  const callback=new URL('/oauth/callback',env.BRIDGE_ORIGIN);callback.searchParams.set('code','synthetic-code');callback.searchParams.set('state',authorization.searchParams.get('state'));
  // Exercise the real workerd native fetch, with all outbound traffic intercepted.
  // The old redirect:error fails even before reaching this mock.
  for(const status of [302,307,308]){
    const start=await dispatch(await signed('/v1/oauth/start',{}));assert.equal(start.status,200);
    const redirectState=new URL((await start.json()).authorizationUrl).searchParams.get('state');
    const redirectCallback=new URL('/oauth/callback',env.BRIDGE_ORIGIN);
    redirectCallback.searchParams.set('state',redirectState);redirectCallback.searchParams.set('code',`synthetic-redirect-${status}`);
    const refused=await mf.dispatchFetch(redirectCallback.href,{redirect:'manual'});assert.equal(refused.status,400);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mail_tokens').first()).n,0);
  }
  assert.equal(tokenRequests,3);assert.equal(unexpectedRequests,0,'OAuth redirects must never be followed');
  const accepted=await mf.dispatchFetch(callback.href,{redirect:'manual'});assert.equal(accepted.status,303);assert.equal(accepted.headers.get('location'),env.SITE_ORIGIN+'/?connection=authorized');
  assert.equal(tokenRequests,4);assert.equal(unexpectedRequests,0);
  const reused=await mf.dispatchFetch(callback.href,{redirect:'manual'});assert.equal(reused.status,400);
  for(const [operation,input] of [['list',{}],['search',{subject:'synthetic'}],['read',{uid:8,uidValidity:'42'}]]) {
    const req=await signed(`/v1/messages/${operation}`,input);
    const result=await dispatch(req.clone());assert.equal(result.status,200);const body=await result.json();assert.equal(body.uidValidity,'42');
    if(operation==='read')assert.equal(body.text,'Synthetic body');else assert.equal(body.messages.length,2);
    const replay=await dispatch(req.clone());assert.equal(replay.status,401);
  }
  const unsigned=await mf.dispatchFetch('https://bridge.example.invalid/v1/messages/list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unsigned.status,401);
  for(const [path,input] of [['/v1/mailboxes/discover',{}],['/v1/messages/read',{uid:9,uidValidity:'42'}],['/v1/messages/attachment',{uid:9,uidValidity:'42',part:'2',offset:0}]]){
    const req=await signed(path,input);const response=await dispatch(req.clone());assert.equal(response.status,200);const data=await response.json();
    if(path.endsWith('discover'))assert.equal(data.sentMailbox,'ServerSent');else if(path.endsWith('read'))assert.equal(data.textSource,'html_to_text');else assert.equal(Buffer.from(data.dataBase64,'base64').toString(),'YWJj\r\nZA==');
    assert.equal((await dispatch(req.clone())).status,401);
  }
  const wrong=new Request(await signed('/v1/messages/list',{}));wrong.headers.set('X-Ymail-Owner','another-owner');assert.equal((await dispatch(wrong)).status,401);
  console.log('PASS: real workerd native fetch + mocked OAuth endpoint; 302/307/308 never followed or persisted; D1, Ed25519, list/search/read/HTML/folders/attachment and replays pass (IMAP mocked)');
} finally {await mf.dispose();}
