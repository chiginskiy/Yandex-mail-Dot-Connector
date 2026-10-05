import {readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
export const rootFiles=['.gitattributes','.gitignore','.nvmrc','package.json','package-lock.json','README.md','README.en.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md'];
export const trees=['.github','docs','examples','scripts','test','bridge/src','bridge/scripts','bridge/test','bridge/windows','bridge/schema','site/src','site/scripts','site/test','site/schema','site/db','site/drizzle'];
export const componentFiles=['bridge/package.json','bridge/package-lock.json','bridge/README.md','bridge/wrangler.jsonc','bridge/wrangler.deploy.example.jsonc','site/package.json','site/package-lock.json','site/README.md','site/drizzle.config.ts','site/.env.example','site/wrangler.site.example.jsonc','site/hosting.example.json'];
export const runtimeFiles=['bridge/dist/bridge-wrapper.js',...['index.js','site-worker.mjs','mcp.mjs','setup.mjs','d1-stores.mjs','signing.mjs','http.mjs'].map(f=>`site/dist/server/${f}`)];
export const forbiddenPath=path=>/(?:^|\/)(?:\.git|\.local|\.wrangler|node_modules|attachments|mail|logs)(?:\/|$)/i.test(path)||/(?:^|\/)(?:connect\.json|wrangler\.deploy\.jsonc|hosting\.json|\.env(?!\.example$)|\.dev\.vars)/i.test(path)||/\.(?:map|log|eml|mbox|sqlite(?:3)?|db|pem|key)$/i.test(path);
export async function releaseFiles({root='.',runtime=false,partial=false}={}){
 const result=[];
 async function file(name,required=true){let stat;try{stat=await lstat(join(root,name));}catch(e){if(e.code==='ENOENT'&&(!required||partial))return;throw e;}if(stat.isSymbolicLink())throw new Error(`Symlink forbidden in release: ${name}`);if(forbiddenPath(name))throw new Error(`Private/generated path forbidden: ${name}`);if(stat.isDirectory()){for(const child of (await readdir(join(root,name))).sort()){if(['.wrangler','node_modules','coverage'].includes(child))continue;await file(`${name}/${child}`);}}else if(stat.isFile())result.push(name);else throw new Error(`Nonregular file: ${name}`);}
 for(const name of [...rootFiles,...componentFiles])await file(name);
 for(const name of trees)await file(name,false);
 if(runtime)for(const name of runtimeFiles)await file(name);
 return result.sort();
}
