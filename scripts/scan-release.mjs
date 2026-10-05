// Defense in depth, not proof of absence. Review the exact staged files too.
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseFiles} from './release-files.mjs';
export async function scanRelease({root='.',runtime=false,partial=false}={}){
 const files=await releaseFiles({root,runtime,partial}); const findings=[];
 const patterns=[
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Yandex token',/\b(?:y0_[A-Za-z0-9_-]{30,}|AQAAAA[A-Za-z0-9_-]{30,})\b/],
  ['cloud key',/\bAKIA[A-Z0-9]{16}\b/],
  ['JWT credential',/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['private filesystem path',/\/(?:Users|home|workspace)\/[A-Za-z0-9_.-]+\//],
 ];
 for(const name of files){const body=await readFile(join(root,name),'utf8');for(const[label,re]of patterns)if(re.test(body))findings.push(`${name}: ${label}`);
  for(const match of body.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi))if(!/\.test\.workers\.dev$/.test(match[0]))findings.push(`${name}: non-synthetic Worker endpoint`);
  // Email in upstream license notices/bundled upstream libraries is public attribution.
  if(!['THIRD_PARTY_NOTICES.md','bridge/dist/bridge-wrapper.js'].includes(name))for(const match of body.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi))if(!/\.(?:invalid|example|test)$/.test(match[0])&&!/^actions\//.test(match[0]))findings.push(`${name}: non-synthetic email`);
 }
 if(findings.length)throw new Error('Release scan failed:\n'+[...new Set(findings)].join('\n'));
 return files;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 const files=await scanRelease({runtime:process.argv.includes('--runtime')});
 console.log(`PASS: scanned ${files.length} allowlisted files; no configured secret or personal endpoint patterns`);
}
