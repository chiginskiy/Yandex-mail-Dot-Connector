import { Readable } from 'node:stream';
import { fakeClient, fakeMessage } from './fake-client.js';
export const FEATURE_RAW = Buffer.from('YWJj\r\nZA==');
export function featureClient() {
  return fakeClient({
    async list(){return[{path:'INBOX',flags:new Set()},{path:'ServerSent',flags:new Set(['\\Sent']),specialUse:'\\Sent',specialUseSource:'extension'}];},
    async fetchOne(uid,query){
      if(uid!==9)return fakeMessage(uid);
      if(query.bodyParts)return{uid,bodyParts:new Map([['2',FEATURE_RAW]])};
      return{...fakeMessage(uid),bodyStructure:{type:'multipart/mixed',childNodes:[{part:'1',type:'text/html'},{part:'2',type:'text/plain',disposition:'attachment',dispositionParameters:{filename:'sample.txt'},encoding:'base64',size:FEATURE_RAW.length}]}};
    },
    async download(uid){return{content:Readable.from([Buffer.from(uid===9?'<p>Safe &amp; HTML</p><script>secret</script>':'Synthetic body')])};},
  });
}
