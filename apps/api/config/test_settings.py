from config.settings import CORS_EXPOSE_HEADERS, env_or_file


def test_content_disposition_is_exposed_for_cross_origin_downloads():
    assert "Content-Disposition" in CORS_EXPOSE_HEADERS


def test_env_or_file_reads_persistent_secret_file(monkeypatch, tmp_path):
    secret_file = tmp_path / "secret"
    secret_file.write_text(" file-secret\n", encoding="utf-8")
    monkeypatch.delenv("QUILLUM_TEST_SECRET", raising=False)
    monkeypatch.setenv("QUILLUM_TEST_SECRET_FILE", str(secret_file))

    assert env_or_file("QUILLUM_TEST_SECRET", "QUILLUM_TEST_SECRET_FILE") == "file-secret"


def test_env_or_file_prefers_direct_value(monkeypatch, tmp_path):
    secret_file = tmp_path / "secret"
    secret_file.write_text("file-secret", encoding="utf-8")
    monkeypatch.setenv("QUILLUM_TEST_SECRET", "direct-secret")
    monkeypatch.setenv("QUILLUM_TEST_SECRET_FILE", str(secret_file))

    assert env_or_file("QUILLUM_TEST_SECRET", "QUILLUM_TEST_SECRET_FILE") == "direct-secret"
