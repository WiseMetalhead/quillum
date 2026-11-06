# API Quillum

Backend Quillum на Django. В production он запускается из общего application image отдельными
процессами API, realtime, Celery worker и beat.

Основные команды для обычной разработки из корня репозитория:

```bash
uv --directory apps/api sync --frozen
npm run api:check
npm run api:migrate
```

Проверка состояния доступна по `GET /api/health/`. Параметры production-развёртывания описаны в
[публичной документации](../../docs/public/configuration.md).
