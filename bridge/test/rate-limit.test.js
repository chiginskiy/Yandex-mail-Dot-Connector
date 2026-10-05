import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireRateLimit } from '../src/rate-limit.js';
import { createAuthenticatedBridge } from '../src/bridge-wrapper.mjs';
import { signedBridgeRequest } from '../src/signing.mjs';

test('required rate limiter fails closed on absent, malformed, throwing, and denied bindings',async()=>{
  for(const binding of [undefined,{}, {limit:async()=>({})},{limit:async()=>{throw new Error('private-provider-details');}}])await assert.rejects(()=>requireRateLimit(binding,'fixed'),error=>error.status===503&&error.code==='rate_limit_unavailable');
  await assert.rejects(()=>requireRateLimit({limit:async()=>({success:false})},'fixed'),error=>error.status===429);
  let key;await requireRateLimit({limit:async input=>{key=input.key;return{success:true};}},'fixed');assert.equal(key,'fixed');
});

test('perimeter limit runs before config, public-key import, body, or D1',async()=>{
  let stores=0;const worker=createAuthenticatedBridge({storeFor:()=>{stores++;throw new Error('must not reach store');}});
  const request=new Request('https://bridge.example.invalid/oauth/callback?state=not-real');
  const owner={limit:async()=>({success:true})};
  assert.equal((await worker.fetch(request,{OWNER_LIMITER:owner})).status,503);
  assert.equal((await worker.fetch(request,{OWNER_LIMITER:owner,PERIMETER_LIMITER:{limit:async()=>({success:false})}})).status,429);
  assert.equal(stores,0);
});

test('owner limit occurs after valid signature and before OAuth state creation',async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);let ownerCalls=0;let created=0;
  const env={SITE_ID:'test-site',OWNER_SITE_USER_ID:'test-owner',SITE_PUBLIC_KEY_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.publicKey)),SITE_ORIGIN:'https://private.example.invalid',BRIDGE_ORIGIN:'https://bridge.example.invalid',YANDEX_OWNER_EMAIL:'owner@example.invalid',YANDEX_CLIENT_ID:'test-client',PERIMETER_LIMITER:{limit:async()=>({success:true})},OWNER_LIMITER:{limit:async()=>{ownerCalls++;return{success:false};}}};
  const worker=createAuthenticatedBridge({storeFor:()=>({claimNonce:async()=>true,createState:async()=>{created++;}})});
  const unsigned=new Request(env.BRIDGE_ORIGIN+'/v1/oauth/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal((await worker.fetch(unsigned,env)).status,403);assert.equal(ownerCalls,0);
  const signed=await signedBridgeRequest({url:env.BRIDGE_ORIGIN+'/v1/oauth/start',body:'{}',privateKey:pair.privateKey,siteId:env.SITE_ID,ownerId:env.OWNER_SITE_USER_ID});
  const response=await worker.fetch(signed,env);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');assert.equal(ownerCalls,1);assert.equal(created,0);
});
