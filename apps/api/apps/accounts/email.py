from __future__ import annotations

import sys
from dataclasses import dataclass
from html import escape
from typing import Literal

from django.core.exceptions import ImproperlyConfigured
from django.core.mail import EmailMultiAlternatives, get_connection

from apps.adminpanel.runtime_settings import runtime_setting

EmailLanguage = Literal["en", "ru"]
EmailTemplateKey = Literal[
    "email_change_code",
    "password_change_code",
    "password_reset_code",
    "email_two_factor_setup_code",
    "email_two_factor_login_code",
    "admin_email_test",
]

EMAIL_BACKENDS = {
    "console": "django.core.mail.backends.console.EmailBackend",
    "smtp": "django.core.mail.backends.smtp.EmailBackend",
}

BRAND = "Quillum"
BRAND_COLOR = "#d14200"
BRAND_COLOR_DARK = "#b83900"
BRAND_SURFACE = "#fff7f2"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
BORDER_COLOR = "#e2e8f0"


@dataclass(frozen=True)
class RuntimeEmailCopy:
    subject: str
    title: str
    intro: str
    action_label: str = ""
    expires: str = ""
    security_note: str = ""
    footer: str = ""
    preheader: str = ""


EMAIL_COPY: dict[EmailTemplateKey, dict[EmailLanguage, RuntimeEmailCopy]] = {
    "email_change_code": {
        "en": RuntimeEmailCopy(
            subject="Confirm your Quillum email address",
            title="Confirm your email address",
            intro=(
                "Use this confirmation code to change the email address for your "
                "Quillum account."
            ),
            action_label="Confirmation code",
            expires="This code expires in {expires_in}.",
            security_note=(
                "If you did not request this change, ignore this email and keep your "
                "current address."
            ),
            footer=(
                "Quillum sent this account security email because an email change was "
                "requested."
            ),
            preheader="Your confirmation code for changing your Quillum email address.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Подтвердите адрес электронной почты Quillum",
            title="Подтвердите адрес электронной почты",
            intro=(
                "Используйте этот код подтверждения, чтобы изменить адрес электронной "
                "почты аккаунта Quillum."
            ),
            action_label="Код подтверждения",
            expires="Код действует {expires_in}.",
            security_note=(
                "Если вы не запрашивали это изменение, проигнорируйте письмо: текущий "
                "адрес останется прежним."
            ),
            footer=(
                "Quillum отправил это письмо безопасности, потому что был запрошен "
                "новый адрес электронной почты."
            ),
            preheader="Код подтверждения для изменения адреса электронной почты Quillum.",
        ),
    },
    "password_change_code": {
        "en": RuntimeEmailCopy(
            subject="Confirm your Quillum password change",
            title="Confirm your password change",
            intro="Use this confirmation code to change the password for your Quillum account.",
            action_label="Confirmation code",
            expires="This code expires in {expires_in}.",
            security_note=(
                "If you did not request this change, do not share this code and keep "
                "your current password."
            ),
            footer=(
                "Quillum sent this account security email because a password change "
                "was requested."
            ),
            preheader="Your confirmation code for changing your Quillum password.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Подтвердите смену пароля Quillum",
            title="Подтвердите смену пароля",
            intro="Используйте этот код подтверждения, чтобы изменить пароль аккаунта Quillum.",
            action_label="Код подтверждения",
            expires="Код действует {expires_in}.",
            security_note=(
                "Если вы не запрашивали это изменение, никому не сообщайте код: "
                "текущий пароль останется прежним."
            ),
            footer=(
                "Quillum отправил это письмо безопасности, потому что была запрошена "
                "смена пароля."
            ),
            preheader="Код подтверждения для смены пароля Quillum.",
        ),
    },
    "password_reset_code": {
        "en": RuntimeEmailCopy(
            subject="Reset your Quillum password",
            title="Reset your password",
            intro="Use this confirmation code to reset the password for your Quillum account.",
            action_label="Reset code",
            expires="This code expires in {expires_in}.",
            security_note=(
                "If you did not request a password reset, ignore this email and keep "
                "your current password."
            ),
            footer=(
                "Quillum sent this account security email because a password reset "
                "was requested."
            ),
            preheader="Your confirmation code for resetting your Quillum password.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Сбросьте пароль Quillum",
            title="Сбросьте пароль",
            intro="Используйте этот код подтверждения, чтобы сбросить пароль аккаунта Quillum.",
            action_label="Код сброса",
            expires="Код действует {expires_in}.",
            security_note=(
                "Если вы не запрашивали сброс пароля, проигнорируйте письмо: текущий "
                "пароль останется прежним."
            ),
            footer=(
                "Quillum отправил это письмо безопасности, потому что был запрошен "
                "сброс пароля."
            ),
            preheader="Код подтверждения для сброса пароля Quillum.",
        ),
    },
    "email_two_factor_setup_code": {
        "en": RuntimeEmailCopy(
            subject="Confirm Quillum email two-factor authentication",
            title="Confirm email two-factor authentication",
            intro=(
                "Use this confirmation code to enable email two-factor authentication "
                "for your Quillum account."
            ),
            action_label="Confirmation code",
            expires="This code expires in {expires_in}.",
            security_note=(
                "If you did not start this setup, ignore this email and keep your "
                "current security settings."
            ),
            footer=(
                "Quillum sent this account security email because email two-factor "
                "authentication setup was requested."
            ),
            preheader="Your confirmation code for enabling email two-factor authentication.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Подтвердите двухфакторную аутентификацию Quillum по email",
            title="Подтвердите 2FA по email",
            intro=(
                "Используйте этот код подтверждения, чтобы включить двухфакторную "
                "аутентификацию по email для аккаунта Quillum."
            ),
            action_label="Код подтверждения",
            expires="Код действует {expires_in}.",
            security_note=(
                "Если вы не начинали эту настройку, проигнорируйте письмо: текущие "
                "настройки безопасности останутся прежними."
            ),
            footer=(
                "Quillum отправил это письмо безопасности, потому что была запрошена "
                "настройка 2FA по email."
            ),
            preheader="Код подтверждения для включения 2FA по email.",
        ),
    },
    "email_two_factor_login_code": {
        "en": RuntimeEmailCopy(
            subject="Your Quillum sign-in code",
            title="Finish signing in",
            intro="Use this confirmation code to finish signing in to Quillum.",
            action_label="Sign-in code",
            expires="This code expires in {expires_in}.",
            security_note="If you are not signing in, do not share this code.",
            footer=(
                "Quillum sent this account security email because email two-factor "
                "authentication is enabled."
            ),
            preheader="Your confirmation code for signing in to Quillum.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Ваш код входа в Quillum",
            title="Завершите вход",
            intro="Используйте этот код подтверждения, чтобы завершить вход в Quillum.",
            action_label="Код входа",
            expires="Код действует {expires_in}.",
            security_note="Если вы не входите в аккаунт, никому не сообщайте этот код.",
            footer=(
                "Quillum отправил это письмо безопасности, потому что включена "
                "двухфакторная аутентификация по email."
            ),
            preheader="Код подтверждения для входа в Quillum.",
        ),
    },
    "admin_email_test": {
        "en": RuntimeEmailCopy(
            subject="Quillum email configuration test",
            title="Email delivery is configured",
            intro=(
                "Quillum successfully sent this test message with the active outbound "
                "email settings."
            ),
            security_note=(
                "Only recently authenticated super administrators can send this test from "
                "Product Admin."
            ),
            footer="Quillum sent this operational email from the Product Admin settings screen.",
            preheader="Quillum successfully sent this test message.",
        ),
        "ru": RuntimeEmailCopy(
            subject="Проверка настройки почты Quillum",
            title="Отправка почты настроена",
            intro=(
                "Quillum успешно отправил это тестовое сообщение с текущими "
                "настройками исходящей почты."
            ),
            security_note=(
                "Отправить такую проверку из Product Admin могут только недавно "
                "подтвердившие пароль суперадминистраторы."
            ),
            footer="Quillum отправил это служебное письмо со страницы настроек Product Admin.",
            preheader="Quillum успешно отправил тестовое сообщение.",
        ),
    },
}


def running_pytest() -> bool:
    return any("pytest" in argument for argument in sys.argv)


def runtime_email_connection():
    if running_pytest():
        return get_connection(
            backend="django.core.mail.backends.locmem.EmailBackend",
            fail_silently=False,
        )

    backend = runtime_setting("email_backend")
    backend_path = EMAIL_BACKENDS[backend]
    if backend != "smtp":
        return get_connection(backend=backend_path, fail_silently=False)
    use_tls = runtime_setting("email_use_tls")
    use_ssl = runtime_setting("email_use_ssl")
    if use_tls and use_ssl:
        raise ImproperlyConfigured("SMTP STARTTLS and implicit TLS cannot both be enabled.")
    return get_connection(
        backend=backend_path,
        host=runtime_setting("email_host"),
        port=runtime_setting("email_port"),
        username=runtime_setting("email_host_user"),
        password=runtime_setting("email_host_password"),
        use_tls=use_tls,
        use_ssl=use_ssl,
        timeout=runtime_setting("email_timeout_seconds"),
        fail_silently=False,
    )


def normalize_email_language(language: str | None) -> EmailLanguage:
    return "ru" if language == "ru" else "en"


def format_email_minutes(minutes: int, language: EmailLanguage) -> str:
    if language == "en":
        unit = "minute" if minutes == 1 else "minutes"
        return f"{minutes} {unit}"
    if minutes % 10 == 1 and minutes % 100 != 11:
        unit = "минуту"
    elif minutes % 10 in {2, 3, 4} and minutes % 100 not in {12, 13, 14}:
        unit = "минуты"
    else:
        unit = "минут"
    return f"{minutes} {unit}"


def formatted_copy(value: str, context: dict[str, str]) -> str:
    return value.format(**context) if value else ""


def text_email_body(copy: RuntimeEmailCopy, context: dict[str, str]) -> str:
    lines = [
        BRAND,
        "",
        formatted_copy(copy.title, context),
        "",
        formatted_copy(copy.intro, context),
    ]
    code = context.get("code", "")
    if code:
        lines.extend(["", f"{formatted_copy(copy.action_label, context)}: {code}"])
    expires = formatted_copy(copy.expires, context)
    if expires:
        lines.extend(["", expires])
    security_note = formatted_copy(copy.security_note, context)
    if security_note:
        lines.extend(["", security_note])
    footer = formatted_copy(copy.footer, context)
    if footer:
        lines.extend(["", footer])
    return "\n".join(lines).strip()


def paragraph_html(value: str) -> str:
    return escape(value).replace("\n", "<br>")


def css(*rules: str) -> str:
    return "; ".join(rules)


def html_email_body(
    copy: RuntimeEmailCopy,
    context: dict[str, str],
    language: EmailLanguage,
) -> str:
    title = paragraph_html(formatted_copy(copy.title, context))
    intro = paragraph_html(formatted_copy(copy.intro, context))
    code = context.get("code", "")
    action_label = paragraph_html(formatted_copy(copy.action_label, context))
    expires = paragraph_html(formatted_copy(copy.expires, context))
    security_note = paragraph_html(formatted_copy(copy.security_note, context))
    footer = paragraph_html(formatted_copy(copy.footer, context))
    preheader = paragraph_html(formatted_copy(copy.preheader, context))
    body_style = css(
        "margin: 0",
        "padding: 0",
        "background: #f6f8fb",
        f"color: {TEXT_COLOR}",
        "font-family: Arial, Helvetica, sans-serif",
    )
    preheader_style = css(
        "display: none",
        "max-height: 0",
        "overflow: hidden",
        "opacity: 0",
        "color: transparent",
    )
    outer_table_style = css("border-collapse: collapse", "background: #f6f8fb")
    content_table_style = css(
        "width: 100%",
        "max-width: 560px",
        "border-collapse: collapse",
    )
    brand_cell_style = css(
        "padding: 0 0 14px",
        f"color: {TEXT_COLOR}",
        "font-size: 20px",
        "font-weight: 800",
    )
    card_style = css(
        "overflow: hidden",
        f"border: 1px solid {BORDER_COLOR}",
        "border-radius: 8px",
        "background: #ffffff",
    )
    inner_table_style = css("border-collapse: collapse")
    title_style = css(
        "margin: 0",
        f"color: {TEXT_COLOR}",
        "font-size: 24px",
        "line-height: 1.25",
    )
    intro_style = css(
        "padding: 0 32px 22px",
        "color: #334155",
        "font-size: 15px",
        "line-height: 1.6",
    )
    footer_style = css(
        "padding: 16px 4px 0",
        f"color: {MUTED_COLOR}",
        "font-size: 12px",
        "line-height: 1.5",
    )
    code_block = ""
    if code:
        code_label_style = css(
            "margin-bottom: 8px",
            f"color: {MUTED_COLOR}",
            "font-size: 13px",
            "font-weight: 700",
        )
        code_style = css(
            "display: inline-block",
            "padding: 12px 18px",
            "border: 1px solid #ffc4a8",
            "border-radius: 8px",
            f"color: {BRAND_COLOR_DARK}",
            f"background: {BRAND_SURFACE}",
            "font-size: 28px",
            "font-weight: 800",
            "letter-spacing: 0.18em",
            "line-height: 1.2",
        )
        code_block = f"""
        <tr>
          <td style="padding: 0 32px 22px;">
            <div style="{code_label_style}">{action_label}</div>
            <div style="{code_style}">{escape(code)}</div>
          </td>
        </tr>
        """
    expires_block = ""
    if expires:
        expires_style = css(
            "padding: 0 32px 22px",
            f"color: {TEXT_COLOR}",
            "font-size: 15px",
            "line-height: 1.6",
        )
        expires_block = f"""
        <tr>
          <td style="{expires_style}">{expires}</td>
        </tr>
        """
    note_block = ""
    if security_note:
        note_style = css(
            "padding: 0 32px 28px",
            f"color: {MUTED_COLOR}",
            "font-size: 14px",
            "line-height: 1.55",
        )
        note_block = f"""
        <tr>
          <td style="{note_style}">{security_note}</td>
        </tr>
        """
    return f"""<!doctype html>
<html lang="{language}">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{title}</title>
  </head>
  <body style="{body_style}">
    <div style="{preheader_style}">{preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
      style="{outer_table_style}">
      <tr>
        <td align="center" style="padding: 28px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
            style="{content_table_style}">
            <tr>
              <td style="{brand_cell_style}">
                {BRAND}
              </td>
            </tr>
            <tr>
              <td style="{card_style}">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
                  style="{inner_table_style}">
                  <tr>
                    <td style="padding: 30px 32px 12px;">
                      <h1 style="{title_style}">{title}</h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="{intro_style}">{intro}</td>
                  </tr>
                  {code_block}
                  {expires_block}
                  {note_block}
                </table>
              </td>
            </tr>
            <tr>
              <td style="{footer_style}">{footer}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""


def render_templated_email(
    template: EmailTemplateKey,
    *,
    language: str | None = None,
    context: dict[str, object] | None = None,
) -> tuple[str, str, str]:
    normalized_language = normalize_email_language(language)
    copy = EMAIL_COPY[template][normalized_language]
    string_context = {
        key: str(value)
        for key, value in (context or {}).items()
        if value is not None
    }
    return (
        formatted_copy(copy.subject, string_context),
        text_email_body(copy, string_context),
        html_email_body(copy, string_context, normalized_language),
    )


def send_runtime_email(
    *,
    subject: str,
    message: str,
    recipient_list: list[str],
    html_message: str = "",
) -> int:
    email = EmailMultiAlternatives(
        subject=subject,
        body=message,
        from_email=runtime_setting("email_default_from"),
        to=recipient_list,
        connection=runtime_email_connection(),
    )
    if html_message:
        email.attach_alternative(html_message, "text/html")
    return email.send(fail_silently=False)


def send_templated_runtime_email(
    *,
    template: EmailTemplateKey,
    recipient_list: list[str],
    language: str | None = None,
    context: dict[str, object] | None = None,
) -> int:
    subject, message, html_message = render_templated_email(
        template,
        language=language,
        context=context,
    )
    return send_runtime_email(
        subject=subject,
        message=message,
        html_message=html_message,
        recipient_list=recipient_list,
    )


def send_notification_runtime_email(
    *,
    subject: str,
    title: str,
    intro: str,
    footer: str,
    recipient_list: list[str],
    language: str | None = None,
    action_label: str = "",
    action_url: str = "",
) -> int:
    normalized_language = normalize_email_language(language)
    link_line = f"{action_label}: {action_url}" if action_label and action_url else ""
    copy = RuntimeEmailCopy(
        subject=subject,
        title=title,
        intro="\n\n".join(value for value in (intro, link_line) if value),
        footer=footer,
        preheader=intro,
    )
    context: dict[str, str] = {}
    html_message = html_email_body(copy, context, normalized_language)
    if link_line:
        safe_url = escape(action_url, quote=True)
        safe_label = escape(action_label)
        html_message = html_message.replace(
            escape(link_line),
            f'<a href="{safe_url}" style="color: {BRAND_COLOR_DARK}; '
            f'font-weight: 700;">{safe_label}</a>',
        )
    return send_runtime_email(
        subject=subject,
        message=text_email_body(copy, context),
        recipient_list=recipient_list,
        html_message=html_message,
    )
