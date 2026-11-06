# Резервное копирование и восстановление

Quillum не шифрует прикладные данные. Храните backups только на зашифрованном носителе с
ограниченным доступом.

## Создание

```bash
./scripts/public/backup.sh
```

Скрипт временно останавливает пишущие application-сервисы, оставляя PostgreSQL доступной для
согласованного `pg_dump`. Архив содержит:

- PostgreSQL custom-format dump;
- media volume;
- `.env.production` и secret-файлы;
- manifest версии и SHA-256 checksums.

Можно указать отдельный каталог:

```bash
./scripts/public/backup.sh /защищённый/путь/quillum-backup
```

После создания проверьте копирование архива на отдельный носитель и периодически выполняйте restore
drill.

## Восстановление

Восстановление предназначено для чистой или специально подготовленной установки и удаляет текущую
схему PostgreSQL и media-файлы целевого Compose project.

```bash
./scripts/public/restore.sh /защищённый/путь/quillum-backup --confirm-empty-target
```

Скрипт проверяет checksums, восстанавливает конфигурацию, PostgreSQL и media, применяет миграции и
запускает runtime. После этого вручную проверьте вход, audit, avatars, illustrations, exports,
WebSocket и фоновые задания.

Caddy certificates не входят в backup: они выпускаются заново. Redis также не считается
долговременным источником данных.
