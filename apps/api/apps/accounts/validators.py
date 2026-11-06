from __future__ import annotations

import re

from django.core.exceptions import ValidationError


class PasswordCompositionValidator:
    def validate(self, password: str, user=None) -> None:
        if (
            not re.search(r"[A-Za-z]", password)
            or not re.search(r"\d", password)
            or not re.search(r"[^A-Za-z0-9]", password)
        ):
            raise ValidationError(
                "Your password must include letters, numbers, and a special character.",
                code="password_missing_character_types",
            )

    def get_help_text(self) -> str:
        return "Your password must include letters, numbers, and a special character."
