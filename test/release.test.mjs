import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanRelease} from '../scripts/scan-release.mjs';
import {releaseFiles} from '../scripts/release-files.mjs';
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'public-scan-'));try{await mkdir(join(root,'bridge/src'),{recursive:true});await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('release source scan rejects credential-shaped content without printing values',()=>fixture(async root=>{await writeFile(join(root,'bridge/src/probe.js'),"const token='"+'ghp_'+'A'.repeat(40)+"';");await assert.rejects(scanRelease({root,partial:true}),e=>e.message.includes('GitHub token')&&!e.message.includes('A'.repeat(40)));}));
test('release allowlist refuses private configuration inside included trees',()=>fixture(async root=>{await writeFile(join(root,'bridge/src/connect.json'),'{}');await assert.rejects(releaseFiles({root,partial:true}),/Private\/generated/);}));
test('release excludes node_modules and unlisted runtime files',()=>fixture(async root=>{await mkdir(join(root,'bridge/node_modules'),{recursive:true});await writeFile(join(root,'bridge/node_modules/private.js'),'not included');await writeFile(join(root,'bridge/src/good.js'),'export const sample = true;');assert.deepEqual(await scanRelease({root,partial:true}),['bridge/src/good.js']);}));
test('release refuses symlinked source instead of following it',{skip:process.platform==='win32'?'Creating symlinks requires Windows privilege':false},()=>fixture(async root=>{await writeFile(join(root,'outside.js'),'export const data = true;');await symlink(join(root,'outside.js'),join(root,'bridge/src/link.js'));await assert.rejects(releaseFiles({root,partial:true}),/Symlink/);}));
