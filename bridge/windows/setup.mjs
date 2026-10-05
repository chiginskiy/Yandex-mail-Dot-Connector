// User-run Windows helper. Does not install packages or read credential contents.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomInt} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {isolatedEnv,configFor,validateConnection,validateWorkerOrigin,parseJson,scopes,revokeUrl} from './setup-lib.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const local=path.join(root,'.local');
const auth=path.join(local,'auth');
const stateFile=path.join(local,'setup-state.json');
const configFile=path.join(local,'wrangler.windows.json');
// npx --package adds its pinned package's .bin directory to PATH.
const cliCandidates=[path.join(root,'node_modules','wrangler','bin','wrangler.js'),...(process.env.PATH??process.env.Path??'').split(path.delimiter).map(dir=>path.resolve(dir,'..','wrangler','bin','wrangler.js'))];
const cli=cliCandidates.find(file=>existsSync(file)) ?? cliCandidates[0];
let env=isolatedEnv(process.env,auth);
let loginStarted=false;
const action=process.argv[2] ?? 'check';
const exists=async file=>{try{await access(file);return true;}catch{return false;}};
const save=async state=>writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
const ask=async question=>{const rl=createInterface({input:process.stdin,output:process.stdout});try{return(await rl.question(question)).trim();}finally{rl.close();}};
async function run(args,{capture=false,allowFailure=false}={}) {
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{cwd:root,env,stdio:capture?['inherit','pipe','pipe']:'inherit',windowsHide:false});
    let stdout='',stderr='';
    if(capture){child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);}
    child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
  if(result.code!==0&&!allowFailure) throw new Error(`Wrangler ${args[0]} не завершён (код ${result.code ?? result.signal}). Дальнейшие изменения остановлены`);
  return result;
}
async function writeConfig(state,vars={}){await writeFile(configFile,JSON.stringify(configFor(state,vars),null,2)+'\n');}
async function prepareDirs(){for(const dir of [local,auth,env.HOME,env.XDG_CONFIG_HOME,env.APPDATA,env.LOCALAPPDATA])await mkdir(dir,{recursive:true});}
async function check() {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22||(major===22&&minor<15))throw new Error('Нужен Node.js 22.15 или новее; рекомендуется Node.js 24');
  if(process.platform==='win32'&&Number(os.release().split('.')[2])<22000)console.log('Windows 10 официально не поддерживается Wrangler. Проверяем CLI и dry-run до входа; успех не гарантирует поддержку всех операций.');
  if(!await exists(cli))throw new Error('Запускайте через: npx.cmd --yes --package=wrangler@4.145.0 node .\\windows\\setup.mjs bootstrap');
  if(!await exists(path.join(root,'dist','bridge-wrapper.js')))throw new Error('В архиве отсутствует готовый dist/bridge-wrapper.js');
  await run(['--version']);
  const checkConfig=path.join(local,'wrangler.check.json');
  await writeFile(checkConfig,JSON.stringify(configFor({workerName:'yandex-readonly-local-check',namespaceIds:['71001','71002']}),null,2));
  await run(['deploy','--config',checkConfig,'--no-bundle','--dry-run','--outdir',path.join(local,'dry-run')]);
  console.log('Локальный dry-run завершён. Cloudflare-вход и публикация не выполнялись этим шагом.');
}
async function login(accountId) {
  console.log('Временный вход: чтение аккаунта/пользователя, управление Workers и D1 во всём аккаунте. Wrangler также сохраняет refresh-доступ (offline_access).');
  console.log('Токены остаются только в .local/auth; не открывайте и не отправляйте эту папку. В конце будет logout и локальная очистка.');
  if((await ask('Чтобы продолжить, введите LOGIN: '))!=='LOGIN')throw new Error('Отменено до входа');
  loginStarted=true;
  await run(['login','--device','--browser=false','--scopes',...scopes]);
  const who=parseJson((await run(['whoami','--json'],{capture:true})).stdout);
  const accounts=(who.accounts??[]).filter(item=>/^[a-fA-F0-9]{32}$/.test(item.id??''));
  if(!who.loggedIn||!accounts.length)throw new Error('Wrangler не подтвердил аккаунт');
  let chosen;
  if(accountId){chosen=accounts.find(item=>item.id===accountId);if(!chosen)throw new Error('Этот вход не имеет доступа к аккаунту первого этапа');}
  else if(accounts.length===1)chosen=accounts[0];
  else {
    accounts.forEach((item,index)=>console.log(`${index+1}. ${item.name} (${item.id})`));
    chosen=accounts[Number(await ask('Номер нужного аккаунта: '))-1];
    if(!chosen)throw new Error('Аккаунт не выбран');
  }
  env=isolatedEnv(process.env,auth,chosen.id);
  console.log(`Аккаунт: ${chosen.name} (${chosen.id})`);
  return chosen.id;
}
async function bootstrap() {
  if(await exists(stateFile))throw new Error('Первый этап уже запускался. Не повторяйте создание вслепую: node .\\windows\\setup.mjs status');
  await check();
  const accountId=await login();
  const suffix=randomBytes(6).toString('hex');
  const state={format:1,accountId,workerName:`yandex-mail-readonly-${suffix}`,databaseName:`yandex-mail-${suffix}`,namespaceIds:[String(randomInt(1_000_000,2_000_000_000)),String(randomInt(2_000_000_000,4_000_000_000))],stage:'planned'};
  console.log(`Будут созданы Worker ${state.workerName} и отдельная D1 ${state.databaseName}. Почта останется отключена; тариф и платные опции не меняются. Возможны стандартные квоты/расходы уже выбранного тарифа Cloudflare.`);
  if((await ask('Для создания этих ресурсов введите CREATE: '))!=='CREATE')throw new Error('Отменено до создания');
  await save(state);await writeConfig(state);
  // Fail closed on collisions and unexpected API errors; never overwrite a known Worker.
  const probe=await run(['versions','list','--name',state.workerName,'--json','--config',configFile],{capture:true,allowFailure:true});
  if(probe.code===0||!/(?:code:\s*|\[code:\s*|"code"\s*:\s*)10007\b/i.test(probe.stderr+'\n'+probe.stdout)){ const apiCode=(probe.stderr+'\n'+probe.stdout).match(/(?:code:\s*|\"code\"\s*:\s*)(\d+)/i)?.[1]??'не указан'; throw new Error(`Не удалось подтвердить отсутствие Worker (CLI ${probe.code}, API ${apiCode}). Ничего не перезаписываем`); }
  const before=parseJson((await run(['d1','list','--json'],{capture:true})).stdout);
  if(!Array.isArray(before)||before.some(item=>item.name===state.databaseName))throw new Error('Имя D1 уже существует или список не распознан');
  state.stage='creating-database';await save(state);
  await run(['d1','create',state.databaseName,'--update-config=false']);
  const after=parseJson((await run(['d1','list','--json'],{capture:true})).stdout);
  const db=after.find(item=>item.name===state.databaseName);
  if(!db||!/^[a-fA-F0-9-]{36}$/.test(db.uuid??''))throw new Error('D1 могла быть создана, но ID не подтверждён. Повторное создание остановлено');
  state.databaseId=db.uuid;state.stage='database-created';await save(state);await writeConfig(state);
  await run(['d1','execute','DB','--remote','--file','schema/bridge.sql','--config',configFile,'--yes']);
  state.stage='schema-created';await save(state);
  // Inherit terminal so first-time workers.dev registration prompts remain usable.
  await run(['deploy','--config',configFile,'--no-bundle']);
  state.stage='worker-published';await save(state);
  state.origin=validateWorkerOrigin(await ask('Скопируйте сюда публичный https://<worker>.<subdomain>.workers.dev адрес из результата deploy (без / в конце): '),state.workerName);
  const response=await fetch(state.origin,{signal:AbortSignal.timeout(20_000),redirect:'error'});
  const body=await response.json();
  if(response.status!==503||body?.error?.code!=='connection_not_configured')throw new Error('Публичный Worker ещё не подтвердил закрытое состояние 503. Состояние сохранено; не запускайте bootstrap снова');
  state.stage='bootstrap-complete';await save(state);
  console.log(`Готов адрес callback для Yandex OAuth: ${state.origin}/oauth/callback`);
  console.log('Мост опубликован в закрытом состоянии. Теперь отдельно настройте Yandex-приложение только с mail:imap_ro и закрытый Site; затем заполните windows/connect.json и запустите configure.');
}
async function configure() {
  if(!await exists(stateFile))throw new Error('Сначала нужен bootstrap');
  const state=parseJson(await readFile(stateFile,'utf8'));
  if(state.stage!=='bootstrap-complete'&&state.stage!=='configured')throw new Error('Первый этап не подтверждён; нужна проверка сохранённого состояния');
  // Keep existing public settings in place. Prefer a user's local file if present;
  // neither update archives nor this helper replace either connection file.
  const connectionFile=await exists(path.join(local,'connect.json'))?path.join(local,'connect.json'):path.join(root,'windows','connect.json');
  const vars=validateConnection(parseJson(await readFile(connectionFile,'utf8')),state);
  await check();
  console.log(`Обновление ${state.workerName}: закрепление одного владельца, публичного ключа Site и Yandex Client ID. Разрешение Яндекса и сохранение почтового токена выполняются потом отдельно через Site.`);
  console.log(`Папки, разрешённые после обновления: ${vars.ALLOWED_MAILBOXES}. Значение SENT_MAILBOX, если задано, применяется только как точный путь; скрипт не угадывает название папки.`);
  if((await ask('Чтобы применить эти публичные настройки, введите CONFIGURE: '))!=='CONFIGURE')throw new Error('Отменено до входа');
  await login(state.accountId);await writeConfig(state,vars);
  await run(['deploy','--config',configFile,'--no-bundle']);
  state.stage='configured';await save(state);
  console.log('Настройки опубликованы. Существующий почтовый OAuth-доступ и D1 сохранены. Если почта ещё не авторизована или срок доступа истёк, нужен пользовательский OAuth-вход через закрытый Site.');
}
async function cleanup() {
  if(await exists(cli))try{await run(['logout']);}catch{console.log('Logout не подтверждён. Отзовите Wrangler через Connected Applications.');}
  await rm(auth,{recursive:true,force:true});
  console.log('Изолированная локальная папка входа удалена. Серверный отзыв окончательно проверьте здесь: '+revokeUrl);
}
try {
  if(!['check','bootstrap','configure','status','cleanup'].includes(action))throw new Error('Команды: check, bootstrap, configure, status, cleanup');
  if(action==='status'){
    if(await exists(stateFile))console.log(await readFile(stateFile,'utf8'));else console.log('Первый этап ещё не запускался');
  }else{
    await prepareDirs();
    if(action==='cleanup')await cleanup();
    else if(action==='check')await check();
    else if(action==='bootstrap')await bootstrap();
    else await configure();
  }
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(loginStarted)await cleanup().catch(()=>{console.error('Не удалось завершить очистку. Отзовите Wrangler: '+revokeUrl);process.exitCode=1;});}
