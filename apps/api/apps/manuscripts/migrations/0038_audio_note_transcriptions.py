import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("manuscripts", "0037_audio_notes"),
    ]

    operations = [
        migrations.CreateModel(
            name="ManuscriptNoteTranscription",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("processing", "Processing"),
                            ("ready", "Ready"),
                            ("failed", "Failed"),
                        ],
                        db_index=True,
                        max_length=16,
                    ),
                ),
                ("text", models.TextField(blank=True, editable=False)),
                (
                    "language",
                    models.CharField(blank=True, editable=False, max_length=2),
                ),
                (
                    "error_code",
                    models.CharField(blank=True, editable=False, max_length=80),
                ),
                ("generation", models.PositiveBigIntegerField(default=1, editable=False)),
                (
                    "task_id",
                    models.CharField(blank=True, editable=False, max_length=255),
                ),
                ("requested_at", models.DateTimeField(db_index=True)),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("text_updated_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "audio",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="transcription",
                        to="manuscripts.manuscriptnoteaudio",
                    ),
                ),
            ],
            options={
                "ordering": ["requested_at", "id"],
            },
        ),
        migrations.AddIndex(
            model_name="manuscriptnotetranscription",
            index=models.Index(
                fields=["status", "requested_at", "id"],
                name="note_trans_status_queue_idx",
            ),
        ),
    ]
