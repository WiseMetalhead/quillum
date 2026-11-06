import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("manuscripts", "0040_manuscript_note_source_idea"),
    ]

    operations = [
        migrations.RenameModel(
            old_name="ManuscriptNoteAudio",
            new_name="AudioRecording",
        ),
        migrations.RenameModel(
            old_name="ManuscriptNoteTranscription",
            new_name="AudioTranscriptionState",
        ),
        migrations.AlterField(
            model_name="audiorecording",
            name="note",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="audio",
                to="manuscripts.manuscriptnote",
            ),
        ),
        migrations.AddField(
            model_name="audiorecording",
            name="idea",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="audio",
                to="manuscripts.ideaitem",
            ),
        ),
        migrations.AddConstraint(
            model_name="audiorecording",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(idea__isnull=True, note__isnull=False)
                    | models.Q(idea__isnull=False, note__isnull=True)
                ),
                name="audio_recording_single_owner",
            ),
        ),
    ]
