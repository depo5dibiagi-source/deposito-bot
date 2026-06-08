const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ── CONFIG ──
const TOKEN    = process.env.TELEGRAM_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const API_URL  = `https://api.telegram.org/bot${TOKEN}`;

// ── FIREBASE ──
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── FILAS VÁLIDAS ──
const filasValidas = new Set();
for (let i = 1; i <= 32; i++) filasValidas.add(`CG-F${i}`);
for (let i = 1; i <= 97; i++) filasValidas.add(`GP-F${i}`);
for (let i = 1; i <= 28; i++) filasValidas.add(`CC-F${i}`);

// ── HELPERS ──
function enviarMensaje(chatId, texto) {
  return axios.post(`${API_URL}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: 'HTML'
  }).catch(err => console.error('Error enviando mensaje:', err.message));
}

function fechaHoy() {
  return new Date().toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

function parsearMensaje(texto) {
  // Acepta: GP-F23 OC79120135 o OC79120135 GP-F23 (cualquier orden)
  const partes = texto.trim().toUpperCase().split(/\s+/);
  if (partes.length < 2) return null;

  let fila = null;
  let oc   = null;

  for (const p of partes) {
    if (/^(CG|GP|CC)-F\d+$/.test(p)) fila = p;
    else if (/^OC\d+(-\d+)?$/.test(p)) oc = p;
    else if (/^\d{7,8}(-\d+)?$/.test(p)) oc = `OC${p}`; // sin prefijo OC
  }

  return fila && oc ? { fila, oc } : null;
}

// ── WEBHOOK ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido a Telegram

  const update = req.body;
  if (!update.message) return;

  const msg    = update.message;
  const chatId = msg.chat.id;
  const texto  = msg.text || '';
  const nombre = msg.from.first_name || 'Operario';

  // Solo escuchar el grupo configurado
  // if (String(chatId) !== String(CHAT_ID)) return;

  // Ignorar mensajes del propio bot
  if (msg.from.is_bot) return;

  const parsed = parsearMensaje(texto);

  if (!parsed) {
    // Solo responder si parece que intentaron usar el bot
    const pareceIntento = /OC|F-\d|GP|CG|CC/i.test(texto);
    if (pareceIntento) {
      await enviarMensaje(chatId,
        `❓ <b>Formato incorrecto</b>\nEscribí: <code>FILA OC</code>\nEjemplo: <code>GP-F23 OC79120135</code>`
      );
    }
    return;
  }

  const { fila, oc } = parsed;

  // Validar fila
  if (!filasValidas.has(fila)) {
    await enviarMensaje(chatId,
      `❌ <b>${fila}</b> no es una fila válida.\nUsá: CG-F1 a CG-F32, GP-F1 a GP-F97, CC-F1 a CC-F28`
    );
    return;
  }

  // Buscar lotes en Firebase por número de OC
  // Actualiza TODOS los lotes activos de esa OC con la nueva fila
  try {
    const ocBase = oc.replace(/^OC/i, '').split('-')[0];

    // Buscar por campo 'oc' (como lo guarda la app)
    let snap = await db.collection('mp')
      .where('oc', '==', ocBase)
      .get();

    // Si no encontró, intentar con el prefijo OC incluido
    if (snap.empty) {
      snap = await db.collection('mp')
        .where('oc', '==', 'OC' + ocBase)
        .get();
    }

    // Filtrar solo los activos (sin fecha de egreso)
    const activos = snap.empty ? [] : snap.docs.filter(d => {
      const fe = d.data().fe;
      return !fe || fe === '' || fe === null;
    });

    if (activos.length > 0) {
      // Actualizar fila en TODOS los lotes activos de la OC
      const batch = db.batch();
      activos.forEach(doc => {
        batch.update(doc.ref, {
          fila: fila,
          fila_actualizada_por: nombre,
          fila_fecha: new Date().toISOString()
        });
      });
      await batch.commit();

      const dato = activos[0].data();
      const loteNombre = dato.nom || dato.oc || oc;

      await enviarMensaje(chatId,
        `✅ <b>${oc}</b> → <b>${fila}</b>\n` +
        `📦 ${loteNombre}\n` +
        `📊 ${activos.length} lote(s) actualizados\n` +
        `👤 ${nombre} — ${fechaHoy()}`
      );
    } else {
      // Lote no encontrado — guardar igual en colección aparte
      await db.collection('ubicaciones_bot').add({
        oc: oc,
        fila: fila,
        operario: nombre,
        fecha: new Date().toISOString(),
        encontrado_en_mp: false
      });

      await enviarMensaje(chatId,
        `⚠️ <b>${oc}</b> → <b>${fila}</b> guardado\n` +
        `(OC no encontrada en el sistema)\n` +
        `👤 ${nombre} — ${fechaHoy()}`
      );
    }
  } catch (err) {
    console.error('Error Firebase:', err.message);
    await enviarMensaje(chatId,
      `⚠️ Error al guardar. Intentá de nuevo.`
    );
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Bot Depósito MM activo ✅'));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
