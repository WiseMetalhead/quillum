# Уведомления о сторонних компонентах

Полные тексты лицензий зависимостей распространяются вместе с соответствующими пакетами и исходным
кодом. Ниже перечислены ресурсы, которые непосредственно включаются в Quillum или используются его
опциональным runtime.

## Noto Sans

Шрифт Noto Sans создан Google и распространяется по SIL Open Font License 1.1.

- источник: <https://fonts.google.com/noto/specimen/Noto+Sans>;
- лицензия: <https://openfontlicense.org/>.

## Наборы иконок

- Solar Icons, 480 Design — Creative Commons Attribution 4.0:
  <https://creativecommons.org/licenses/by/4.0/>;
- отдельные иконки Game-icons.net — Creative Commons Attribution 3.0:
  <https://creativecommons.org/licenses/by/3.0/>;
- дополнительные SVG-наборы поставляются через пакеты Iconify; их авторство и лицензии указаны в
  metadata соответствующих npm-пакетов.

## Словари проверки правописания

- русский словарь получен из `Goudron/ru-spelling-dictionary` и распространяется по MPL-2.0;
- словари английского США и Великобритании получены из SCOWL и распространяются по MIT и BSD;
- русский stemmer сгенерирован проектом Snowball и распространяется по BSD-3-Clause.

Точная версия, происхождение, изменения и SHA-256 каждого включённого ресурса приведены в
[`PROVENANCE.md`](apps/web/src/features/books/spellcheck/vendor/PROVENANCE.md). Полные тексты
лицензий находятся рядом со словарями в каталоге `vendor`.

## faster-whisper и Whisper Small

Quillum использует faster-whisper для опционального локального распознавания речи. faster-whisper,
репозиторий модели `Systran/faster-whisper-small` и исходный OpenAI Whisper распространяются по
MIT License.

- faster-whisper: <https://github.com/SYSTRAN/faster-whisper>;
- модель: <https://huggingface.co/Systran/faster-whisper-small>;
- исходный Whisper: <https://github.com/openai/whisper>.

Модель не включена в основной image: Compose profile загружает закреплённую revision и проверяет
SHA-256 перед запуском transcription worker.

## Copyleft-зависимости runtime

- EbookLib распространяется по AGPL-3.0 и используется для импорта и экспорта EPUB:
  <https://github.com/aerkalov/ebooklib>;
- psycopg и psycopg-binary распространяются по LGPL-3.0 и обеспечивают подключение к PostgreSQL:
  <https://www.psycopg.org/>.

Эти лицензии совместимы с AGPL-3.0-or-later, выбранной для Quillum. Системные компоненты базового
образа Debian сохраняют собственные лицензии и copyright-файлы в `/usr/share/doc`. Точный перечень
пакетов и лицензий каждого опубликованного образа доступен в прикреплённом к GitHub Release SBOM.
