# Bot Depósito MM

Bot de Telegram para registrar ubicaciones de mercadería en Firebase.

## Variables de entorno (configurar en Render)

| Variable | Valor |
|---|---|
| `TELEGRAM_TOKEN` | Token del bot (de @BotFather) |
| `TELEGRAM_CHAT_ID` | ID del grupo (-5243908686) |
| `FIREBASE_KEY` | JSON completo de la service account de Firebase |

## Cómo usa el operario

Escribir en el grupo:
```
GP-F23 OC79120135
```

El bot responde:
```
✅ OC79120135 registrada en GP-F23
📦 TAPAS EASYOPEN
👤 Victor — 08/06/2026 09:14
```

## Configurar webhook (una sola vez)

Después de desplegar en Render, abrir en el navegador:
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<tu-app>.onrender.com/webhook
```
