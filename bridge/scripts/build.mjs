// Only the production wrapper enters the distributable bundle. Never deploys.
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'yandex-build-'));
try {
  await rm('dist', {recursive:true,force:true});
  await mkdir('dist', {recursive:true});
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir','dist','--metafile','dist/build-meta.json'], {stdio:'inherit', env:{...process.env, XDG_CONFIG_HOME:join(temp,'config'), WRANGLER_LOG_PATH:join(temp,'build.log'), WRANGLER_SEND_METRICS:'false'}});
  const meta=JSON.parse(await readFile('dist/build-meta.json','utf8'));
  if(Object.keys(meta.inputs).some(name=>/(?:^|\/)test\//.test(name)))throw new Error('Synthetic test input in production bundle');
  const file='dist/bridge-wrapper.js';
  const bundle=(await readFile(file,'utf8')).replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm,'');
  await writeFile(file,bundle);
  await rm(file+'.map',{force:true});
  await rm('dist/README.md',{force:true});
} finally {await rm(temp,{recursive:true,force:true});}
