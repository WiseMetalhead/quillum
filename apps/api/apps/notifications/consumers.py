from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .service import user_group


class NotificationConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        user = self.scope.get("user")
        if user is None or not user.is_authenticated or not user.is_active:
            await self.close(code=4401)
            return
        self.notification_group = user_group(user.id)
        await self.channel_layer.group_add(self.notification_group, self.channel_name)
        await self.accept()

    async def disconnect(self, _code):
        group = getattr(self, "notification_group", None)
        if group:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def notifications_changed(self, _event):
        await self.send_json({"type": "notifications.changed"})

