// Recover a missing URL after an interrupted bootstrap. No login or deployment.
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateWorkerOrigin} from './setup-lib.mjs';
export async function recover({origin,cwd=process.cwd(),fetchImpl=fetch}={}) {
  const file=path.join(cwd,'.local','setup-state.json');
  const original=await readFile(file,'utf8');
  const state=JSON.parse(original);
  if(state.format!==1||!/^[a-f0-9]{32}$/i.test(state.accountId??'')||!/^yandex-mail-readonly-[a-z0-9-]+$/.test(state.workerName??'')||!/^yandex-mail-[a-z0-9-]+$/.test(state.databaseName??'')||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(state.databaseId??'')||!['worker-published','bootstrap-complete'].includes(state.stage))throw new Error('STOP: saved setup does not match this recovery. Nothing changed.');
  origin=validateWorkerOrigin(origin,state.workerName);
  if(state.origin&&state.origin!==origin)throw new Error('STOP: saved Worker URL differs. Nothing changed.');
  const response=await fetchImpl(origin,{signal:AbortSignal.timeout(20_000),redirect:'error'});
  if(response.status!==503||(await response.json())?.error?.code!=='connection_not_configured')throw new Error('STOP: expected closed Worker response was not confirmed. Nothing changed.');
  if(await readFile(file,'utf8')!==original)throw new Error('STOP: setup state changed during the check. Nothing changed.');
  if(state.stage==='bootstrap-complete'&&state.origin===origin)return {callback:origin+'/oauth/callback',alreadyComplete:true};
  const suffix=randomUUID();
  const backup=file+'.before-url-recovery-'+suffix+'.json';
  const temporary=file+'.recovery-'+suffix+'.tmp';
  await writeFile(backup,original,{flag:'wx'});
  try {
    await writeFile(temporary,JSON.stringify({...state,origin,stage:'bootstrap-complete'},null,2)+'\n',{flag:'wx'});
    await rename(temporary,file);
  }catch(error){await unlink(temporary).catch(()=>{});throw error;}
  return {callback:origin+'/oauth/callback',alreadyComplete:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await recover({origin:process.argv[2]});console.log('OK: bootstrap-complete');console.log('Yandex callback: '+result.callback);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
