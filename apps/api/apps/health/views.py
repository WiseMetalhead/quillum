from django.db import connection
from django.http import JsonResponse


def healthcheck(_request):
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        cursor.fetchone()

    return JsonResponse({"status": "ok"})

