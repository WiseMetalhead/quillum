# Разработка

## Требования

- Node.js 24;
- Python 3.12;
- uv;
- Docker Compose для PostgreSQL и Redis.

Установите зависимости:

```bash
npm ci
cd apps/api
uv sync --frozen
```

Поднимите только development-зависимости, опубликованные исключительно на loopback:

```bash
docker compose -f compose.development.yaml up -d
```

В стандартной development-конфигурации Django используются база `quillum`, пользователь `quillum`
и пароль `quillum`. Это намеренно локальные значения; не используйте их в production и не
добавляйте `.env` в Git.

Запуск API и web-клиента:

```bash
uv --directory apps/api run python manage.py migrate
uv --directory apps/api run python manage.py runserver 127.0.0.1:8000
npm run web:dev
```

Collaboration-сервис при необходимости запускается отдельной командой
`npm run collaboration:dev`; его deployment-переменные перечислены в `.env.example` и
[конфигурации](configuration.md).

## Проверки

Frontend:

```bash
npm --workspace apps/web run build
npm --workspace apps/web run lint
npm --workspace apps/web run test:release
```

Collaboration:

```bash
npm run collaboration:test
```

Backend:

```bash
cd apps/api
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run ruff check .
uv run pytest
```

Frontend-строки добавляются в английский и русский каталоги одновременно. Английский остаётся
source/fallback интерфейса; пользовательский сохранённый контент не переводится автоматически.
