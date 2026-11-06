from datetime import UTC, date, datetime

import pytest

from .adapters.author_today import parse_author_today_news
from .adapters.author_today_contests import (
    parse_author_today_contest_detail,
    parse_author_today_contests,
)
from .adapters.base import SourceParseError


def _article(
    post_id: str = "42",
    *,
    title: str = "A project update",
    author: str = "Editorial team",
    summary: str = "Short <strong>formatted</strong> announcement.",
    published_at: str = "2026-09-08T08:15:00Z",
) -> str:
    return f"""
    <article id="post_{post_id}" class="feed-row post">
      <header>
        <h3 class="post-title"><a href="/post/{post_id}">{title}</a></h3>
        <time>
          <span>Author: <a href="/u/editor/posts">{author}</a></span>
          <span pubdate data-time="{published_at}"></span>
        </time>
      </header>
      <div class="rich-content fr-view">{summary}</div>
    </article>
    """


def test_parse_author_today_news_normalizes_public_card():
    items = parse_author_today_news(f"<main>{_article()}</main>")

    assert len(items) == 1
    assert items[0].external_id == "42"
    assert items[0].canonical_url == "https://author.today/post/42"
    assert items[0].title == "A project update"
    assert items[0].author_name == "Editorial team"
    assert items[0].summary == "Short formatted announcement."
    assert items[0].published_at == datetime(2026, 9, 8, 8, 15, tzinfo=UTC)


def test_parse_author_today_news_limits_initial_page_to_twenty_items():
    document = "<main>" + "".join(_article(str(index)) for index in range(1, 22)) + "</main>"

    items = parse_author_today_news(document)

    assert len(items) == 20
    assert items[-1].external_id == "20"


@pytest.mark.parametrize(
    "document",
    [
        "<main></main>",
        '<article id="post_42"><h3 class="post-title"><a href="/post/42">Title</a></h3></article>',
        f"<main>{_article(published_at='not-a-date')}</main>",
        f"<main>{_article(post_id='not-numeric')}</main>",
    ],
)
def test_parse_author_today_news_rejects_structurally_invalid_page(document):
    with pytest.raises(SourceParseError):
        parse_author_today_news(document)


def test_parse_author_today_news_rejects_mismatched_post_url():
    document = _article().replace('href="/post/42"', 'href="/post/43"', 1)

    with pytest.raises(SourceParseError):
        parse_author_today_news(document)


def _contest_card(
    contest_id: str = "45",
    *,
    title: str = "A writing contest",
    description: str = "A <strong>short</strong> description.",
    status: str = "прием работ, 12 участников",
    status_class: str = "",
    discussion: bool = True,
    action: str = "works",
) -> str:
    discussion_link = '<a href="/post/931906">Обсуждение</a>' if discussion else ""
    action_link = f'<a href="/contest/{contest_id}/{action}">Действие</a>' if action else ""
    return f"""
    <div class="contest-wrapper">
      <div class="contest-description">
        <h2><a href="/contest/{contest_id}">{title}</a></h2>
        <label class="{status_class}">{status}</label>
        <p>{description}</p>
        <div class="contest-btns">
          <a href="/contest/{contest_id}">Описание</a>
          {discussion_link}
          {action_link}
        </div>
      </div>
    </div>
    """


@pytest.mark.parametrize(
    ("source_status", "normalized_status"),
    [
        ("прием работ, 1 участник", "accepting"),
        ("подготовка к следующему этапу", "preparation"),
        ("в работе", "in_progress"),
        ("завершен, 12 участников", "finished"),
    ],
)
def test_parse_author_today_contests_normalizes_stages(source_status, normalized_status):
    item = parse_author_today_contests(f"<main>{_contest_card(status=source_status)}</main>")[0]

    assert item.external_id == "45"
    assert item.canonical_url == "https://author.today/contest/45"
    assert item.title == "A writing contest"
    assert item.description == "A short description."
    assert item.status == normalized_status
    assert item.discussion_url == "https://author.today/post/931906"
    assert item.action_kind == "works"
    assert item.action_url == "https://author.today/contest/45/works"
    assert item.source_position == 0


def test_parse_author_today_contests_uses_source_stage_class_when_label_omits_text():
    item = parse_author_today_contests(
        _contest_card(status="215 участников", status_class="label label-primary mb-sm")
    )[0]

    assert item.status == "in_progress"


def test_parse_author_today_contests_supports_results_and_optional_links():
    item = parse_author_today_contests(
        _contest_card(
            status="завершен",
            discussion=False,
            action="results",
        )
    )[0]

    assert item.discussion_url == ""
    assert item.action_kind == "results"
    assert item.action_url == "https://author.today/contest/45/results"


def test_parse_author_today_contests_limits_first_page_to_twenty_cards():
    document = "<main>" + "".join(_contest_card(str(index)) for index in range(1, 22)) + "</main>"

    items = parse_author_today_contests(document)

    assert len(items) == 20
    assert items[-1].external_id == "20"
    assert items[-1].source_position == 19


@pytest.mark.parametrize(
    "document",
    [
        "<main></main>",
        _contest_card().replace("<p>A <strong>short</strong> description.</p>", ""),
        _contest_card(status="неизвестный этап"),
        _contest_card() + _contest_card(),
        _contest_card().replace('/contest/45">Описание', '/contest/46">Описание'),
        _contest_card().replace('href="/contest/45"', 'href="http://example.com/contest/45"', 1),
    ],
)
def test_parse_author_today_contests_rejects_structurally_invalid_cards(document):
    with pytest.raises(SourceParseError):
        parse_author_today_contests(document)


def _contest_detail(*sections: str) -> str:
    return f"""
    <main>
      <div class="panel-body fr-view rich-content">
        {"".join(sections)}
      </div>
    </main>
    """


def test_parse_author_today_contest_detail_preserves_sections_and_normalizes_dates():
    detail = parse_author_today_contest_detail(
        _contest_detail(
            """
            <h2><strong>Требования к произведениям</strong></h2>
            <p>Только <strong>романы</strong> в жанре фэнтези.</p>
            <h2>Сроки проведения конкурса</h2>
            <p>Приём работ: с 7 сентября 2026 г. по 14 января 2027 г., включительно</p>
            <p>Формирование лонг-листа: январь-февраль 2027 г.</p>
            <p>Формирование шорт-листа: начало февраль 2027г.</p>
            <p>Оглашение результатов: март 2027 г.</p>
            <h2>Условия участия</h2>
            <p>Произведение должно быть завершено до 17-00 по мск 14.01.2027 г.</p>
            <p>Синопсисы принимаются до 17:00 по мск 14.01.2027 включительно.</p>
            """
        ),
        "45",
    )

    assert detail.external_id == "45"
    assert detail.conditions_sections[0] == {
        "kind": "requirements",
        "title": "Требования к произведениям",
        "text": "Только романы в жанре фэнтези.",
        "blocks": [{"type": "paragraph", "text": "Только романы в жанре фэнтези."}],
    }
    phases = {phase.key: phase for phase in detail.phases}
    assert phases["submission"].starts_on == date(2026, 9, 7)
    assert phases["submission"].ends_on == date(2027, 1, 14)
    assert phases["submission"].precision == "exact"
    assert phases["longlist"].starts_on == date(2027, 1, 1)
    assert phases["longlist"].ends_on == date(2027, 2, 28)
    assert phases["longlist"].precision == "month_range"
    assert phases["shortlist"].ends_on == date(2027, 2, 10)
    assert phases["shortlist"].precision == "approximate"
    assert phases["results"].ends_on == date(2027, 3, 31)
    assert phases["manuscript_completion"].deadline_at == datetime(2027, 1, 14, 14, 0, tzinfo=UTC)
    assert phases["synopsis"].deadline_at == datetime(2027, 1, 14, 14, 0, tzinfo=UTC)


def test_parse_author_today_contest_detail_extracts_facts_and_preserves_blocks():
    detail = parse_author_today_contest_detail(
        _contest_detail(
            """
            <h2>Сроки проведения конкурса</h2>
            <p>Приём работ: до 30.11.2026</p>
            <h2>Условия участия</h2>
            <p>Размер: от 280 000 до 1 000 000 знаков с пробелами.
            Минимальный объём текста для подачи заявки — 40 000 знаков.</p>
            <p>Ф<span>орма</span>: роман.</p>
            <p>Жанр: космическая фантастика. Дополнительные пояснения.</p>
            <p>Принимаются романы, соответствующие возрастному ограничению 18+.
            <br>Без иных ограничений.</p>
            <ul><li>Первое условие.</li><li>Второе условие.</li></ul>
            <h2>Требования к произведениям</h2>
            <p>От одного участника принимается одно произведение.</p>
            """
        ),
        "44",
    )

    facts = {fact["kind"]: fact for fact in detail.condition_facts}
    assert facts["form"]["value"] == "роман"
    assert facts["genre"]["value"] == "космическая фантастика"
    assert facts["length"]["min"] == 280_000
    assert facts["length"]["max"] == 1_000_000
    assert facts["submission_length"]["min"] == 40_000
    assert facts["age"]["value"] == "18+"
    assert facts["max_works"]["value"] == 1
    assert detail.conditions_sections[0]["blocks"][-1] == {
        "type": "list",
        "ordered": False,
        "items": ["Первое условие.", "Второе условие."],
    }
    assert detail.conditions_sections[0]["blocks"][3]["text"].endswith("18+. Без иных ограничений.")


def test_parse_author_today_contest_detail_uses_specific_supplemental_deadlines():
    detail = parse_author_today_contest_detail(
        _contest_detail(
            """
            <h2>Сроки проведения конкурса</h2><p>Приём работ: до 14.01.2027</p>
            <h2>Условия участия</h2>
            <p>Размер: от 360 000 до 520 000 знаков.
            Книга должна быть завершена до 14.01.2027 г.</p>
            <p>Произведение должно быть завершено до 17:00 по мск 14.01.2027 г.
            Готовый роман сопровождается синопсисом.</p>
            <p>Синопсисы принимаются до 17:00 по мск 16.01.2027 включительно.</p>
            """
        ),
        "45",
    )

    phases = {phase.key: phase for phase in detail.phases}
    assert phases["manuscript_completion"].raw_text.startswith("Произведение должно быть завершено")
    assert phases["manuscript_completion"].ends_on == date(2027, 1, 14)
    assert phases["synopsis"].raw_text.startswith("Синопсисы принимаются")
    assert phases["synopsis"].ends_on == date(2027, 1, 16)


def test_parse_author_today_contest_detail_keeps_unparsed_timeline_text():
    detail = parse_author_today_contest_detail(
        _contest_detail(
            "<h2>Сроки проведения конкурса</h2><p>Проверка работ: после завершения премодерации</p>"
        ),
        "45",
    )

    assert detail.phases[0].kind == "other"
    assert detail.phases[0].precision == "unparsed"
    assert detail.phases[0].raw_text == "Проверка работ: после завершения премодерации"


def test_parse_author_today_contest_detail_supports_numeric_date_range():
    detail = parse_author_today_contest_detail(
        _contest_detail(
            "<h2>Сроки проведения конкурса</h2><p>Приём работ: с 01.08.2026 по 14.01.2027</p>"
        ),
        "45",
    )

    assert detail.phases[0].starts_on == date(2026, 8, 1)
    assert detail.phases[0].ends_on == date(2027, 1, 14)


@pytest.mark.parametrize(
    "document",
    [
        "<main></main>",
        _contest_detail("<h2>Условия участия</h2><p>Текст</p>"),
        _contest_detail("<h2>Сроки проведения конкурса</h2>"),
    ],
)
def test_parse_author_today_contest_detail_rejects_damaged_markup(document):
    with pytest.raises(SourceParseError):
        parse_author_today_contest_detail(document, "45")
