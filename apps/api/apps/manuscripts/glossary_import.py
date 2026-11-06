from __future__ import annotations

from pathlib import PurePath

from .glossary_schema import InvalidGlossaryContent, validate_glossary_content
from .text_import import InvalidTextImport, decode_text_source, source_to_basic_content

MAX_GLOSSARY_IMPORT_BYTES = 4 * 1024 * 1024


class InvalidGlossaryImport(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def imported_glossary_content(uploaded) -> dict:
    if PurePath(str(uploaded.name)).suffix.lower() != ".md":
        raise InvalidGlossaryImport("glossary_import_file_type_unsupported")
    if uploaded.size > MAX_GLOSSARY_IMPORT_BYTES:
        raise InvalidGlossaryImport("glossary_import_file_too_large")
    try:
        source = decode_text_source(uploaded.read())
    except (InvalidTextImport, UnicodeDecodeError) as exc:
        if isinstance(exc, UnicodeDecodeError):
            raise InvalidGlossaryImport("glossary_import_file_invalid") from exc
        if exc.code == "import_file_binary":
            raise InvalidGlossaryImport("glossary_import_file_binary") from exc
        raise InvalidGlossaryImport("glossary_import_file_invalid") from exc

    content = source_to_basic_content(
        source,
        ".md",
        max_heading_level=5,
        separator_type="horizontalRule",
    )
    try:
        return validate_glossary_content(content)
    except InvalidGlossaryContent as exc:
        raise InvalidGlossaryImport(str(exc)) from exc
