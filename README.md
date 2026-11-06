# Quillum

Quillum — самостоятельная веб-среда для авторов больших текстов: одиночных произведений, книг и
серий. Она объединяет редактор, версии, комментарии, планирование, заметки, глоссарий, экспорт,
публичное рецензирование и совместную работу.

Проект ориентирован на русскоязычное сообщество, поддерживает русский и английский интерфейс и
распространяется по лицензии [AGPL-3.0-or-later](LICENSE).

## Важные свойства

- собственный сервер и собственная PostgreSQL;
- React/Vite frontend и Django API;
- Redis, Celery и realtime-уведомления;
- совместное редактирование через Yjs/Hocuspocus;
- локальное файловое хранилище и локальная опциональная транскрибация;
- экспорт рукописей и полного архива аккаунта;
- локальные аккаунты, Passkey/TOTP и универсальный OpenID Connect.

Quillum хранит тексты, профильные данные, media и runtime-настройки в открытом виде на уровне
приложения. Шифрование дисков и резервных копий — обязанность владельца сервера.

## Быстрый запуск с автоматическим HTTPS

Требуются Linux-сервер, Docker Engine с Compose v2, публичный домен и открытые порты 80/443.
Официальный образ первого публичного релиза поддерживает `linux/amd64`.

```bash
git clone https://github.com/WiseMetalhead/quillum.git
cd quillum
./scripts/public/init.sh
```

Отредактируйте `.env.production`, заменив `write.example.org` своим доменом, затем запустите:

```bash
./scripts/public/up.sh
./scripts/public/status.sh
```

Первичный пароль администратора хранится только в локальном файле
`.secrets/bootstrap_admin_password`. После первого входа немедленно смените его в настройках
безопасности.

Для сервера с уже настроенным reverse proxy:

```bash
./scripts/public/up.sh --external-proxy
```

Gateway будет доступен только на `127.0.0.1:8080`. Пример обязательных proxy-настроек приведён в
[руководстве по развёртыванию](docs/public/deployment.md).

Локальная сборка вместо загрузки GHCR-образа:

```bash
./scripts/public/up.sh --build
```

Транскрибация Whisper загружается отдельно и требует около 3 ГиБ доступной памяти:

```bash
./scripts/public/up.sh --transcription
```

## Обновление и резервные копии

Перед обновлением обязательно создайте offline-копию:

```bash
./scripts/public/backup.sh
```

Измените `QUILLUM_IMAGE` на новый точный тег, выполните `docker compose pull`, затем снова вызовите
`./scripts/public/up.sh`. Не используйте плавающий `latest` для установок с ценными данными.

Полная процедура восстановления описана в
[руководстве по резервному копированию](docs/public/backup-and-restore.md).

## Документация

- [Развёртывание Docker](docs/public/deployment.md)
- [Конфигурация](docs/public/configuration.md)
- [Резервное копирование и восстановление](docs/public/backup-and-restore.md)
- [Архитектура](docs/public/architecture.md)
- [Разработка и проверки](docs/public/development.md)
- [Модель безопасности](docs/public/security.md)
- [Настройки публичного репозитория](docs/public/repository-settings.md)
- [Участие в проекте](CONTRIBUTING.md)
- [Политика сообщения об уязвимостях](SECURITY.md)
- [История публичных версий](CHANGELOG.md)

## Состояние 1.0.0

`1.0.0` — отправная точка публичной истории. Старые приватные версии и их Git-история не являются
частью публичного проекта и не образуют поддерживаемый upgrade path.

Автор проекта — [@WiseMetalhead](https://github.com/WiseMetalhead). Copyright © @WiseMetalhead и участники Quillum.
