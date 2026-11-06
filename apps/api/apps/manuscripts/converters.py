from .models import Document, Manuscript, Series


class PublicPrimaryKey(int):
    def __new__(cls, value, public_id):
        instance = super().__new__(cls, value)
        instance.public_id = public_id
        return instance

    def __str__(self):
        return str(self.public_id)


class PublicIdConverter:
    regex = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    model = None

    def to_python(self, value):
        try:
            item = self.model.objects.only("id", "public_id").get(public_id=value)
            return PublicPrimaryKey(item.id, item.public_id)
        except self.model.DoesNotExist as exc:
            raise ValueError from exc

    def to_url(self, value):
        if hasattr(value, "public_id"):
            return str(value.public_id)
        return str(value)


class ManuscriptPublicIdConverter(PublicIdConverter):
    model = Manuscript


class SeriesPublicIdConverter(PublicIdConverter):
    model = Series


class DocumentPublicIdConverter(PublicIdConverter):
    model = Document
