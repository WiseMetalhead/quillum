# Модель безопасности

## Что защищает приложение

- Django sessions и CSRF;
- secure/HttpOnly/SameSite cookies в production;
- HSTS и HTTPS-only public origin;
- CSP, frame, referrer и permissions policies;
- password hashing, TOTP и WebAuthn;
- owner-scoped API и приватные media responses;
- ограничение чувствительных auth endpoints;
- отдельные deployment secret-файлы.

## Что обязан защитить оператор

- доступ к Docker host и Compose-файлам;
- PostgreSQL volume, media volume и backups;
- `.secrets` и `.env.production`;
- TLS, DNS и внешний reverse proxy;
- своевременные обновления host OS и контейнеров;
- SMTP/OIDC credentials и доступ к Product Admin.

## Ограничения

Quillum не выполняет application-level encryption текстов и media. Компрометация host, database
или backup раскрывает данные. Используйте инфраструктурное шифрование, отдельные backups, MFA и
минимально необходимые права.

Об уязвимостях сообщайте только через GitHub private vulnerability reporting, как описано в
[SECURITY.md](../../SECURITY.md).
