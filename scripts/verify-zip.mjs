import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scanRelease} from './scan-release.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));
const name=`Yandex-mail-Dot-Connector-${pkg.version}.zip`,prefix=name.slice(0,-4)+'/';
const bytes=await readFile(`releases/${name}`);const hash=x=>createHash('sha256').update(x).digest('hex');
const expected=(await readFile('releases/SHA256SUMS.txt','utf8')).trim();
if(expected!==`${hash(bytes)}  ${name}`)throw new Error('Archive SHA-256 mismatch');
const entries=new Map();let offset=0;
while(bytes.readUInt32LE(offset)===0x04034b50){
 if(bytes.readUInt16LE(offset+8)!==0)throw new Error('Expected deterministic STORE archive');
 const size=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),filename=bytes.subarray(offset+30,offset+30+n).toString('utf8');
 if(!filename.startsWith(prefix)||filename.includes('..')||filename.includes('\\')||entries.has(filename))throw new Error('Unsafe/duplicate ZIP name');
 const start=offset+30+n+extra;entries.set(filename,bytes.subarray(start,start+size));offset=start+size;
}
if(bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('Missing central directory');
const files=await scanRelease({runtime:true});
if(entries.size!==files.length+1)throw new Error('Archive file count mismatch');
for(const f of files)if(!entries.get(prefix+f)?.equals(await readFile(f)))throw new Error(`Archive/source mismatch: ${f}`);
const manifest=entries.get(prefix+'FILE-SHA256SUMS.txt')?.toString('utf8');
const expectedManifest=files.map(f=>`${hash(entries.get(prefix+f))}  ${f}`).join('\n')+'\n';
if(manifest!==expectedManifest)throw new Error('Archive per-file manifest mismatch');
console.log(`PASS: ZIP SHA-256, ${entries.size} unique safe paths, exact source/runtime byte equality, per-file hashes and public scan`);
