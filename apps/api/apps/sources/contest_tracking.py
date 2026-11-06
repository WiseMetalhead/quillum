from __future__ import annotations

from .models import ContestDatePrecision, ContestParticipation


def contest_deadlines_payload(manuscript) -> list[dict[str, object]]:
    participations = (
        ContestParticipation.objects.filter(
            manuscript=manuscript,
            track_deadlines=True,
            contest__detail__last_succeeded_at__isnull=False,
        )
        .select_related("contest", "contest__detail")
        .prefetch_related("contest__detail__phases")
    )
    contests: list[dict[str, object]] = []
    for participation in participations:
        contest = participation.contest
        phases = [
            {
                "key": phase.key,
                "kind": phase.kind,
                "label": phase.label,
                "startsOn": phase.starts_on.isoformat() if phase.starts_on else None,
                "endsOn": phase.ends_on.isoformat() if phase.ends_on else None,
                "deadlineAt": phase.deadline_at.isoformat() if phase.deadline_at else None,
                "precision": phase.precision,
            }
            for phase in contest.detail.phases.all()
            if phase.precision != ContestDatePrecision.UNPARSED
            and (phase.starts_on or phase.ends_on or phase.deadline_at)
        ]
        if phases:
            contests.append(
                {
                    "contestId": str(contest.public_id),
                    "contestTitle": contest.title,
                    "phases": phases,
                }
            )
    return contests
