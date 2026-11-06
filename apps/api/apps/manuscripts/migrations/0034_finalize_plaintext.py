from django.db import migrations, models

import apps.manuscripts.defaults


def finalize_field(model_name, old_name, new_name, field):
    return [
        migrations.RenameField(
            model_name=model_name,
            old_name=old_name,
            new_name=new_name,
        ),
        migrations.AlterField(
            model_name=model_name,
            name=new_name,
            field=field,
        ),
    ]


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0023_finalize_plaintext"),
        ("manuscripts", "0001_squashed_0033_plaintext_bridge"),
    ]

    operations = [
        *finalize_field("series", "title_plaintext", "title", models.TextField(editable=False)),
        *finalize_field(
            "series",
            "synopsis_plaintext",
            "synopsis",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field("manuscript", "title_plaintext", "title", models.TextField(editable=False)),
        *finalize_field(
            "manuscript",
            "synopsis_plaintext",
            "synopsis",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "manuscript",
            "genres_plaintext",
            "genres",
            models.JSONField(default=list, editable=False),
        ),
        *finalize_field(
            "manuscript",
            "planner_settings_plaintext",
            "planner_settings",
            models.JSONField(
                default=apps.manuscripts.defaults.planner_settings_default,
                editable=False,
            ),
        ),
        *finalize_field(
            "manuscript",
            "dashboard_memo_plaintext",
            "dashboard_memo",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "manuscript",
            "dashboard_settings_plaintext",
            "dashboard_settings",
            models.JSONField(
                default=apps.manuscripts.defaults.dashboard_settings_default,
                editable=False,
            ),
        ),
        *finalize_field(
            "manuscriptitem",
            "title_plaintext",
            "title",
            models.TextField(editable=False),
        ),
        *finalize_field(
            "manuscriptitem",
            "planner_metadata_plaintext",
            "planner_metadata",
            models.JSONField(
                default=apps.manuscripts.defaults.planner_metadata_default,
                editable=False,
            ),
        ),
        *finalize_field(
            "manuscriptplanstatus",
            "name_plaintext",
            "name",
            models.TextField(editable=False),
        ),
        *finalize_field(
            "manuscripttask",
            "content_plaintext",
            "content",
            models.JSONField(default=dict, editable=False),
        ),
        *finalize_field(
            "manuscriptboard", "name_plaintext", "name", models.TextField(editable=False)
        ),
        *finalize_field(
            "manuscriptnotetag", "name_plaintext", "name", models.TextField(editable=False)
        ),
        *finalize_field(
            "manuscriptnote", "title_plaintext", "title", models.TextField(editable=False)
        ),
        *finalize_field(
            "manuscriptnote", "content_plaintext", "content", models.JSONField(editable=False)
        ),
        *finalize_field(
            "document", "content_plaintext", "content", models.JSONField(editable=False)
        ),
        *finalize_field(
            "documentversion",
            "name_plaintext",
            "name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "documentversion",
            "description_plaintext",
            "description",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "documentversion",
            "snapshot_plaintext",
            "snapshot_data",
            models.BinaryField(),
        ),
        *finalize_field(
            "manuscriptasset",
            "alt_text_plaintext",
            "alt_text",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "manuscriptasset",
            "caption_plaintext",
            "caption",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "glossarycustomword", "word_plaintext", "word", models.TextField(editable=False)
        ),
        *finalize_field(
            "glossarycategory",
            "name_plaintext",
            "name",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "glossarycategory",
            "description_plaintext",
            "description",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "glossaryarticle", "title_plaintext", "title", models.TextField(editable=False)
        ),
        *finalize_field(
            "glossaryarticle",
            "synopsis_plaintext",
            "synopsis",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "glossaryarticle", "content_plaintext", "content", models.JSONField(editable=False)
        ),
        *finalize_field(
            "glossaryasset",
            "alt_text_plaintext",
            "alt_text",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "glossaryasset",
            "caption_plaintext",
            "caption",
            models.TextField(blank=True, default="", editable=False),
        ),
        *finalize_field(
            "documentannotation", "quote_plaintext", "quote", models.TextField(editable=False)
        ),
        *finalize_field(
            "documentannotation",
            "comment_plaintext",
            "comment",
            models.TextField(editable=False),
        ),
        *finalize_field(
            "annotationreply", "body_plaintext", "body", models.TextField(editable=False)
        ),
        *finalize_field(
            "manuscriptsharelink", "token_plaintext", "token", models.TextField(editable=False)
        ),
        migrations.RemoveField(model_name="workspace", name="encrypted_data_key"),
        migrations.RemoveField(model_name="series", name="title_ciphertext"),
        migrations.RemoveField(model_name="series", name="synopsis_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="title_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="synopsis_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="genres_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="planner_settings_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="dashboard_memo_ciphertext"),
        migrations.RemoveField(model_name="manuscript", name="dashboard_settings_ciphertext"),
        migrations.RemoveField(model_name="manuscriptitem", name="title_ciphertext"),
        migrations.RemoveField(model_name="manuscriptitem", name="planner_metadata_ciphertext"),
        migrations.RemoveField(model_name="manuscriptplanstatus", name="name_ciphertext"),
        migrations.RemoveField(model_name="manuscripttask", name="content_ciphertext"),
        migrations.RemoveField(model_name="manuscriptboard", name="name_ciphertext"),
        migrations.RemoveField(model_name="manuscriptnotetag", name="name_ciphertext"),
        migrations.RemoveField(model_name="manuscriptnote", name="title_ciphertext"),
        migrations.RemoveField(model_name="manuscriptnote", name="content_ciphertext"),
        migrations.RemoveField(model_name="document", name="content_ciphertext"),
        migrations.RemoveField(model_name="documentversion", name="name_ciphertext"),
        migrations.RemoveField(model_name="documentversion", name="description_ciphertext"),
        migrations.RemoveField(model_name="documentversion", name="snapshot_ciphertext"),
        migrations.RemoveField(model_name="manuscriptasset", name="alt_text_ciphertext"),
        migrations.RemoveField(model_name="manuscriptasset", name="caption_ciphertext"),
        migrations.RemoveField(model_name="glossarycustomword", name="word_ciphertext"),
        migrations.RemoveField(model_name="glossarycategory", name="name_ciphertext"),
        migrations.RemoveField(model_name="glossarycategory", name="description_ciphertext"),
        migrations.RemoveField(model_name="glossaryarticle", name="title_ciphertext"),
        migrations.RemoveField(model_name="glossaryarticle", name="synopsis_ciphertext"),
        migrations.RemoveField(model_name="glossaryarticle", name="content_ciphertext"),
        migrations.RemoveField(model_name="glossaryasset", name="alt_text_ciphertext"),
        migrations.RemoveField(model_name="glossaryasset", name="caption_ciphertext"),
        migrations.RemoveField(model_name="documentannotation", name="quote_ciphertext"),
        migrations.RemoveField(model_name="documentannotation", name="comment_ciphertext"),
        migrations.RemoveField(model_name="annotationreply", name="body_ciphertext"),
        migrations.RemoveField(model_name="manuscriptsharelink", name="token_ciphertext"),
    ]
