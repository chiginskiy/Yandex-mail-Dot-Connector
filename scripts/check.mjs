import {readdir, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
async function check(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {
  if(['node_modules','dist','releases','.git','.local','.wrangler'].includes(entry.name))continue;
  const name=join(dir,entry.name);
  if(entry.isDirectory())await check(name);
  else if(/\.(?:mjs|js)$/.test(name))execFileSync(process.execPath,['--check',name],{stdio:'inherit'});
}}
await check('.');
for(const name of ['signing.mjs','http.mjs'])if(await readFile(`bridge/src/${name}`,'utf8')!==await readFile(`site/src/${name}`,'utf8'))throw new Error(`Shared protocol module drift: ${name}`);
for(const component of ['.','bridge','site']){
 const pkg=JSON.parse(await readFile(`${component}/package.json`,'utf8'));
 const lock=JSON.parse(await readFile(`${component}/package-lock.json`,'utf8'));
 if(pkg.license!=='Apache-2.0'||pkg.version!==lock.version||pkg.version!==lock.packages[''].version||pkg.name!==lock.name)throw new Error(`Package metadata mismatch: ${component}`);
}
execFileSync(process.execPath,['scripts/scan-release.mjs'],{stdio:'inherit'});
console.log('PASS: syntax, package metadata, shared signing protocol, public source scan');
