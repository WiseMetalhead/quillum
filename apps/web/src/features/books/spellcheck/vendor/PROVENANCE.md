# Происхождение ресурсов проверки правописания

Эти файлы включаются в web-клиент и не загружаются со сторонних сервисов во время работы.

## Русский словарь

- источник: `Goudron/ru-spelling-dictionary`;
- commit: `43cc600462d8681bc6e92d1afb29874e2902ea9b`;
- дата получения: 2026-07-15;
- лицензия: MPL-2.0, полный текст в `ru/LICENSE`;
- SHA-256 исходных KOI8-R файлов:
  - `ru_RU.aff`: `f868ff4913af498d342fd9423d5a5295720aa2d66d0d9e7a05fc18fa0eb5e236`;
  - `ru_RU.dic`: `d9a6bf85b39baf12763ecb05ee5c570d0f300785308055ef262a905ab04113c8`;
- изменения Quillum: оба файла преобразованы из KOI8-R в UTF-8, директива `SET` изменена на
  `UTF-8`, а русская частотная директива `TRY` восстановлена из предшествующего словаря
  LibreOffice/wooorm для корректных подсказок `nspell`;
- SHA-256 включённых UTF-8 файлов:
  - `index.aff`: `38ce7d4af78e211e9bafe4bf7e3d6a2c420591136cb738ec6648f8fdf6524cd7`;
  - `index.dic`: `3f21544e17974a9f75253e79e7356eb524ba5950907f2cc56d8bf1ef828e03f0`.

## Английский словарь (США)

- источник: `dictionary-en@4.0.0`, Hunspell-словарь на основе SCOWL;
- дата получения: 2026-07-15;
- лицензия: MIT AND BSD, полный текст в `en-us/LICENSE`;
- SHA-256:
  - `index.aff`: `8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b`;
  - `index.dic`: `f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647`.

## Английский словарь (Великобритания)

- источник: `dictionary-en-gb@3.0.0`, Hunspell-словарь на основе SCOWL;
- дата получения: 2026-07-15;
- лицензия: MIT AND BSD, полный текст в `en-gb/LICENSE`;
- SHA-256:
  - `index.aff`: `8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b`;
  - `index.dic`: `869fe17ba4ee4b5401c60a666ee2d6a3dcc237f460b7294435df1cc6a799aa57`.

## Русский stemmer

- источник: Snowball `algorithms/russian.sbl`;
- commit: `04ec96cb06718feb967c538b07b09f777ff71020`;
- generator: Snowball 3.1.1 JavaScript backend;
- дата получения и генерации: 2026-07-15;
- лицензия: BSD-3-Clause, полный текст в `snowball/LICENSE`;
- сгенерированные файлы не изменялись, кроме расположения в репозитории;
- SHA-256:
  - `base-stemmer.js`: `ca7982734b537fa7366d70907363f793bee82ed412794c5cd60f0d62b2629ecc`;
  - `russian-stemmer.js`: `f5cc9429d763bdec49f30e25f1149a17edf0cd858acdea6a4712d182c57a7ba6`.
