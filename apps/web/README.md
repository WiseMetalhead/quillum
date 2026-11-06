# Web-клиент Quillum

Клиентское приложение Quillum на React, TypeScript и Vite. Интерфейс поддерживает русский и
английский языки; новые пользовательские строки должны добавляться в оба каталога одновременно.

Из корня репозитория:

```bash
npm ci
npm run web:dev
npm run web:build
npm run web:lint
npm --workspace apps/web run test:release
```

Production-сборка формирует content-hashed assets и online-first PWA shell. Authenticated API и
приватные media не должны попадать в Service Worker cache.
