def planner_settings_default() -> dict:
    return {
        "deadline": None,
        "dailyWordGoal": 0,
        "manuscriptWordGoal": 0,
    }


def dashboard_settings_default() -> dict:
    return {
        "widgetOrder": [],
        "hiddenWidgets": [],
    }


def planner_metadata_default() -> dict:
    return {
        "role": "untyped",
        "synopsis": "",
        "deadline": None,
        "wordGoal": 0,
        "statusId": None,
        "completedDate": None,
    }
