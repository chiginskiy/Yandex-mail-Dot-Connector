import { createMcpHandler, createSignedBridgeClient, ownerAuthorizer } from './mcp.mjs';
import { createSigningKeyStore } from './d1-stores.mjs';
import { createSetupHandler, configuredBridgeOrigin } from './setup.mjs';
import { signedBridgeRequest } from './signing.mjs';

function setupPage({ bridgeConfigured }) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Яндекс Почта · только чтение</title><style>
  :root{color-scheme:light;font:16px/1.5 system-ui,sans-serif;color:#14213b;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;padding:32px 18px}main{max-width:740px;margin:auto;background:white;padding:clamp(22px,4vw,42px);border:1px solid #dce3ef;border-radius:18px}h1{font-size:1.75rem;line-height:1.2;margin:0 0 12px}h2{font-size:1.1rem;margin:30px 0 8px}p{margin:12px 0}button{font:inherit;font-weight:600;min-height:46px;border:0;border-radius:8px;background:#244cbf;color:white;padding:10px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}button:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid #efad36;outline-offset:3px}textarea{width:100%;min-height:240px;font:14px/1.4 ui-monospace,monospace;border:1px solid #abb9cf;border-radius:8px;padding:12px;resize:vertical;margin-top:12px}small{display:block;font-size:14px;color:#4b5e7b;margin-top:8px}#status{padding:12px 0;color:#33466a}a{color:#1741ac}
  </style></head><body><main><h1>Яндекс Почта: только чтение</h1><p>Это закрытая страница настройки. Плагин ищет и читает письма в разрешённых папках. HTML-письма преобразуются в безопасный текст без загрузки картинок и другого внешнего содержимого. Можно получить выбранное вложение размером до 20 МиБ. Отправка, удаление и изменение флагов не поддерживаются.</p>
  <h2>Папки и вложения</h2><p>Папка «Отправленные» подключается по точному имени, которое вернул почтовый сервер. Поиск папок показывает названия и доступность, но сам не расширяет доступ. Вложения читаются только по отдельному запросу и передаются приватно по частям; крупный файл может потребовать больше времени.</p><small>Письма и файлы могут содержать недостоверные сведения. Содержимое HTML не выполняется, вложения автоматически не запускаются. Новые возможности используют существующее подключение: пересоздавать ключ или повторно выдавать разрешение Яндекса не нужно, пока доступ действителен.</small>
  <h2>1. Защищённая связь</h2><p>Создайте постоянный ключ для связи этого плагина с вашим мостом Cloudflare. Приватная часть останется на сервере этой страницы. В Cloudflare добавляется только публичная часть ниже.</p><button id="initialize">Создать ключ связи</button><small>Этот шаг создаёт постоянные учётные данные только для вашего подключения</small><textarea id="public-key" readonly aria-label="Публичные настройки для Cloudflare" hidden></textarea>
  <h2>2. Разрешение Яндекса</h2><p>Когда публичные настройки добавлены в Cloudflare, откройте страницу Яндекса и разрешите только чтение почты. Пароли и токены не нужно вставлять сюда или в чат.</p>${bridgeConfigured ? '' : '<p id="configuration-notice">Cloudflare ещё не настроен. Сейчас можно создать ключ связи. Подключение Яндекса станет доступно после настройки Cloudflare.</p>'}<button id="authorize"${bridgeConfigured ? '' : ' disabled'}>Подключить Яндекс Почту</button><p id="status" role="status" aria-live="polite"></p><small>Токен почты хранится в вашем Cloudflare. После истечения его срока потребуется подключиться заново. Доступ можно отозвать в настройках Яндекс ID.</small></main>
  <script nonce="${nonce}">
  const status = document.querySelector('#status');
  async function action(path, confirm) {
    const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm})});
    const result = await response.json().catch(() => ({message: 'Ошибка сервера HTTP ' + response.status}));
    if (!response.ok) throw new Error(result.error==='configuration_required'?'Cloudflare ещё не настроен. Ключ связи можно создать сейчас; подключение Яндекса станет доступно после настройки.':(result.message || 'Не удалось завершить шаг. Проверьте настройки подключения.'));
    return result;
  }
  function showPublic(data) {
    if (!data.publicKey) return;
    const box = document.querySelector('#public-key');box.hidden=false;
    box.value=JSON.stringify({SITE_ID:data.siteId,OWNER_SITE_USER_ID:data.ownerId,SITE_PUBLIC_KEY_JWK:data.publicKey},null,2);
    document.querySelector('#initialize').textContent='Показать существующий ключ';
  }
  document.querySelector('#initialize').addEventListener('click', async event => {
    event.target.disabled=true;status.textContent='';
    try {showPublic(await action('/api/connection/initialize','create_private_signing_key'));status.textContent='Публичные настройки готовы. Приватный ключ не покидал сервер.';}
    catch(error){status.textContent=error.message;}finally{event.target.disabled=false;}
  });
  document.querySelector('#authorize').addEventListener('click', async event => {
    event.target.disabled=true;status.textContent='';
    try {const result=await action('/api/connection/authorize','connect_yandex_mail_readonly');window.location.assign(result.authorizationUrl);}
    catch(error){status.textContent=error.message;event.target.disabled=false;}
  });
  fetch('/api/connection/public-key').then(r=>r.ok?r.json():null).then(data=>{if(data)showPublic(data);}).catch(()=>{});
  if(new URL(location.href).searchParams.get('connection')==='authorized'){status.textContent='Яндекс подтвердил доступ. Теперь можно проверить чтение через приватный плагин.';history.replaceState(null,'','/');}
  </script></body></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  }});
}

// This entrypoint is ONLY for a private Sites deployment. Do not deploy it as a
// publicly reachable raw Worker, because Sites supplies the trusted identity.
export function createSiteWorker({ keyStoreFor = env => createSigningKeyStore(env.DB), fetchImpl = fetch } = {}) {
  return { async fetch(request, env) {
    const securityHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (!env.SITE_ORIGIN || url.origin !== env.SITE_ORIGIN) return new Response('Invalid origin', { status: 403, headers: securityHeaders });
      if (url.pathname === '/favicon.svg' && request.method === 'GET') return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#244cbf"/><rect x="12" y="19" width="40" height="29" rx="4" fill="none" stroke="white" stroke-width="4"/><path d="m14 22 18 14 18-14" fill="none" stroke="white" stroke-width="4" stroke-linejoin="round"/></svg>', { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
      const authorizeOwner = ownerAuthorizer({ ownerUserId: env.OWNER_SITE_USER_ID, ownerEmail: env.OWNER_CHATGPT_EMAIL });
      if (url.pathname === '/' && request.method === 'GET') {
        if (!authorizeOwner(request)) return new Response('Owner authentication required', { status: 403, headers: securityHeaders });
        return setupPage({ bridgeConfigured: Boolean(configuredBridgeOrigin(env.BRIDGE_ORIGIN)) });
      }
      const keyStore = keyStoreFor(env);
      if (url.pathname === '/mcp') {
        const bridgeCall = async (...args) => {
          if (!configuredBridgeOrigin(env.BRIDGE_ORIGIN)) { const error = new Error('Cloudflare setup required'); error.code = 'configuration_required'; throw error; }
          return createSignedBridgeClient({ origin: env.BRIDGE_ORIGIN, siteId: env.SITE_ID, getSigningKey: owner => keyStore.signingKey(owner), signRequest: signedBridgeRequest, fetchImpl })(...args);
        };
        return await createMcpHandler({ authorizeOwner, bridgeCall })(request);
      }
      if (url.pathname.startsWith('/api/connection/')) return await createSetupHandler({ authorizeOwner, keyStore, siteId: env.SITE_ID, bridgeOrigin: env.BRIDGE_ORIGIN, fetchImpl })(request);
      return new Response('Not found', { status: 404, headers: securityHeaders });
    } catch {
      // No stack or error reflection: errors may include config or provider data.
      return Response.json({error:'site_setup',message:'Ошибка соединения: site_setup'}, { status: 503, headers: securityHeaders });
    }
  }};
}
export default createSiteWorker();
