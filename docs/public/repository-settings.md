# Настройки публичного репозитория

Часть защитных механизмов GitHub нельзя выразить файлами репозитория. Владелец должен выполнить
этот checklist до публикации `v1.0.0`.

## Безопасность

- включить Dependency Graph, Dependabot alerts и Dependabot security updates;
- включить secret scanning и push protection, включая проверку contributions;
- включить private vulnerability reporting;
- оставить Actions только с минимальными permissions, заданными в каждом workflow;
- сделать GHCR package `ghcr.io/wisemetalhead/quillum` публичным после успешной публикации.

## Защита `main`

- запретить прямой push и удаление ветки;
- требовать pull request и минимум одно одобрение;
- сбрасывать approvals после новых commits;
- требовать resolution всех review conversations;
- требовать успешные frontend, backend, collaboration, Docker, CodeQL, Gitleaks, dependency review
  и Trivy checks;
- требовать актуальную ветку и linear history;
- ограничить bypass владельцем только аварийными случаями.

## Релиз `1.0.0`

1. Убедиться, что публичный `main` содержит единственный initial commit `Quillum 1.0.0`.
2. Дождаться всех required checks и выполнить runtime/browser acceptance.
3. Создать локально подписанный annotated tag `v1.0.0` и отправить только его.
4. Проверить GHCR digest, SBOM и build/SBOM attestations.
5. Сверить `git ls-remote --heads --tags`, чтобы старые refs отсутствовали.

Имена checks следует выбирать из первого успешного запуска Actions: GitHub формирует их из
workflow/job names.
