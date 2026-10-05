import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const entries=[];
for(const component of ['bridge','site']){
 const lock=JSON.parse(await readFile(`${component}/package-lock.json`,'utf8'));
 for(const [key,value]of Object.entries(lock.packages)){
  if(!key||value.dev||value.optional&&value.os)continue;
  const dir=join(component,key);const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  const name=`${pkg.name} ${pkg.version}`;
  if(entries.some(e=>e.name===name))continue;
  const candidates=(await readdir(dir)).filter(f=>/^licen[cs]e(?:\.|$)/i.test(f)).sort();
  const selected=pkg.name==='@zone-eu/mailsplit'?['LICENSE.MIT']:candidates;
  let texts=[];for(const f of selected)texts.push(await readFile(join(dir,f),'utf8'));
  let note='';
  if(pkg.name==='@zone-eu/mailsplit')note='Upstream offers MIT OR EUPL-1.1+. This distribution uses the MIT option.\n\n';
  if(!texts.length&&pkg.name==='drizzle-orm'&&pkg.license==='Apache-2.0'){
   note=`By the Drizzle Team. The npm package declares Apache-2.0 and omits a LICENSE file. The upstream license is https://github.com/drizzle-team/drizzle-orm/blob/${pkg.version}/LICENSE; the identical standard Apache-2.0 terms are reproduced below. No dependency code is modified.\n\n`;
   texts=[await readFile('LICENSE','utf8')];
  }
  if(!texts.length)throw new Error(`Missing required upstream license text: ${name}`);
  entries.push({name,text:`## ${name}\n\nLicense: ${pkg.license}\n\n${note}${texts.join('\n\n').trim()}\n`});
 }
}
entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
const output='# Third-party notices\n\nGenerated from installed lockfile-pinned runtime dependencies with `npm run notices`.\nThe bridge release bundles its runtime dependencies; Site runtime modules do not bundle Drizzle. Drizzle supports the included database schema/migration source.\nBuild/test-only tools are installed separately from npm and are not included in the release ZIP. Their licenses remain in their packages.\nUpstream public attribution addresses below are retained as required license notices; they are not connector-owner configuration.\n\n'+entries.map(e=>e.text).join('\n');
await writeFile('THIRD_PARTY_NOTICES.md',output);
console.log(`Generated notices for ${entries.length} runtime packages`);
