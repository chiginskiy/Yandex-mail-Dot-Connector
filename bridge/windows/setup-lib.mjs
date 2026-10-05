import path from 'node:path';

export const scopes = ['account:read', 'user:read', 'workers_scripts:write', 'd1:write'];
export const revokeUrl = 'https://dash.cloudflare.com/profile/access-management/authorization';
export function isolatedEnv(source, authRoot, accountId) {
  const env = {...source};
  // Do not inherit credentials, endpoint overrides, profiles, or broad API auth.
  for (const key of Object.keys(env)) if (/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(key)) delete env[key];
  Object.assign(env, {
    HOME: path.join(authRoot, 'home'), USERPROFILE: path.join(authRoot, 'home'),
    XDG_CONFIG_HOME: path.join(authRoot, 'xdg'),
    APPDATA: path.join(authRoot, 'appdata'), LOCALAPPDATA: path.join(authRoot, 'localappdata'),
    WRANGLER_LOG_PATH: path.join(authRoot, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_AUTH_USE_KEYRING: 'false', WRANGLER_AUTH_DOMAIN: 'dash.cloudflare.com',
    WRANGLER_AUTH_URL: 'https://dash.cloudflare.com/oauth2/auth',
    WRANGLER_TOKEN_URL: 'https://dash.cloudflare.com/oauth2/token',
    WRANGLER_REVOKE_URL: 'https://dash.cloudflare.com/oauth2/revoke'
  });
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}
export function configFor(state, vars = {}) {
  return {
    name: state.workerName, main: '../dist/bridge-wrapper.js', account_id: state.accountId,
    compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
    workers_dev: true, preview_urls: false, observability: {enabled: false},
    ratelimits: [
      {name:'PERIMETER_LIMITER', namespace_id:state.namespaceIds[0], simple:{limit:120,period:60}},
      {name:'OWNER_LIMITER', namespace_id:state.namespaceIds[1], simple:{limit:30,period:60}}
    ],
    vars: {ALLOWED_MAILBOXES:'["INBOX"]', ...vars},
    ...(state.databaseId ? {d1_databases:[{binding:'DB',database_name:state.databaseName,database_id:state.databaseId}]} : {})
  };
}
export function validateConnection(input, state) {
  const expected = ['YANDEX_OWNER_EMAIL','YANDEX_CLIENT_ID','SITE_ID','OWNER_SITE_USER_ID','SITE_PUBLIC_KEY_JWK','SITE_ORIGIN'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>![...expected,'SENT_MAILBOX'].includes(key))) throw new Error('В connect.json разрешены шесть публичных полей из примера и необязательное SENT_MAILBOX');
  for (const key of expected) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length>2048 || /REPLACE|example\.invalid/.test(input[key])) throw new Error(`Заполните публичное поле ${key}`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.YANDEX_OWNER_EMAIL)) throw new Error('Проверьте адрес почты');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(input.YANDEX_CLIENT_ID)) throw new Error('Проверьте публичный Yandex Client ID');
  const url = new URL(input.SITE_ORIGIN);
  if(url.protocol!=='https:' || url.origin!==input.SITE_ORIGIN || url.username || url.password) throw new Error('SITE_ORIGIN должен быть точным HTTPS origin без пути');
  const jwk = JSON.parse(input.SITE_PUBLIC_KEY_JWK);
  if (jwk.kty!=='OKP'||jwk.crv!=='Ed25519'||jwk.d!==undefined||!/^[A-Za-z0-9_-]{43}$/.test(jwk.x ?? '')) throw new Error('Нужен только публичный Ed25519 JWK без поля d');
  const allowedJwk = new Set(['kty','crv','x','alg','ext','key_ops','use','kid']);
  if(Object.keys(jwk).some(key=>!allowedJwk.has(key))) throw new Error('Неподдерживаемые поля публичного ключа');
  const {SENT_MAILBOX:sentMailbox,...publicFields}=input;
  if(sentMailbox!==undefined&&(typeof sentMailbox!=='string'||!sentMailbox.length||sentMailbox.length>120||/[\u0000-\u001f\u007f]/u.test(sentMailbox)||sentMailbox==='INBOX')) throw new Error('SENT_MAILBOX должен точно совпадать с путём выбранной папки из yandex_mail_folders');
  return {...publicFields, ALLOWED_MAILBOXES:JSON.stringify(sentMailbox===undefined?['INBOX']:['INBOX',sentMailbox]), BRIDGE_ORIGIN: validateWorkerOrigin(state.origin, state.workerName)};
}
export function validateWorkerOrigin(value, name) {
  const url = new URL(value);
  if (url.protocol!=='https:'||url.origin!==value||url.username||url.password||!url.hostname.startsWith(name+'.')||!url.hostname.endsWith('.workers.dev')) throw new Error('Введите точный HTTPS адрес этого Worker из результата deploy, без / в конце');
  return url.origin;
}
export function parseJson(text) { return JSON.parse(text.trim()); }
