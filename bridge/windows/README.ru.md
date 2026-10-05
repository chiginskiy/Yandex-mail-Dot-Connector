# Windows установка в два этапа

[Полная инструкция](../../docs/installation.ru.md) · [English guide](../../docs/installation.en.md) · [Диагностика](../../docs/troubleshooting.md)

Помощник работает с вашим Cloudflare-аккаунтом. Он сначала создаёт закрытый bridge, затем применяет публичные настройки уже созданного bridge. Yandex OAuth и приватный Site настраиваются отдельно. Ничего не публикуется при распаковке архива.

## До запуска

- Убедитесь, что вам доступны приватные owner-only Sites, D1 и provisioned plugin OAuth. **Публичный raw Worker не заменяет Site:** заголовки владельца в нём можно подделать
- Установите Node.js 24 LTS из официального источника; минимум проекта 22.15.0
- Используйте Windows 11. Windows 10 официально не поддерживается Wrangler; успешный `--version` не доказывает поддержку deploy
- Распакуйте пакет в обычную папку пользователя. Не запускайте внутри ZIP, не меняйте ExecutionPolicy и не открывайте PowerShell от администратора без отдельной причины
- Откройте PowerShell в **`bridge`**, где рядом лежат `windows`, `dist`, `package.json`
- Проверьте, что готовый `dist/bridge-wrapper.js` есть. В Git checkout/GitHub source ZIP его нужно сначала собрать

Для исходников, из `bridge`:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run build
```

Подготовленный release ZIP уже содержит свежий bundle. Для него полная установка зависимостей не обязательна: `npx.cmd` получает закреплённый Wrangler из npm или использует локальную копию. Действующие тарифы/квоты Cloudflare и Sites принадлежат вам; помощник не обещает бесплатную работу при любой нагрузке.

## 1. Локальная проверка

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs check
```

Ожидаемый результат: CLI и `--no-bundle --dry-run` прошли; вход и публикация не выполнялись. При ошибке остановитесь до входа и проверьте Node, ОС, распаковку и bundle.

## 2. Первый этап bootstrap

Если bridge уже установлен, используйте раздел обновления ниже. Не повторяйте bootstrap для действующих ресурсов.

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs bootstrap
```

1. После dry-run помощник объяснит временные права. Введите `LOGIN`, только если согласны, и подтвердите device-code вход на официальной странице Cloudflare. Пароль вводится только там; токен не нужен в терминале или чате
2. Проверьте выбранный аккаунт и новые имена Worker/D1. Введите `CREATE` для создания именно этих ресурсов
3. При первом Worker Cloudflare может предложить собственный поддомен `workers.dev`. Он не требует покупки домена. При неожиданном платном предложении или новых правах остановитесь
4. После deploy скопируйте из вывода точный публичный Worker origin `https://…workers.dev`, без `/` в конце. Это не секрет, но публично делиться адресом личной установки незачем
5. Дождитесь проверки закрытого HTTP 503 и вывода callback `/oauth/callback`

Ожидаемый checkpoint: `bootstrap-complete`, Worker отвечает `connection_not_configured`, создана отдельная D1 и лимиты. Site, Yandex Client ID и почтовый доступ ещё не подключены. Состояние сохранено в `.local/setup-state.json`.

## 3. Site и Yandex app

По [полной инструкции](../../docs/installation.ru.md):

1. Создайте своё Yandex OAuth web-приложение с точным callback и единственным правом `mail:imap_ro`. Нужен публичный Client ID, не Client Secret и не токен
2. Создайте свой приватный Site с отдельной D1 и доверенной аутентификацией Sites. Настройте его origin, bridge origin, Site ID и email владельца
3. На приватной странице лично нажмите «Создать ключ связи». Приватный ключ останется в Site D1; страница покажет публичный JWK и owner ID
4. Закрепите owner ID в Site и подготовьте только публичные значения для bridge

Создание ключа и выдача почтового доступа являются отдельными действиями с постоянными credentials. Сам запуск помощника их не выполняет.

## 4. Файл подключения и configure

Скопируйте `windows/connect.example.json` в `windows/connect.json` и заполните:

- `YANDEX_OWNER_EMAIL`: точный адрес вашего ящика
- `YANDEX_CLIENT_ID`: публичный Client ID вашего приложения
- `SITE_ID`: ID вашего Site
- `OWNER_SITE_USER_ID`: ID владельца именно этого Site
- `SITE_PUBLIC_KEY_JWK`: JSON-строка публичного Ed25519 JWK без поля `d`
- `SITE_ORIGIN`: точный HTTPS origin приватного Site без пути и завершающего `/`

JWK со страницы является объектом; в connect-файле это строка с экранированными внутренними кавычками. Пример формы значения, **не готовый ключ**:

```json
{"SITE_PUBLIC_KEY_JWK":"{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"REPLACE_WITH_YOUR_PUBLIC_X\"}"}
```

Если существует `.local/connect.json`, помощник прочитает его вместо `windows/connect.json`. Не заменяйте существующий файл новым пустым примером. Реальные локальные настройки не должны попадать в Git или release ZIP.

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs configure
```

Помощник проверит настройки, выполнит dry-run, покажет прежний Worker и разрешённые папки. Затем запросит `CONFIGURE` и отдельный `LOGIN`, проверит тот же аккаунт и обновит Worker. D1 и почтовый OAuth-доступ сохраняются. Yandex-авторизация не выполняется этой командой.

Ожидаемый checkpoint: stage `configured`. Вернитесь на приватный Site, нажмите «Подключить Яндекс Почту», лично подтвердите только чтение на официальной странице Яндекса, подключите provisioned plugin и выполните [пять smoke-проверок](../../docs/installation.ru.md#7-начальная-smoke-проверка).

## Необязательная папка отправленных

После подключения вызовите `yandex_mail_folders`. Скопируйте точный выбранный серверный `path` в необязательное поле `SENT_MAILBOX` существующего connect-файла. Повторите `configure`; помощник покажет allowlist из `INBOX` и этого пути до публикации. Не угадывайте название или перевод. Если вариантов несколько, сервер не подтвердил Sent или список усечён, сначала выберите папку явно.

Без `SENT_MAILBOX` разрешён только `INBOX`. Чтобы убрать доступ к отправленным, удалите это поле и повторите `configure`. Discovery не создаёт папки и не расширяет права.

## Обновление существующей установки

1. Сохраните приватную копию local state и настроек. Прочитайте changelog и изменения схемы
2. Распакуйте новый релиз отдельно; обновите файлы программы в прежней папке bridge. Сохраните `.local/setup-state.json`, свой `.local/connect.json`/`windows/connect.json`, идентичность Worker/D1, Site, ключи и app
3. При обновлении исходников повторите `npm.cmd ci --ignore-scripts` и `npm.cmd run build`
4. Запустите `configure`, **не bootstrap**
5. Обновите тот же приватный Site штатным способом, сохраняя D1 и ключ
6. Повторите малую smoke-проверку. Действующий grant не надо выдавать заново только ради обновления кода

Если прежний bridge был плоским проектом без внешней папки `bridge`, не теряйте его state при переходе на новую структуру. Сохраните старую папку как корень bridge либо осознанно перенесите local state и connect-файл. Не bootstrap новую копию вслепую.

Откат кода должен использовать известную совместимую пару bridge/Site. Не восстанавливайте старую БД просто ради отката версии и не возвращайте отозванные credentials. У этого первого публичного кандидата нет предыдущего публичного релиза для рекомендуемого downgrade.

## Временный вход и отзыв

Права: `account:read user:read workers_scripts:write d1:write`; Wrangler добавляет `offline_access`. Они действуют на весь аккаунт. Временные credentials лежат в `.local/auth` в формате Wrangler без дополнительного шифрования приложением. Помощник не читает и не печатает их содержимое. В конце он пытается выполнить logout и удаляет эту папку.

После прерывания выполните:

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs cleanup
```

Проверьте [Cloudflare Connected Applications](https://dash.cloudflare.com/profile/access-management/authorization) → соответствующий Wrangler grant → Revoke. Сообщение logout не гарантирует HTTP-успех серверного отзыва. Если grant отсутствует, отзывать нечего; не удаляйте посторонние API tokens.

Для прекращения почтового доступа отдельно отзовите своё приложение в Яндекс ID. Удаление plugin или local state не равно отзыву mail token. Полное удаление Worker/Site/D1 требует отдельного решения; помощник не удаляет эти ресурсы автоматически.

## Если процесс прервался

```powershell
npx.cmd --yes --package=wrangler@4.146.0 node .\windows\setup.mjs status
```

Не удаляйте `.local/setup-state.json` и не повторяйте создание вслепую. Проверьте точные уже созданные ресурсы в своём аккаунте. Если Worker опубликован, а ввод URL прервался до конфигурации, возможен ограниченный recovery:

```powershell
node .\windows\recover-url.mjs https://bridge.example.invalid
```

Замените placeholder адресом из собственного deploy/dashboard. Скрипт проверит соответствие state/имени Worker и ожидаемый закрытый 503, сохранит backup, обнаружит параллельное изменение state. Он не входит, не публикует и не восстанавливает уже configured bridge. Для других стадий сначала нужна проверка состояния.

Перед отправкой диагностики уберите реальные домены, адреса, account/Site/database IDs. Не пересылайте auth-папку, токены, полный callback URL, вложения и непроверенные журналы.

## Что проверено

Код помощника и локальные проверки охвачены синтетическими тестами и Linux dry-run/runtime проверками. **Новая установка на реальном Windows и свежая авторизация в реальных аккаунтах для этого release candidate не выполнялись.** Успех отдельного существующего развёртывания не заменяет проверку нового установщика. Актуальные результаты: [verification](../../docs/verification.md).

## Официальные справки

- [Wrangler и поддерживаемые ОС](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- [Команды login и logout](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Предварительно собранный Worker](https://developers.cloudflare.com/workers/wrangler/bundling/)
- [Отзыв авторизованного приложения](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/#view-and-revoke-authorized-applications)
