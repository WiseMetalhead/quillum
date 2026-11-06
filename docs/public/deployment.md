# Развёртывание Docker

## Требования

- Linux `amd64`;
- Docker Engine и Compose v2;
- минимум 2 ГиБ RAM без транскрибации, 4 ГиБ рекомендуется;
- публичный DNS-адрес и порты 80/443 для варианта с Caddy;
- зашифрованный диск или иной инфраструктурный контроль для PostgreSQL, media и backups.

## Caddy и автоматический HTTPS

```bash
./scripts/public/init.sh
```

Задайте в `.env.production` один и тот же реальный домен в `QUILLUM_DOMAIN` и
`QUILLUM_PUBLIC_ORIGIN=https://…`, затем выполните:

```bash
./scripts/public/up.sh
./scripts/public/status.sh
```

Compose не публикует PostgreSQL, Redis или внутренние application-порты. Caddy — единственная
точка входа снаружи.

## Существующий reverse proxy

```bash
./scripts/public/up.sh --external-proxy
```

Gateway слушает `127.0.0.1:8080`. Внешний proxy обязан:

- завершать TLS;
- передавать исходный `Host`;
- устанавливать `X-Forwarded-Proto: https`;
- передавать нормализованный `X-Forwarded-For`;
- поддерживать WebSocket upgrade для `/ws/` и `/collaboration/ws`;
- не публиковать внутренние Docker-сети.

Пример для Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

## Локальная сборка

```bash
./scripts/public/up.sh --build
```

Собирается тот же application image. Build context исключает `.env`, secret-файлы, локальные
dependencies и operator-specific материалы.

## Транскрибация

```bash
./scripts/public/up.sh --transcription
```

Profile загружает строго закреплённую Whisper Small модель, проверяет SHA-256 и запускает отдельный
FIFO worker. После загрузки включите функцию в Product Admin. Runtime inference не скачивает модель
и не отправляет аудио внешнему сервису.

## Обновление

1. Создайте backup.
2. Укажите новый точный `QUILLUM_IMAGE` в `.env.production`.
3. Выполните `docker compose … pull` или повторно вызовите `up.sh`.
4. Дождитесь успешного одноразового контейнера `migrate`.
5. Проверьте `status.sh`, вход, WebSocket и фоновые задания.

Не откатывайте образ поверх уже применённых необратимых миграций без восстановления полного backup.
