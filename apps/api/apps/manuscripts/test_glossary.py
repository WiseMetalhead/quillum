import json
import zipfile
from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

from apps.accounts.models import UserMediaAsset
from apps.audit.models import AuditEvent

from .models import (
    DocumentGlossaryAssociation,
    Glossary,
    GlossaryArticle,
    GlossaryArticleAlias,
    GlossaryArticleLink,
    GlossaryAsset,
    GlossaryCategory,
    GlossaryCustomWord,
    Manuscript,
    Series,
)


def export_archive(response):
    data = b"".join(response.streaming_content)
    return zipfile.ZipFile(BytesIO(data))


def create_oneshot(client, title="Story"):
    return client.post(
        "/api/manuscripts/oneshots/",
        {"title": title},
    ).json()["manuscript"]


def create_book(client, title="Book"):
    return client.post(
        "/api/manuscripts/books/",
        {"title": title, "template": "chapters"},
    ).json()["manuscript"]


def glossary_context(client, manuscript_id):
    return client.get(f"/api/manuscripts/{manuscript_id}/glossary/").json()["glossary"]


def create_article(client, manuscript_id, category_id, title="Aelar"):
    return client.post(
        f"/api/manuscripts/{manuscript_id}/glossary/articles/",
        {"title": title, "synopsis": "Private lore", "categoryId": category_id},
    )


def image_upload(name="glossary.png", color="#245b47"):
    output = BytesIO()
    Image.new("RGB", (64, 64), color).save(output, format="PNG")
    return SimpleUploadedFile(name, output.getvalue(), content_type="image/png")


def markdown_upload(content: str, name="article.md"):
    return SimpleUploadedFile(name, content.encode("utf-8"), content_type="text/markdown")


@pytest.mark.django_db
def test_glossary_article_markdown_export_includes_cover_and_used_originals(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="glossary-markdown-export",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(
        client,
        manuscript["id"],
        category["id"],
        title="Лунная башня",
    ).json()["article"]
    target = create_article(
        client,
        manuscript["id"],
        category["id"],
        title="Архив",
    ).json()["article"]
    cover = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/cover/",
        {"cover": image_upload("cover.png", "#172f47")},
    )
    illustration = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload("tower.png", "#c8d3df")},
    ).json()["asset"]
    unused = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload("unused.png", "#aa3300")},
    ).json()["asset"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Скрытая <история>",
                        "marks": [{"type": "bold"}, {"type": "underline"}],
                    },
                    {"type": "hardBreak"},
                    {
                        "type": "text",
                        "text": "Архив",
                        "marks": [
                            {
                                "type": "glossaryLink",
                                "attrs": {"articleId": target["id"]},
                            }
                        ],
                    },
                ],
            },
            {
                "type": "callout",
                "attrs": {"kind": "warning"},
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "Не входить"}],
                    }
                ],
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableHeader",
                                "attrs": {"colspan": 1, "rowspan": 1, "align": "left"},
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [{"type": "text", "text": "Этаж"}],
                                    }
                                ],
                            },
                            {
                                "type": "tableHeader",
                                "attrs": {"colspan": 1, "rowspan": 1, "align": "center"},
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [{"type": "text", "text": "Состояние | доступ"}],
                                    }
                                ],
                            },
                        ],
                    },
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1},
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [{"type": "text", "text": "Первый"}],
                                    }
                                ],
                            },
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1},
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [{"type": "text", "text": "Закрыт"}],
                                    }
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                "type": "illustration",
                "attrs": {
                    "assetId": illustration["id"],
                    "alt": "Башня",
                    "caption": "Ночная башня",
                    "alignment": "right",
                    "displayWidth": 50,
                },
            },
        ],
    }
    saved = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    AuditEvent.objects.all().delete()

    response = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "markdown"}),
        content_type="application/json",
    )

    assert cover.status_code == 200
    assert saved.status_code == 200
    assert response.status_code == 200
    assert response["Cache-Control"] == "private, no-store"
    assert 'filename="glossary-article.zip"' in response["Content-Disposition"]
    assert "%D0%9B%D1%83%D0%BD%D0%BD%D0%B0%D1%8F" in response["Content-Disposition"]
    event = AuditEvent.objects.get(event="manuscript.glossary_article_exported")
    assert event.payload == {
        "manuscriptId": manuscript["id"],
        "articleId": article["id"],
        "format": "markdown",
    }
    assert "Лунная башня" not in str(event.payload)
    with export_archive(response) as archive:
        names = set(archive.namelist())
        markdown = archive.read("Лунная башня.md").decode("utf-8")
        assert "assets/cover.png" in names
        assert f"assets/{illustration['id']}.png" in names
        assert f"assets/{unused['id']}.png" not in names
        assert "# Лунная башня" in markdown
        assert "**<u>Скрытая \\<история\\></u>**" in markdown
        assert "Архив" in markdown
        assert target["id"] not in markdown
        assert "> **WARNING**" in markdown
        assert "| Этаж | Состояние &#124; доступ |" in markdown
        assert "| :--- | :---: |" in markdown
        assert "| Первый | Закрыт |" in markdown
        assert "<table>" not in markdown
        assert "![Башня]" in markdown


@pytest.mark.django_db
def test_glossary_article_html_export_escapes_content_and_preserves_gallery(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="glossary-html-export",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    assets = [
        client.post(
            f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
            {"image": image_upload(f"gallery-{index}.png", color)},
        ).json()["asset"]
        for index, color in enumerate(("#112233", "#445566"))
    ]

    def illustration(asset):
        return {
            "type": "illustration",
            "attrs": {
                "assetId": asset["id"],
                "alt": 'Map "detail"',
                "caption": "Below <ground>",
                "alignment": "center",
                "displayWidth": 75,
            },
        }

    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "attrs": {"textAlign": "center"},
                "content": [
                    {
                        "type": "text",
                        "text": "<script>alert(1)</script>",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {
                                    "href": "https://example.test/lore",
                                    "target": "_blank",
                                    "rel": "noopener noreferrer",
                                    "class": "",
                                    "title": "Lore",
                                },
                            }
                        ],
                    }
                ],
            },
            {
                "type": "illustrationGallery",
                "content": [illustration(asset) for asset in assets],
            },
        ],
    }
    saved = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    response = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "html"}),
        content_type="application/json",
    )

    assert saved.status_code == 200
    assert response.status_code == 200
    with export_archive(response) as archive:
        page = archive.read("Aelar.html").decode("utf-8")
        assert "<script>alert(1)</script>" not in page
        assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
        assert 'href="https://example.test/lore"' in page
        assert '<div class="gallery">' in page
        assert 'alt="Map &quot;detail&quot;"' in page
        assert "Below &lt;ground&gt;" in page
        assert all(f"assets/{asset['id']}.png" in archive.namelist() for asset in assets)


@pytest.mark.django_db
def test_glossary_article_export_validates_scope_format_and_size(
    client,
    django_user_model,
    monkeypatch,
):
    owner = django_user_model.objects.create_user(username="export-owner", password="password")
    stranger = django_user_model.objects.create_user(
        username="export-stranger",
        password="password",
    )
    client.force_login(owner)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    asset = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload()},
    ).json()["asset"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "illustration",
                "attrs": {
                    "assetId": asset["id"],
                    "alt": "",
                    "caption": "",
                    "alignment": "center",
                    "displayWidth": 100,
                },
            }
        ],
    }
    client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    invalid = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "pdf"}),
        content_type="application/json",
    )
    monkeypatch.setattr(
        "apps.manuscripts.glossary_exports.GLOSSARY_EXPORT_MAX_ASSET_BYTES",
        1,
    )
    too_large = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "markdown"}),
        content_type="application/json",
    )
    client.force_login(stranger)
    denied = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "markdown"}),
        content_type="application/json",
    )

    assert invalid.status_code == 400
    assert invalid.json()["error"] == "glossary_export_format_invalid"
    assert too_large.status_code == 413
    assert too_large.json()["error"] == "glossary_export_too_large"
    assert denied.status_code == 404


@pytest.mark.django_db
def test_spellcheck_lexicon_stores_plaintext_deduplicates_and_scopes_words(
    client, django_user_model
):
    owner = django_user_model.objects.create_user(username="spell-owner", password="password")
    stranger = django_user_model.objects.create_user(username="spell-stranger", password="password")
    client.force_login(owner)
    manuscript = create_oneshot(client, "Spell story")
    context = glossary_context(client, manuscript["id"])
    article = create_article(
        client,
        manuscript["id"],
        context["categories"][0]["id"],
        title="Элирия",
    )
    assert article.status_code == 201

    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/words/",
        data=json.dumps({"word": "Альтарион"}),
        content_type="application/json",
    )
    duplicate = client.post(
        f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/words/",
        data=json.dumps({"word": "альтарион"}),
        content_type="application/json",
    )
    lexicon = client.get(f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/")

    assert created.status_code == 201
    assert duplicate.status_code == 200
    assert created.json()["word"]["id"] == duplicate.json()["word"]["id"]
    assert GlossaryCustomWord.objects.count() == 1
    stored = GlossaryCustomWord.objects.values().get()
    assert stored["word"] == "Альтарион"
    assert lexicon.status_code == 200
    assert lexicon.json()["lexicon"]["revision"] == "2"
    assert lexicon.json()["lexicon"]["glossaryTerms"] == ["Элирия"]
    assert lexicon.json()["lexicon"]["customWords"][0]["word"] == "Альтарион"

    client.force_login(stranger)
    denied = client.get(f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/")
    assert denied.status_code == 404


@pytest.mark.django_db
def test_spellcheck_custom_word_validation_and_delete(client, django_user_model):
    user = django_user_model.objects.create_user(username="spell-validation", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client, "Spell validation")
    invalid = client.post(
        f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/words/",
        data=json.dumps({"word": "two words"}),
        content_type="application/json",
    )
    assert invalid.status_code == 400
    assert invalid.json()["error"] == "spellcheck_word_invalid"

    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/words/",
        data=json.dumps({"word": "Анна-Мария"}),
        content_type="application/json",
    )
    word_id = created.json()["word"]["id"]
    deleted = client.delete(
        f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/words/{word_id}/"
    )
    assert deleted.status_code == 200
    assert GlossaryCustomWord.objects.count() == 0


@pytest.mark.django_db
def test_article_aliases_normalize_deduplicate_update_spellcheck_and_audit(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="alias-owner", password="password")
    stranger = django_user_model.objects.create_user(
        username="alias-stranger",
        password="password",
    )
    client.force_login(owner)
    manuscript = create_oneshot(client, "Alias story")
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]
    article = create_article(
        client,
        manuscript["id"],
        category_id,
        title="Филомина де Сиензо",
    ).json()["article"]
    glossary = Glossary.objects.get(manuscript__public_id=manuscript["id"])
    initial_revision = glossary.spellcheck_revision
    AuditEvent.objects.all().delete()

    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/",
        data=json.dumps({"name": "  Фило   de   Cafe\u0301  "}),
        content_type="application/json",
    )
    alias = created.json()["alias"]
    duplicate = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/",
        data=json.dumps({"name": "фило DE CAFÉ"}),
        content_type="application/json",
    )
    updated = client.patch(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/{alias['id']}/",
        data=json.dumps({"name": "Фило"}),
        content_type="application/json",
    )
    detail = client.get(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/"
    )
    lexicon = client.get(f"/api/manuscripts/{manuscript['id']}/spellcheck-lexicon/")

    assert created.status_code == 201
    assert created.json()["alias"]["name"] == "Фило de Café"
    assert duplicate.status_code == 409
    assert duplicate.json()["error"] == "alias_duplicate"
    assert updated.status_code == 200
    assert detail.json()["article"]["aliases"][0]["name"] == "Фило"
    assert detail.json()["article"]["mediaCount"] == 0
    assert lexicon.json()["lexicon"]["glossaryTerms"] == [
        "Филомина де Сиензо",
        "Фило",
    ]
    glossary.refresh_from_db()
    assert glossary.spellcheck_revision == initial_revision + 2
    assert GlossaryArticleAlias.objects.get().normalized_name == "фило"
    alias_events = list(AuditEvent.objects.order_by("created_at"))
    assert [event.payload["aliasAction"] for event in alias_events] == [
        "added",
        "updated",
    ]
    assert all(event.payload["changedFields"] == ["aliases"] for event in alias_events)
    assert all("name" not in event.payload for event in alias_events)
    assert all("Фило" not in str(event.payload) for event in alias_events)

    client.force_login(stranger)
    denied = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/{alias['id']}/"
    )
    assert denied.status_code == 404

    client.force_login(owner)
    deleted = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/{alias['id']}/"
    )
    missing = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/{alias['id']}/"
    )
    assert deleted.status_code == 200
    assert missing.status_code == 404
    assert missing.json()["error"] == "alias_not_found"
    assert not GlossaryArticleAlias.objects.exists()
    glossary.refresh_from_db()
    assert glossary.spellcheck_revision == initial_revision + 3
    assert list(
        AuditEvent.objects.order_by("created_at").values_list(
            "payload__aliasAction",
            flat=True,
        )
    ) == ["added", "updated", "deleted"]


@pytest.mark.django_db
def test_article_alias_rejects_control_characters_and_cascades_with_article(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="alias-validation", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]
    article = create_article(client, manuscript["id"], category_id).json()["article"]

    invalid_responses = [
        client.post(
            f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/",
            data=json.dumps({"name": name}),
            content_type="application/json",
        )
        for name in ("First\nSecond", "First\u2028Second")
    ]
    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/aliases/",
        data=json.dumps({"name": "Aelar the Bright"}),
        content_type="application/json",
    )
    deleted = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/"
    )

    assert all(response.status_code == 400 for response in invalid_responses)
    assert all(response.json()["error"] == "alias_invalid" for response in invalid_responses)
    assert created.status_code == 201
    assert deleted.status_code == 200
    assert not GlossaryArticleAlias.objects.exists()


@pytest.mark.django_db
def test_glossary_creation_seeds_categories_and_stores_plaintext_articles(
    client, django_user_model
):
    user = django_user_model.objects.create_user(username="glossary-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)

    context = glossary_context(client, manuscript["id"])
    response = create_article(
        client,
        manuscript["id"],
        context["categories"][0]["id"],
    )

    assert response.status_code == 201
    assert [item["systemKey"] for item in context["categories"]] == [
        "characters",
        "places",
        "races",
        "organizations",
        "items",
        "flora",
        "fauna",
    ]
    stored = GlossaryArticle.objects.values().get()
    assert stored["title"] == "Aelar"
    assert stored["synopsis"] == "Private lore"
    assert stored["content"]["type"] == "doc"


@pytest.mark.django_db
def test_glossary_creation_uploads_thumbnail_and_cover_to_media_library(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(
        username="glossary-create-media",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]

    response = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/",
        {
            "title": "Library article",
            "synopsis": "Reusable images",
            "categoryId": category_id,
            "thumbnail": image_upload("thumbnail.png", "#245b47"),
            "cover": image_upload("cover.png", "#8f4f32"),
        },
    )

    assert response.status_code == 201
    assets = {asset.kind: asset for asset in GlossaryAsset.objects.select_related("media")}
    assert set(assets) == {GlossaryAsset.KIND_THUMBNAIL, GlossaryAsset.KIND_COVER}
    assert all(asset.media_id is not None for asset in assets.values())
    assert UserMediaAsset.objects.filter(owner=user).count() == 2

    storage = client.get("/api/auth/storage/?group=glossary&page=1&pageSize=48")
    assert storage.status_code == 200
    assert {item["mediaType"] for item in storage.json()["items"]} == {
        "glossary_thumbnail",
        "glossary_cover",
    }
    assert all(item["id"].startswith("media:") for item in storage.json()["items"])


@pytest.mark.django_db
def test_glossary_metadata_uploads_are_added_to_media_library(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-update-media",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]
    article = create_article(client, manuscript["id"], category_id).json()["article"]

    thumbnail = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/thumbnail/",
        {"thumbnail": image_upload("thumbnail.png", "#245b47")},
    )
    cover = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/cover/",
        {"cover": image_upload("cover.png", "#8f4f32")},
    )

    assert thumbnail.status_code == 200
    assert cover.status_code == 200
    assert (
        GlossaryAsset.objects.filter(
            article__public_id=article["id"],
            media__isnull=False,
        ).count()
        == 2
    )
    assert UserMediaAsset.objects.filter(owner=user).count() == 2
    storage = client.get("/api/auth/storage/?group=glossary&page=1&pageSize=48")
    assert storage.status_code == 200
    assert len(storage.json()["items"]) == 2
    assert all(item["id"].startswith("media:") for item in storage.json()["items"])


@pytest.mark.django_db
def test_article_media_gallery_returns_only_current_assets_in_document_order(
    client,
    django_user_model,
):
    owner = django_user_model.objects.create_user(username="gallery-owner", password="password")
    stranger = django_user_model.objects.create_user(
        username="gallery-stranger",
        password="password",
    )
    client.force_login(owner)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]
    article = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/",
        {
            "title": "Illustrated lore",
            "synopsis": "Current media",
            "categoryId": category_id,
            "thumbnail": image_upload("thumbnail.png", "#245b47"),
            "cover": image_upload("cover.png", "#8f4f32"),
        },
    ).json()["article"]
    illustrations = [
        client.post(
            f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
            {"image": image_upload(f"illustration-{index}.png", f"#{index + 2}45555")},
        ).json()["asset"]
        for index in range(3)
    ]

    def illustration(asset):
        return {
            "type": "illustration",
            "attrs": {
                "assetId": asset["id"],
                "alt": "",
                "caption": "",
                "alignment": "center",
                "displayWidth": 100,
            },
        }

    content = {
        "type": "doc",
        "content": [
            illustration(illustrations[1]),
            {"type": "paragraph"},
            illustration(illustrations[0]),
            {"type": "paragraph"},
            illustration(illustrations[1]),
        ],
    }
    saved = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    gallery = client.get(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/"
    )

    assert saved.status_code == 200
    assert saved.json()["article"]["mediaCount"] == 4
    assert gallery.status_code == 200
    assert [asset["kind"] for asset in gallery.json()["assets"]] == [
        "thumbnail",
        "cover",
        "illustration",
        "illustration",
    ]
    assert [asset["id"] for asset in gallery.json()["assets"][2:]] == [
        illustrations[1]["id"],
        illustrations[0]["id"],
    ]
    assert illustrations[2]["id"] not in {
        asset["id"] for asset in gallery.json()["assets"]
    }

    client.force_login(stranger)
    denied = client.get(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/"
    )
    assert denied.status_code == 404


@pytest.mark.django_db
def test_glossary_article_imports_supported_markdown(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-importer",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]

    response = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/",
        {
            "title": "Imported lore",
            "synopsis": "Imported description",
            "categoryId": category_id,
            "importFile": markdown_upload(
                "---\nprivate: true\n---\n"
                "# Heading\n\n"
                "#### Detail\n\n"
                "**Bold** *italic* ~~removed~~ [link](https://example.test)\n\n"
                "- First\n- Second\n\n"
                "> Quote\n\n"
                "```\nplain code\n```\n\n"
                "***\n\n"
                "![secret](image.png)"
            ),
        },
    )

    assert response.status_code == 201
    content = response.json()["article"]["content"]["content"]
    assert [block["type"] for block in content] == [
        "heading",
        "heading",
        "paragraph",
        "paragraph",
        "paragraph",
        "paragraph",
        "horizontalRule",
    ]
    assert content[0]["attrs"]["level"] == 1
    assert content[1]["attrs"]["level"] == 4
    assert content[2]["content"] == [
        {"type": "text", "text": "Bold", "marks": [{"type": "bold"}]},
        {"type": "text", "text": " "},
        {"type": "text", "text": "italic", "marks": [{"type": "italic"}]},
        {"type": "text", "text": " "},
        {"type": "text", "text": "removed", "marks": [{"type": "strike"}]},
        {"type": "text", "text": " link"},
    ]
    assert content[3]["content"] == [
        {"type": "text", "text": "First"},
        {"type": "hardBreak"},
        {"type": "text", "text": "Second"},
    ]
    assert content[4]["content"][0]["text"] == "Quote"
    assert content[5]["content"][0]["text"] == "plain code"


@pytest.mark.django_db
def test_invalid_glossary_article_import_does_not_create_article(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="invalid-glossary-importer",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category_id = glossary_context(client, manuscript["id"])["categories"][0]["id"]

    response = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/",
        {
            "title": "Rejected lore",
            "synopsis": "",
            "categoryId": category_id,
            "importFile": markdown_upload("Plain text", name="article.txt"),
        },
    )

    assert response.status_code == 400
    assert response.json()["error"] == "glossary_import_file_type_unsupported"
    too_large = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/",
        {
            "title": "Oversized lore",
            "synopsis": "",
            "categoryId": category_id,
            "importFile": SimpleUploadedFile(
                "oversized.md",
                b"x" * (4 * 1024 * 1024 + 1),
                content_type="text/markdown",
            ),
        },
    )
    assert too_large.status_code == 400
    assert too_large.json()["error"] == "glossary_import_file_too_large"
    assert GlossaryArticle.objects.count() == 0


@pytest.mark.django_db
def test_glossary_mutations_write_signal_without_content_payloads(client, django_user_model):
    user = django_user_model.objects.create_user(username="glossary-auditor", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    context = glossary_context(client, manuscript["id"])
    AuditEvent.objects.all().delete()

    category = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/",
        data=json.dumps(
            {
                "name": "Magic",
                "description": "Rules and schools",
                "icon": "game-icons:crystal-ball",
            }
        ),
        content_type="application/json",
    ).json()["category"]
    client.patch(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/{category['id']}/",
        data=json.dumps({"name": "Arcana"}),
        content_type="application/json",
    )
    deletable_category = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/",
        data=json.dumps(
            {
                "name": "Temporary",
                "description": "",
                "icon": "game-icons:archive-register",
            }
        ),
        content_type="application/json",
    ).json()["category"]
    client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/{deletable_category['id']}/"
    )
    article = create_article(
        client,
        manuscript["id"],
        context["categories"][0]["id"],
    ).json()["article"]
    client.patch(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/",
        data=json.dumps({"title": "Renamed", "favourite": True}),
        content_type="application/json",
    )
    asset = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload()},
    ).json()["asset"]
    client.patch(
        f"/api/manuscripts/{manuscript['id']}/glossary/assets/{asset['id']}/",
        data=json.dumps({"alt": "Map", "caption": "North"}),
        content_type="application/json",
    )
    linked = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/associations/",
        data=json.dumps({"articleId": article["id"]}),
        content_type="application/json",
    )
    unlinked = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/associations/",
        data=json.dumps({"articleId": article["id"]}),
        content_type="application/json",
    )
    content = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": {"type": "doc", "content": [{"type": "paragraph"}]},
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    deleted = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/"
    )

    events = list(AuditEvent.objects.order_by("created_at"))
    event_codes = [event.event for event in events]
    assert linked.status_code == 201
    assert unlinked.status_code == 200
    assert content.status_code == 200
    assert deleted.status_code == 200
    assert event_codes.count("manuscript.glossary_article_assets_updated") == 2
    assert set(event_codes) == {
        "manuscript.glossary_category_created",
        "manuscript.glossary_category_updated",
        "manuscript.glossary_category_deleted",
        "manuscript.glossary_article_created",
        "manuscript.glossary_article_metadata_updated",
        "manuscript.glossary_article_assets_updated",
        "manuscript.glossary_article_linked",
        "manuscript.glossary_article_unlinked",
        "manuscript.glossary_article_deleted",
    }
    assert all(
        "Renamed" not in str(event.payload)
        and "Private lore" not in str(event.payload)
        and "North" not in str(event.payload)
        for event in events
    )


@pytest.mark.django_db
def test_shared_glossary_image_remains_after_article_delete(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="preserved-glossary-image",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    uploaded = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload()},
    )
    media = UserMediaAsset.objects.get(owner=user)

    deleted = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/"
    )
    storage = client.get("/api/auth/storage/?group=all&page=1&pageSize=18")

    assert uploaded.status_code == 201
    assert deleted.status_code == 200
    assert UserMediaAsset.objects.filter(id=media.id).exists()
    stored_item = next(
        item for item in storage.json()["items"] if item["id"] == f"media:{media.public_id}"
    )
    assert stored_item["usages"] == []
    assert stored_item["deletable"] is True


@pytest.mark.django_db
def test_glossary_asset_metadata_can_be_updated(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-asset-editor",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    asset = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
        {"image": image_upload()},
    ).json()["asset"]

    response = client.patch(
        f"/api/manuscripts/{manuscript['id']}/glossary/assets/{asset['id']}/",
        data=json.dumps({"alt": "Map of Aelar", "caption": "Northern kingdoms"}),
        content_type="application/json",
    )

    stored = GlossaryAsset.objects.get(public_id=asset["id"])
    assert response.status_code == 200
    assert response.json()["asset"]["alt"] == "Map of Aelar"
    assert stored.alt_text == "Map of Aelar"
    assert stored.caption == "Northern kingdoms"


@pytest.mark.django_db
def test_custom_category_must_be_empty_before_delete(client, django_user_model):
    user = django_user_model.objects.create_user(username="category-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    glossary_context(client, manuscript["id"])
    created = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/",
        data=json.dumps(
            {
                "name": "Magic",
                "description": "Rules and schools",
                "icon": "game-icons:crystal-ball",
            }
        ),
        content_type="application/json",
    )
    category = created.json()["category"]
    create_article(client, manuscript["id"], category["id"], "Starweaving")

    rejected = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/categories/{category['id']}/"
    )

    assert created.status_code == 201
    assert rejected.status_code == 409
    assert rejected.json()["error"] == "glossary_category_not_empty"
    stored = GlossaryCategory.objects.get(public_id=category["id"])
    assert stored.name == "Magic"
    assert stored.name == "Magic"


@pytest.mark.django_db
def test_article_content_generation_and_internal_link_protection(client, django_user_model):
    user = django_user_model.objects.create_user(username="link-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    source = create_article(client, manuscript["id"], category["id"], "Source").json()["article"]
    target = create_article(client, manuscript["id"], category["id"], "Target").json()["article"]
    content = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Target",
                        "marks": [
                            {
                                "type": "glossaryLink",
                                "attrs": {"articleId": target["id"]},
                            }
                        ],
                    }
                ],
            }
        ],
    }
    saved = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{source['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    conflict = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{source['id']}/content/",
        data=json.dumps(
            {
                "content": {"type": "doc", "content": [{"type": "paragraph"}]},
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    delete_target = client.delete(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{target['id']}/"
    )

    assert saved.status_code == 200
    assert saved.json()["article"]["saveGeneration"] == 1
    assert GlossaryArticleLink.objects.count() == 1
    assert conflict.status_code == 409
    assert conflict.json()["error"] == "glossary_save_conflict"
    assert delete_target.status_code == 409
    assert delete_target.json()["error"] == "glossary_article_referenced"


@pytest.mark.django_db
def test_article_accepts_tiptap_list_link_and_table_attributes(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-tiptap-attributes",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    paragraph = {"type": "paragraph", "content": [{"type": "text", "text": "Item"}]}
    content = {
        "type": "doc",
        "content": [
            {
                "type": "bulletList",
                "content": [{"type": "listItem", "content": [paragraph]}],
            },
            {
                "type": "orderedList",
                "attrs": {"start": 1, "type": None},
                "content": [
                    {"type": "listItem", "content": [paragraph]},
                    {"type": "listItem", "content": [paragraph]},
                ],
            },
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "Example",
                        "marks": [
                            {
                                "type": "link",
                                "attrs": {
                                    "href": "https://example.test/path",
                                    "target": "_blank",
                                    "rel": "noopener noreferrer nofollow",
                                    "class": None,
                                    "title": None,
                                },
                            }
                        ],
                    }
                ],
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableHeader",
                                "attrs": {
                                    "colspan": 1,
                                    "rowspan": 1,
                                    "colwidth": None,
                                    "align": None,
                                },
                                "content": [paragraph],
                            },
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [paragraph],
                            },
                        ],
                    }
                ],
            },
        ],
    }

    response = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["article"]["content"] == content


@pytest.mark.django_db
def test_article_accepts_gallery_and_rejects_single_item_gallery(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-gallery-writer",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    assets = [
        client.post(
            f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/assets/",
            {"image": image_upload(f"gallery-{index}.png")},
        ).json()["asset"]
        for index in range(2)
    ]

    def illustration(asset):
        return {
            "type": "illustration",
            "attrs": {
                "assetId": asset["id"],
                "alt": "",
                "caption": "",
                "alignment": "center",
                "displayWidth": 100,
            },
        }

    content = {
        "type": "doc",
        "content": [
            {
                "type": "illustrationGallery",
                "content": [illustration(asset) for asset in assets],
            }
        ],
    }
    saved = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )
    rejected = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "illustrationGallery",
                            "content": [illustration(assets[0])],
                        }
                    ],
                },
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 1,
            }
        ),
        content_type="application/json",
    )

    assert saved.status_code == 200
    assert saved.json()["article"]["content"] == content
    assert rejected.status_code == 400
    assert rejected.json()["error"] == "glossary_illustration_gallery_invalid"


@pytest.mark.django_db
def test_article_rejects_nested_tables(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="glossary-nested-table",
        password="password",
    )
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    paragraph = {"type": "paragraph", "content": [{"type": "text", "text": "Item"}]}
    nested_table = {
        "type": "table",
        "content": [
            {
                "type": "tableRow",
                "content": [
                    {
                        "type": "tableCell",
                        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                        "content": [paragraph],
                    }
                ],
            }
        ],
    }
    content = {
        "type": "doc",
        "content": [
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                                "content": [nested_table],
                            }
                        ],
                    }
                ],
            }
        ],
    }

    response = client.put(
        f"/api/manuscripts/{manuscript['id']}/glossary/articles/{article['id']}/content/",
        data=json.dumps(
            {
                "content": content,
                "schemaVersion": GlossaryArticle.CURRENT_SCHEMA_VERSION,
                "expectedGeneration": 0,
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["error"] == "glossary_table_nested_invalid"


@pytest.mark.django_db
def test_manual_document_association_is_separate_from_document_content(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="association-writer", password="password")
    client.force_login(user)
    manuscript = create_oneshot(client)
    category = glossary_context(client, manuscript["id"])["categories"][0]
    article = create_article(client, manuscript["id"], category["id"]).json()["article"]
    document_before = Manuscript.objects.get(public_id=manuscript["id"]).document.content

    linked = client.post(
        f"/api/manuscripts/{manuscript['id']}/glossary/associations/",
        data=json.dumps({"articleId": article["id"], "documentItemId": None}),
        content_type="application/json",
    )
    listed = client.get(f"/api/manuscripts/{manuscript['id']}/glossary/associations/")

    assert linked.status_code == 201
    assert listed.json()["articleIds"] == [article["id"]]
    assert DocumentGlossaryAssociation.objects.count() == 1
    assert Manuscript.objects.get(public_id=manuscript["id"]).document.content == document_before


@pytest.mark.django_db
def test_series_glossary_hides_and_restores_book_glossary(client, django_user_model):
    user = django_user_model.objects.create_user(username="series-glossary", password="password")
    client.force_login(user)
    book = create_book(client)
    own_context = glossary_context(client, book["id"])
    own_glossary_id = Glossary.objects.get(manuscript__public_id=book["id"]).id
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Shared cycle"},
    ).json()["series"]["id"]

    added = client.put(
        f"/api/manuscripts/books/{book['id']}/series-membership/",
        data=json.dumps({"seriesId": series_id, "seriesPosition": 1}),
        content_type="application/json",
    )
    shared_context = glossary_context(client, book["id"])
    shared_glossary = Glossary.objects.get(series__public_id=series_id)
    removed = client.delete(f"/api/manuscripts/books/{book['id']}/series-membership/")
    restored_context = glossary_context(client, book["id"])

    assert added.status_code == 200
    assert shared_context["scopeType"] == "series"
    assert shared_glossary.id != own_glossary_id
    assert removed.status_code == 200
    assert restored_context["scopeType"] == "manuscript"
    assert restored_context["scopeId"] == own_context["scopeId"]


@pytest.mark.django_db
def test_series_glossary_article_exports_through_member_book(client, django_user_model):
    user = django_user_model.objects.create_user(
        username="series-glossary-export",
        password="password",
    )
    client.force_login(user)
    book = create_book(client)
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Shared cycle"},
    ).json()["series"]["id"]
    client.put(
        f"/api/manuscripts/books/{book['id']}/series-membership/",
        data=json.dumps({"seriesId": series_id, "seriesPosition": 1}),
        content_type="application/json",
    )
    category = glossary_context(client, book["id"])["categories"][0]
    article = create_article(
        client,
        book["id"],
        category["id"],
        title="Shared lore",
    ).json()["article"]

    response = client.post(
        f"/api/manuscripts/{book['id']}/glossary/articles/{article['id']}/export/",
        data=json.dumps({"format": "html"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    with export_archive(response) as archive:
        assert "Shared lore.html" in archive.namelist()


@pytest.mark.django_db
def test_series_glossary_alias_is_inherited_by_every_member_spellcheck_lexicon(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="series-alias", password="password")
    client.force_login(user)
    first_book = create_book(client, "First book")
    second_book = create_book(client, "Second book")
    series_id = client.post(
        "/api/manuscripts/series/",
        {"title": "Shared aliases"},
    ).json()["series"]["id"]
    for position, book in enumerate((first_book, second_book), start=1):
        client.put(
            f"/api/manuscripts/books/{book['id']}/series-membership/",
            data=json.dumps({"seriesId": series_id, "seriesPosition": position}),
            content_type="application/json",
        )
    category_id = glossary_context(client, first_book["id"])["categories"][0]["id"]
    article = create_article(
        client,
        first_book["id"],
        category_id,
        title="Филомина де Сиензо",
    ).json()["article"]
    created = client.post(
        f"/api/manuscripts/{first_book['id']}/glossary/articles/{article['id']}/aliases/",
        data=json.dumps({"name": "Фило"}),
        content_type="application/json",
    )
    inherited = client.get(
        f"/api/manuscripts/{second_book['id']}/spellcheck-lexicon/"
    )

    assert created.status_code == 201
    assert inherited.status_code == 200
    assert inherited.json()["lexicon"]["scope"]["type"] == "series"
    assert inherited.json()["lexicon"]["glossaryTerms"] == [
        "Филомина де Сиензо",
        "Фило",
    ]


@pytest.mark.django_db
def test_series_delete_cascades_glossary_but_preserves_book_glossary(
    client,
    django_user_model,
):
    user = django_user_model.objects.create_user(username="series-delete", password="password")
    client.force_login(user)
    book = create_book(client)
    glossary_context(client, book["id"])
    own_glossary = Glossary.objects.get(manuscript__public_id=book["id"])
    series_id = client.post("/api/manuscripts/series/", {"title": "Cycle"}).json()["series"]["id"]
    client.put(
        f"/api/manuscripts/books/{book['id']}/series-membership/",
        data=json.dumps({"seriesId": series_id, "seriesPosition": None}),
        content_type="application/json",
    )
    glossary_context(client, book["id"])

    deleted = client.delete(f"/api/manuscripts/series/{series_id}/")

    assert deleted.status_code == 200
    assert not Series.objects.filter(public_id=series_id).exists()
    assert Glossary.objects.filter(id=own_glossary.id).exists()
    assert Manuscript.objects.filter(public_id=book["id"]).exists()


@pytest.mark.django_db
def test_glossary_is_owner_only(client, django_user_model):
    owner = django_user_model.objects.create_user(username="glossary-owner", password="password")
    stranger = django_user_model.objects.create_user(
        username="glossary-stranger", password="password"
    )
    client.force_login(owner)
    manuscript = create_oneshot(client)
    glossary_context(client, manuscript["id"])
    client.force_login(stranger)

    response = client.get(f"/api/manuscripts/{manuscript['id']}/glossary/")

    assert response.status_code == 404
