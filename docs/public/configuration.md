# Конфигурация

## Профиль развёртывания

Production Compose всегда задаёт `QUILLUM_ENVIRONMENT=production`. Публичный HTTPS origin из
`QUILLUM_PUBLIC_ORIGIN` определяет allowed host, CORS/CSRF origins, secure cookies, HSTS и WebAuthn
RP ID.

Значение должно быть origin без credentials, path, query и fragment.

## Секреты

`scripts/public/init.sh` создаёт локальные файлы:

- `.secrets/django_secret_key`;
- `.secrets/collaboration_internal_secret`;
- `.secrets/postgres_password`;
- `.secrets/bootstrap_admin_password`;
- `.secrets/oidc_client_secret` (пустой до настройки провайдера).

Они монтируются через Compose secrets и не должны попадать в Git, образ или логи. Само приложение
поддерживает прямые переменные окружения с приоритетом над соответствующими `*_FILE`, однако
публичный Compose намеренно передаёт production-секреты только файлами.

Первичный администратор создаётся только один раз и только в пустой базе. Production отказывается
запускаться с пустым паролем или `changeme`.

## OpenID Connect

Основные переменные:

- `QUILLUM_OIDC_ENABLED`;
- `OIDC_DISCOVERY_URL`;
- `OIDC_ISSUER`;
- `OIDC_CLIENT_ID`;
- `OIDC_CLIENT_SECRET` или `OIDC_CLIENT_SECRET_FILE`;
- `OIDC_PROVIDER_NAME`.

Callback URL: `https://ваш-домен/api/auth/oidc/callback/`.

Запишите client secret в `.secrets/oidc_client_secret` и оставьте права файла `0600`. При
`QUILLUM_OIDC_ENABLED=true` запуск блокируется, пока этот файл пуст.

Провайдер должен поддерживать Authorization Code Flow, discovery metadata и стандартные claims
`iss`, `sub`, `preferred_username`/`username`, `email`, `email_verified`.

## Доверенный proxy

`QUILLUM_TRUSTED_PROXY_IPS` принимает IP-адреса и CIDR через запятую. Доверие разрешает использовать
нормализованный `X-Forwarded-For` для audit и rate limiting. Не добавляйте публичные сети или
произвольный `0.0.0.0/0`.

## Данные

PostgreSQL — источник долговременного структурированного состояния. Media и временные экспорты
находятся в `media_data`. Redis используется как cache, broker и realtime channel layer; он не
заменяет PostgreSQL backup.
