// Sites runtime output only. Canonical bridge/OAuth code is a separate package.
import {mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
for (const name of ['site-worker.mjs','mcp.mjs','setup.mjs','d1-stores.mjs','signing.mjs','http.mjs']) {
  await copyFile(`src/${name}`,`dist/server/${name}`);
}
await writeFile('dist/server/index.js',"export {default} from './site-worker.mjs';\n");
