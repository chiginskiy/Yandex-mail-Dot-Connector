import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthenticatedBridge} from '../bridge/src/bridge-wrapper.mjs';
import {createWorker} from '../bridge/src/worker.js';
import {featureClient} from '../bridge/test/feature-client.js';
import {TEST_ENV} from '../bridge/test/fake-client.js';
import {createMcpHandler,createSignedBridgeClient,ownerAuthorizer} from '../site/src/mcp.mjs';
import {signedBridgeRequest} from '../site/src/signing.mjs';
import {assembleChunks} from '../site/scripts/assemble-attachment.mjs';
async function fixture(){
 const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);const nonces=new Set();let denied=false;
 const env={...TEST_ENV,BRIDGE_SECRET:undefined,BRIDGE_ORIGIN:'https://bridge.example.invalid',SITE_ORIGIN:'https://site.example.invalid',SITE_ID:'synthetic-site',OWNER_SITE_USER_ID:'synthetic-owner',SITE_PUBLIC_KEY_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.publicKey)),YANDEX_CLIENT_ID:'synthetic-client',PERIMETER_LIMITER:{limit:async()=>({success:true})},OWNER_LIMITER:{limit:async()=>({success:!denied})}};
 const store={getToken:async()=>({owner:TEST_ENV.YANDEX_OWNER_EMAIL,scope:'mail:imap_ro',accessToken:'synthetic-token',expiresAt:Date.now()+3600000}),claimNonce:async({nonce})=>{if(nonces.has(nonce))return false;nonces.add(nonce);return true;}};
 const bridge=createAuthenticatedBridge({storeFor:()=>store,coreFactory:options=>createWorker({...options,createClient:featureClient})});
 const bridgeCall=createSignedBridgeClient({origin:env.BRIDGE_ORIGIN,siteId:env.SITE_ID,getSigningKey:async()=>pair.privateKey,signRequest:signedBridgeRequest,fetchImpl:request=>bridge.fetch(request,env)});
 const handler=createMcpHandler({authorizeOwner:ownerAuthorizer({ownerUserId:env.OWNER_SITE_USER_ID,ownerEmail:TEST_ENV.YANDEX_OWNER_EMAIL}),bridgeCall});
 const call=async(name,args={})=>(await handler(new Request(env.SITE_ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':env.OWNER_SITE_USER_ID,'oai-authenticated-user-email':TEST_ENV.YANDEX_OWNER_EMAIL},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}))).json();
 return{call,bridge,env,pair,deny:value=>denied=value};
}
test('production signed bridge to MCP supports all five read tools and exact attachment decoding',async()=>{
 const f=await fixture();
 for(const[name,args]of [['yandex_mail_folders',{}],['yandex_mail_list',{}],['yandex_mail_search',{subject:'synthetic'}],['yandex_mail_read',{uid:9,uidValidity:'42'}]]){
  const r=await f.call(name,args);assert.equal(r.result.isError,false,name);const body=JSON.parse(r.result.content[0].text);
  if(name==='yandex_mail_folders')assert.equal(body.sentMailbox,'ServerSent');
  if(name==='yandex_mail_read'){assert.equal(body.text,'Safe & HTML');assert.equal(body.attachments.length,1);}
 }
 const chunk=await f.call('yandex_mail_attachment',{uid:9,uidValidity:'42',part:'2',offset:0});
 const result=assembleChunks([chunk]);assert.deepEqual(result.bytes,Buffer.from('abcd'));assert.equal(result.metadata.sizeBytes,4);
});
test('bridge rate limit crosses signed adapter as safe bounded machine-readable MCP status',async()=>{
 const f=await fixture();f.deny(true);const r=await f.call('yandex_mail_attachment',{uid:9,uidValidity:'42',part:'2'});
 assert.equal(r.result.isError,true);assert.deepEqual(r.result.structuredContent,{status:'rate_limited',httpStatus:429,retryAfterSeconds:60});
 f.deny(false);assert.equal((await f.call('yandex_mail_attachment',{uid:9,uidValidity:'42',part:'2'})).result.isError,false);
});
test('canonical wrapper still rejects signature replay and raw unsigned calls',async()=>{
 const f=await fixture();const request=await signedBridgeRequest({url:f.env.BRIDGE_ORIGIN+'/v1/messages/list',body:'{}',siteId:f.env.SITE_ID,ownerId:f.env.OWNER_SITE_USER_ID,privateKey:f.pair.privateKey});
 assert.equal((await f.bridge.fetch(request.clone(),f.env)).status,200);assert.equal((await f.bridge.fetch(request.clone(),f.env)).status,401);
 assert.equal((await f.bridge.fetch(new Request(request.url,{method:'POST',body:'{}',headers:{'content-type':'application/json'}}),f.env)).status,401);
});
