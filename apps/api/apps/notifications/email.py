from __future__ import annotations

from django.conf import settings

from apps.accounts.email import send_notification_runtime_email

COPY = {
    "service.password_stale": {
        "en": (
            "Update your Quillum password",
            "Password update recommended",
            "Your local Quillum password has not been changed for more than 90 days.",
        ),
        "ru": (
            "Обновите пароль Quillum",
            "Рекомендуется обновить пароль",
            "Ваш локальный пароль Quillum не менялся более 90 дней.",
        ),
    },
    "service.two_factor_missing": {
        "en": (
            "Protect your Quillum account",
            "Enable two-factor authentication",
            "Two-factor authentication is not enabled for your local Quillum login.",
        ),
        "ru": (
            "Защитите аккаунт Quillum",
            "Включите двухфакторную аутентификацию",
            "Для локального входа в Quillum не включена двухфакторная аутентификация.",
        ),
    },
    "service.storage_near_limit": {
        "en": (
            "Quillum storage is almost full",
            "Storage usage reached 90%",
            "Your stored media is approaching the limit for the current tier.",
        ),
        "ru": (
            "Хранилище Quillum почти заполнено",
            "Использовано 90% хранилища",
            "Сохранённые медиа приближаются к лимиту текущего уровня.",
        ),
    },
    "service.tier_changed": {
        "en": (
            "Your Quillum tier changed",
            "Account tier updated",
            "Your account tier has been changed.",
        ),
        "ru": (
            "Уровень Quillum изменён",
            "Уровень аккаунта обновлён",
            "Уровень вашего аккаунта был изменён.",
        ),
    },
    "service.new_login": {
        "en": (
            "New Quillum sign-in",
            "New sign-in to your account",
            "A new successful sign-in to your Quillum account was recorded.",
        ),
        "ru": (
            "Новый вход в Quillum",
            "Новый вход в аккаунт",
            "Зафиксирован новый успешный вход в ваш аккаунт Quillum.",
        ),
    },
    "service.account_export_ready": {
        "en": (
            "Your Quillum account export is ready",
            "Account export ready",
            "Your account content archive is ready to download for 7 days.",
        ),
        "ru": (
            "Экспорт аккаунта Quillum готов",
            "Экспорт аккаунта готов",
            "Архив с содержимым аккаунта готов и доступен для скачивания 7 дней.",
        ),
    },
    "service.editor_manuscript_access_granted": {
        "en": (
            "A manuscript is available in Quillum",
            "Editorial access granted",
            "An Author granted you access to a manuscript.",
        ),
        "ru": (
            "Рукопись доступна в Quillum",
            "Открыт редакторский доступ",
            "Автор открыл вам доступ к рукописи.",
        ),
    },
    "service.editor_manuscript_access_revoked": {
        "en": (
            "Manuscript access changed in Quillum",
            "Editorial access revoked",
            "An Author revoked your access to a manuscript.",
        ),
        "ru": (
            "Доступ к рукописи изменён в Quillum",
            "Редакторский доступ отозван",
            "Автор отозвал ваш доступ к рукописи.",
        ),
    },
    "user.manuscript_deadline": {
        "en": (
            "Manuscript deadline",
            "A manuscript deadline is approaching",
            "A selected manuscript is approaching its final deadline.",
        ),
        "ru": (
            "Дедлайн рукописи",
            "Приближается дедлайн рукописи",
            "Приближается финальный срок выбранной рукописи.",
        ),
    },
    "user.item_deadline": {
        "en": (
            "Part deadline",
            "A manuscript part deadline is approaching",
            "A selected manuscript part is approaching its deadline.",
        ),
        "ru": (
            "Дедлайн части",
            "Приближается дедлайн части рукописи",
            "Приближается срок выбранной части рукописи.",
        ),
    },
    "user.task_deadline": {
        "en": (
            "Task deadline",
            "A writing task is due soon",
            "An unfinished Planner task is approaching its deadline.",
        ),
        "ru": (
            "Дедлайн задачи",
            "Приближается срок задачи",
            "Приближается срок незавершённой задачи Планировщика.",
        ),
    },
    "user.review_comment": {
        "en": (
            "New Public Review comment",
            "A guest left a review comment",
            "A guest added a comment or reply through Public Review.",
        ),
        "ru": (
            "Новый комментарий Public Review",
            "Гость оставил комментарий",
            "Гость добавил комментарий или ответ через Public Review.",
        ),
    },
    "user.daily_goal": {
        "en": (
            "Daily writing goal",
            "Your daily writing progress",
            "Your selected manuscript has a daily writing-goal update.",
        ),
        "ru": (
            "Дневная цель",
            "Прогресс дневной цели",
            "Обновлён прогресс дневной цели выбранной рукописи.",
        ),
    },
    "user.manuscript_digest": {
        "en": (
            "Manuscript digest",
            "Your manuscript summary",
            "A scheduled summary is ready for your selected manuscript.",
        ),
        "ru": (
            "Сводка по рукописи",
            "Сводка по выбранной рукописи",
            "Готова запланированная сводка по выбранной рукописи.",
        ),
    },
}

TIER_NAMES = {
    "en": {
        "novice": "Novice",
        "author": "Author",
        "believer": "Believer",
        "god": "God",
    },
    "ru": {
        "novice": "Новичок",
        "author": "Автор",
        "believer": "Сторонник",
        "god": "God",
    },
}


def send_notification_email(notification) -> int:
    language = "ru" if notification.recipient.language == "ru" else "en"
    subject, title, intro = COPY[notification.kind][language]
    payload = notification.payload
    if notification.kind == "service.new_login" and payload.get("ipAddress"):
        intro += (" IP: " if language == "en" else " IP: ") + str(payload["ipAddress"])
    elif notification.kind == "service.tier_changed":
        names = TIER_NAMES[language]
        previous = names.get(str(payload.get("previousTier", "")), "")
        next_tier = names.get(str(payload.get("nextTier", "")), "")
        intro += f" {previous} → {next_tier}."
    elif notification.kind == "service.storage_near_limit":
        used = int(payload.get("usedBytes", 0)) // (1024 * 1024)
        limit = int(payload.get("limitBytes", 0)) // (1024 * 1024)
        intro += f" {used} / {limit} MiB."
    elif notification.kind == "service.account_export_ready":
        file_name = str(payload.get("fileName", "")).strip()
        if file_name:
            intro += f" {file_name}."
    elif notification.kind in {
        "service.editor_manuscript_access_granted",
        "service.editor_manuscript_access_revoked",
    }:
        author_name = str(payload.get("authorName", "")).strip()
        manuscript_title = str(payload.get("manuscriptTitle", "")).strip()
        if author_name and manuscript_title:
            if language == "ru":
                intro += f" {author_name}: «{manuscript_title}»."
            else:
                intro += f" {author_name}: “{manuscript_title}”."
    elif notification.kind in {
        "user.manuscript_deadline",
        "user.item_deadline",
        "user.task_deadline",
    }:
        title_value = (
            payload.get("taskTitle") or payload.get("itemTitle") or payload.get("manuscriptTitle")
        )
        intro += f" {title_value}. {payload.get('deadline', '')}."
    elif notification.kind == "user.review_comment":
        guest_name = str(payload.get("guestName", "")).strip()
        if not guest_name:
            guest_name = "Гость" if language == "ru" else "Guest"
        intro += f" {guest_name}: {payload.get('excerpt', '')}"
    elif notification.kind == "user.daily_goal":
        written = int(payload.get("writtenWords", 0))
        goal = int(payload.get("goalWords", 0))
        if language == "ru":
            intro += f" Написано {written} из {goal} слов."
        else:
            intro += f" {written} of {goal} words written."
    elif notification.kind == "user.manuscript_digest":
        total = int(payload.get("totalWords", 0))
        deadlines = len(payload.get("deadlines", [])) + int(payload.get("remainingDeadlines", 0))
        tasks = len(payload.get("tasks", [])) + int(payload.get("remainingTasks", 0))
        if language == "ru":
            intro += f" Всего слов: {total}. Ближайших дедлайнов: {deadlines}. Задач: {tasks}."
        else:
            intro += f" Total words: {total}. Upcoming deadlines: {deadlines}. Tasks: {tasks}."
    action_path = str(payload.get("actionPath", ""))
    action_url = (
        f"{settings.QUILLUM_PUBLIC_ORIGIN}{action_path}" if action_path.startswith("/") else ""
    )
    if notification.kind == "service.account_export_ready":
        action_label = "Open account export" if language == "en" else "Открыть экспорт аккаунта"
    elif notification.kind == "service.editor_manuscript_access_granted":
        action_label = "Open manuscript" if language == "en" else "Открыть рукопись"
    elif notification.kind == "service.editor_manuscript_access_revoked":
        action_label = (
            "Open available manuscripts"
            if language == "en"
            else "Открыть доступные рукописи"
        )
    else:
        action_label = "Open Quillum" if language == "en" else "Открыть Quillum"
    return send_notification_runtime_email(
        subject=subject,
        title=title,
        intro=intro,
        footer=(
            (
                "Quillum sent this notification because it is enabled "
                "in your notification settings."
                if language == "en"
                else "Quillum отправил это уведомление согласно вашим настройкам уведомлений."
            )
            if notification.category == "user"
            else (
                "Quillum sent this service notification for your account."
                if language == "en"
                else "Quillum отправил это сервисное уведомление для вашего аккаунта."
            )
        ),
        recipient_list=[notification.recipient.email],
        language=language,
        action_label=action_label,
        action_url=action_url,
    )
