const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ── CONFIG ──
const TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;          // chat/grupo autorizado a mandar fotos
const API_URL  = `https://api.telegram.org/bot${TOKEN}`;
const FILE_URL = `https://api.telegram.org/file/bot${TOKEN}`;

// Envío de mail por HTTP (Resend) — evita el bloqueo de SMTP saliente de Render free.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev'; // dominio de prueba de Resend
const DEST_EMAIL = process.env.DEST_EMAIL; // depo5dibiagi@gmail.com

// Guarda el último texto mandado por chat, por si el operario manda
// primero el texto (asunto) y después la(s) foto(s) sueltas.
const ultimoTextoPorChat = new Map(); // chatId -> { texto, ts }
const TTL_MS = 10 * 60 * 1000; // 10 minutos

function guardarTexto(chatId, texto) {
  ultimoTextoPorChat.set(chatId, { texto, ts: Date.now() });
}

function tomarTextoDeRespaldo(chatId) {
  const entry = ultimoTextoPorChat.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    ultimoTextoPorChat.delete(chatId);
    return null;
  }
  return entry.texto;
}

// ── HELPERS ──
function enviarMensaje(chatId, texto) {
  return axios.post(`${API_URL}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML',
  }).catch(err => console.error('Error enviando mensaje a Telegram:', err.message));
}

async function descargarFoto(fileId) {
  const { data } = await axios.get(`${API_URL}/getFile`, { params: { file_id: fileId } });
  const filePath = data.result.file_path;
  const resp = await axios.get(`${FILE_URL}/${filePath}`, { responseType: 'arraybuffer' });
  const nombre = filePath.split('/').pop();
  return { buffer: Buffer.from(resp.data), nombre };
}

async function reenviarPorMail({ asunto, cuerpo, nombreArchivo, buffer }) {
  await axios.post(
    'https://api.resend.com/emails',
    {
      from: RESEND_FROM,
      to: [DEST_EMAIL],
      subject: asunto,
      text: cuerpo,
      attachments: [
        {
          filename: nombreArchivo,
          content: buffer.toString('base64'),
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ── WEBHOOK ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Telegram, procesar después

  const update = req.body;
  if (!update.message) return;

  const msg    = update.message;
  const chatId = msg.chat.id;

  if (CHAT_ID && String(chatId) !== String(CHAT_ID)) return;
  if (msg.from.is_bot) return;

  try {
    // ── Mensaje con foto ──
    if (msg.photo && msg.photo.length > 0) {
      const fotoMasGrande = msg.photo[msg.photo.length - 1];
      const asunto = (msg.caption || tomarTextoDeRespaldo(chatId) || '').trim();

      if (!asunto) {
        await enviarMensaje(chatId,
          '⚠️ Mandá primero el texto de la carga (ej: <code>Juan Pablo - 20260919 - Diaz 1 pallets - PALLET</code>) ' +
          'como descripción de la foto, o como mensaje aparte antes de la foto.'
        );
        return;
      }

      const { buffer, nombre } = await descargarFoto(fotoMasGrande.file_id);

      await reenviarPorMail({
        asunto,
        cuerpo: `Foto recibida por Telegram.\nDescripción: ${asunto}`,
        nombreArchivo: nombre,
        buffer,
      });

      await enviarMensaje(chatId, `✅ Foto reenviada: <b>${asunto}</b>`);
      return;
    }

    // ── Mensaje de solo texto: se guarda como respaldo para la próxima foto ──
    if (msg.text) {
      guardarTexto(chatId, msg.text.trim());
      await enviarMensaje(chatId, '📝 Texto recibido. Mandá la(s) foto(s) ahora.');
      return;
    }
  } catch (err) {
    console.error('Error procesando mensaje:', err.response ? err.response.data : err.message);
    await enviarMensaje(chatId, '⚠️ Hubo un error reenviando la foto. Probá de nuevo.');
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Bot Depósito — reenvío de fotos a mail ✅'));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
