# Архитектура

Quillum состоит из React/Vite frontend, Django API, PostgreSQL, Redis, Celery и отдельного Node.js
сервиса совместного редактирования.

Публичный application image неизменяем и запускается несколькими Compose-сервисами:

- Nginx gateway раздаёт frontend и маршрутизирует API/WebSocket;
- Gunicorn обслуживает обычный HTTP API;
- Daphne обслуживает realtime-уведомления;
- Hocuspocus/Yjs обслуживает совместное редактирование;
- Celery worker выполняет фоновые задания;
- Celery beat запускает периодические задания;
- отдельный worker обслуживает транскрибацию при включённом profile.

Gateway блокирует внешний доступ к collaboration internal API. PostgreSQL и Redis доступны только
application-контейнерам. Все браузерные маршруты используют один публичный origin.

Пользовательские тексты, профиль, настройки, audit payload, media и browser offline copies хранятся
как plaintext. Пароли используют Django password hashing; session signing, CSRF, TOTP, WebAuthn и
одноразовые коды сохраняют свои криптографические границы.
