// Deterministic ZIP using only Node standard library; no history or runtime cache.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scanRelease} from './scan-release.mjs';
const files=await scanRelease({runtime:true});
const pkg=JSON.parse(await readFile('package.json','utf8'));
const prefix=`Yandex-mail-Dot-Connector-${pkg.version}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=[];
for(const name of files)entries.push({name:`${prefix}/${name}`,data:await readFile(name)});
entries.push({name:`${prefix}/FILE-SHA256SUMS.txt`,data:Buffer.from(entries.map(({name,data})=>`${hash(data)}  ${name.slice(prefix.length+1)}`).join('\n')+'\n')});
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;};
let offset=0;const local=[],central=[];
// STORE rather than deflate makes bytes reproducible across zlib/OS versions.
for(const{name,data}of entries){const nameBytes=Buffer.from(name);const crc=crc32(data);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0800,6);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(nameBytes.length,26);local.push(h,nameBytes,data);
 const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x0314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0800,8);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(nameBytes.length,28);c.writeUInt32LE((0o100644<<16)>>>0,38);c.writeUInt32LE(offset,42);central.push(c,nameBytes);offset+=h.length+nameBytes.length+data.length;
}
const centralBytes=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,centralBytes,end]);await mkdir('releases',{recursive:true});
const filename=`${prefix}.zip`;await writeFile(`releases/${filename}`,zip);await writeFile('releases/SHA256SUMS.txt',`${hash(zip)}  ${filename}\n`);
console.log(`Created releases/${filename}: ${zip.length} bytes, ${entries.length} files\nSHA-256 ${hash(zip)}`);
