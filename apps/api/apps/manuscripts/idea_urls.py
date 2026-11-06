from django.urls import path

from .ideas import (
    idea_attach,
    idea_audio,
    idea_audio_content,
    idea_audio_import,
    idea_audio_transcription,
    idea_detail,
    idea_images,
    idea_targets,
    idea_text,
    ideas,
)

urlpatterns = [
    path("", ideas, name="ideas"),
    path("images/", idea_images, name="idea-images"),
    path("text/", idea_text, name="idea-text"),
    path("audio/", idea_audio, name="idea-audio"),
    path("audio/import/", idea_audio_import, name="idea-audio-import"),
    path("targets/", idea_targets, name="idea-targets"),
    path("<uuid:idea_id>/attach/", idea_attach, name="idea-attach"),
    path("<uuid:idea_id>/audio/", idea_audio_content, name="idea-audio-content"),
    path(
        "<uuid:idea_id>/transcription/",
        idea_audio_transcription,
        name="idea-audio-transcription",
    ),
    path("<uuid:idea_id>/", idea_detail, name="idea-detail"),
]
