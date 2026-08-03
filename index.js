const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ── CONFIG ──
const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = `https://api.telegram.org/bot${TOKEN}`;

// ── FIREBASE ──
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── FILAS VÁLIDAS ──
const filasValidas = new Set();
for (let i = 1; i <= 100; i++) filasValidas.add(`CG-F${i}`);  // Cámara Grande hasta F100
for (let i = 1; i <= 97;  i++) filasValidas.add(`GP-F${i}`);
for (let i = 1; i <= 28;  i++) filasValidas.add(`CC-F${i}`);

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

// ── NORMALIZAR ARTÍCULO Y LOTE ──
// Artículo: sacar prefijo 901 si tiene más de 7 dígitos
function normArticulo(art) {
  if (art.startsWith('901') && art.length > 7) return art.slice(3);
  return art;
}
// Lote: puede venir con ceros adelante (000035911088) o sin (35911088)
// Buscar ambas versiones
function normLotes(lote) {
  const sinCeros = lote.replace(/^0+/, '') || lote;
  const conCeros = lote.padStart(12, '0');
  const set = new Set([lote, sinCeros, conCeros]);
  return [...set];
}

// ── PARSEAR MENSAJE ──
// Formatos soportados:
//   MP:  GP-F23 OC79120135          → asigna fila a OC de MP
//   PT:  GP-F23 5041038 35907013    → asigna fila a art+lote PT, y todos los del mismo remito
//   Consulta MP:  OC79120135
//   Consulta PT:  5041038 35907013  (sin fila)
function parsearMensaje(texto) {
  // Limpiar: quitar caracteres raros, normalizar espacios
  const limpio = texto.trim().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ');
  const partes = limpio.split(' ').filter(p => p.length > 0);

  let fila = null;
  const resto = [];

  for (const p of partes) {
    // Fila: CG-F17, GP-F23, CC-F5 (con o sin guion, flexible)
    const filaMatch = p.toUpperCase().match(/^(CG|GP|CC)-?F(\d+)$/);
    if (filaMatch) {
      fila = filaMatch[1] + '-F' + filaMatch[2];
    } else {
      resto.push(p);
    }
  }

  console.log('Parser: fila=' + fila + ' resto=' + JSON.stringify(resto));

  // ¿Tiene OC? → es MP
  const ocPart = resto.find(p => /^OC\d+/i.test(p));
  if (ocPart) {
    return { tipo: fila ? 'mp_guardar' : 'mp_consultar', fila, oc: ocPart.toUpperCase().replace(/^OC/,'') };
  }

  // Solo números → PT (art + lote) o MP (OC sin prefijo)
  const nums = resto.filter(p => /^\d+$/.test(p));

  if (nums.length >= 2) {
    // 2 números → PT: artículo + lote
    return { tipo: fila ? 'pt_guardar' : 'pt_consultar', fila, articulo: nums[0], lote: nums[1] };
  }

  if (nums.length === 1 && nums[0].length >= 7) {
    // 1 número largo → OC de MP sin prefijo
    return { tipo: fila ? 'mp_guardar' : 'mp_consultar', fila, oc: nums[0] };
  }

  return null;
}

// ── WEBHOOK ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  if (!update.message) return;

  const msg    = update.message;
  const chatId = msg.chat.id;
  const texto  = msg.text || '';
  const nombre = msg.from.first_name || 'Operario';

  if (String(chatId) !== String(CHAT_ID)) return;
  if (msg.from.is_bot) return;

  const parsed = parsearMensaje(texto);

  if (!parsed) {
    const pareceIntento = /OC|F-\d|GP|CG|CC|\d{7}/i.test(texto);
    if (pareceIntento) {
      await enviarMensaje(chatId,
        `❓ <b>Formato incorrecto</b>\n\n` +
        `<b>MP:</b> <code>GP-F23 OC79120135</code>\n` +
        `<b>PT:</b> <code>GP-F23 5041038 35907013</code>\n` +
        `  (fila · artículo · lote)\n\n` +
        `<b>Consultar MP:</b> <code>OC79120135</code>\n` +
        `<b>Consultar PT:</b> <code>5041038 35907013</code>`
      );
    }
    return;
  }

  // Validar fila si corresponde
  if (parsed.fila && !filasValidas.has(parsed.fila)) {
    await enviarMensaje(chatId,
      `❌ <b>${parsed.fila}</b> no es una fila válida.\n` +
      `CG-F1 a CG-F100 · GP-F1 a GP-F97 · CC-F1 a CC-F28`
    );
    return;
  }

  // ════════════════════════════
  // MP — CONSULTA
  // ════════════════════════════
  if (parsed.tipo === 'mp_consultar') {
    const snap = await db.collection('mp').get();
    const docs = snap.docs.filter(d => {
      const data = d.data();
      return (data.oc === parsed.oc || data.oc === 'OC' + parsed.oc) && !data.fe;
    });
    if (!docs.length) {
      await enviarMensaje(chatId, `❓ OC <b>${parsed.oc}</b> no encontrada.`); return;
    }
    const filas = {};
    docs.forEach(d => { const f = d.data().fila || 'Sin asignar'; filas[f] = (filas[f]||0)+1; });
    let resp = `📦 <b>OC${parsed.oc}</b> — ${docs[0].data().nom||''}\n`;
    Object.entries(filas).forEach(([f,c]) => resp += `📍 ${f}: ${c} lote(s)\n`);
    resp += `Total: ${docs.length} lote(s) activo(s)`;
    await enviarMensaje(chatId, resp);
    return;
  }

  // ════════════════════════════
  // MP — GUARDAR FILA
  // ════════════════════════════
  if (parsed.tipo === 'mp_guardar') {
    try {
      const snap = await db.collection('mp').get();
      const activos = snap.docs.filter(d => {
        const data = d.data();
        return (data.oc === parsed.oc || data.oc === 'OC' + parsed.oc) && (!data.fe || data.fe === '');
      });
      if (activos.length > 0) {
        const batch = db.batch();
        activos.forEach(doc => batch.update(doc.ref, { fila: parsed.fila, fila_actualizada_por: nombre, fila_fecha: new Date().toISOString() }));
        await batch.commit();
        await enviarMensaje(chatId,
          `✅ <b>OC${parsed.oc}</b> → <b>${parsed.fila}</b>\n` +
          `📦 ${activos[0].data().nom || ''}\n` +
          `📊 ${activos.length} lote(s) actualizados\n` +
          `👤 ${nombre} — ${fechaHoy()}`
        );
      } else {
        await db.collection('ubicaciones_bot').add({ oc: parsed.oc, fila: parsed.fila, operario: nombre, fecha: new Date().toISOString() });
        await enviarMensaje(chatId, `⚠️ OC${parsed.oc} → ${parsed.fila} guardado (OC no encontrada en sistema)\n👤 ${nombre}`);
      }
    } catch (err) {
      console.error(err);
      await enviarMensaje(chatId, `⚠️ Error al guardar. Intentá de nuevo.`);
    }
    return;
  }

  // ════════════════════════════
  // PT — CONSULTA (art + lote)
  // ════════════════════════════
  if (parsed.tipo === 'pt_consultar') {
    const artNorm = normArticulo(parsed.articulo);
    const lotesVariantes = normLotes(parsed.lote);
    let snap = { empty: true, docs: [] };
    for (const lv of lotesVariantes) {
      const s = await db.collection('pt_lotes')
        .where('articulo', '==', artNorm)
        .where('lote', '==', lv)
        .get();
      if (!s.empty) { snap = s; break; }
    }
    if (snap.empty) {
      await enviarMensaje(chatId, `❓ Art <b>${artNorm}</b> lote <b>${parsed.lote}</b> no encontrado.`); return;
    }
    const data = snap.docs[0].data();
    const fila = data.fila || 'Sin asignar';
    const saldo = data.bultos || 0;
    await enviarMensaje(chatId,
      `📦 <b>Art: ${parsed.articulo}</b>\n` +
      `🏷 Lote: ${parsed.lote}\n` +
      `📍 Ubicación: <b>${fila}</b>\n` +
      `📊 Bultos en stock: ${saldo}`
    );
    return;
  }

  // ════════════════════════════
  // PT — GUARDAR FILA
  // Busca el lote → obtiene el remito → actualiza todos los lotes
  // del mismo artículo con ese remito
  // ════════════════════════════
  if (parsed.tipo === 'pt_guardar') {
    try {
      // 1. Buscar el lote específico para obtener el remito
      const artNorm = normArticulo(parsed.articulo);

      const lotesVariantes = normLotes(parsed.lote);
      let snapLote = { empty: true, docs: [] };
      for (const lv of lotesVariantes) {
        const s = await db.collection('pt_lotes')
          .where('articulo', '==', artNorm)
          .where('lote', '==', lv)
          .get();
        if (!s.empty) { snapLote = s; break; }
      }

      if (snapLote.empty) {
        await enviarMensaje(chatId,
          `❓ Art <b>${artNorm}</b> lote <b>${parsed.lote}</b> no encontrado en PT.`
        );
        return;
      }

      const loteData = snapLote.docs[0].data();
      const remito   = loteData.remito || null;

      if (!remito) {
        // Sin remito: actualizar solo ese lote
        await snapLote.docs[0].ref.update({ fila: parsed.fila, fila_actualizada_por: nombre, fila_fecha: new Date().toISOString() });
        await enviarMensaje(chatId,
          `✅ <b>Art: ${artNorm}</b> lote <b>${parsed.lote}</b> → <b>${parsed.fila}</b>\n` +
          `(Sin remito asociado, solo este lote actualizado)\n` +
          `👤 ${nombre} — ${fechaHoy()}`
        );
        return;
      }

      // 2. Buscar todos los lotes del mismo artículo con ese remito
      const snapRemito = await db.collection('pt_lotes')
        .where('articulo', '==', artNorm)
        .where('remito', '==', remito)
        .get();

      // Filtrar los que no tienen egreso total
      const activos = snapRemito.docs.filter(d => !d.data().fe);

      if (!activos.length) {
        await enviarMensaje(chatId, `❓ No hay lotes activos del art <b>${artNorm}</b> con remito <b>${remito}</b>.`);
        return;
      }

      // 3. Actualizar todos
      const batch = db.batch();
      activos.forEach(doc => batch.update(doc.ref, { fila: parsed.fila, fila_actualizada_por: nombre, fila_fecha: new Date().toISOString() }));
      await batch.commit();

      await enviarMensaje(chatId,
        `✅ <b>Art: ${artNorm}</b> → <b>${parsed.fila}</b>\n` +
        `📋 Remito: ${remito}\n` +
        `📊 ${activos.length} lote(s) del mismo remito actualizados\n` +
        `👤 ${nombre} — ${fechaHoy()}`
      );

    } catch (err) {
      console.error(err);
      await enviarMensaje(chatId, `⚠️ Error al guardar. Intentá de nuevo.`);
    }
    return;
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Bot Depósito MM activo ✅'));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
