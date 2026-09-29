require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'session');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

fs.mkdirSync(SESSION_DIR, { recursive: true });

let sock = null;
let authState = null;
let qrDataUrl = null;
let pairingCode = null;
let connectionState = 'desconectado';
let reconnectTimer = null;
const processing = new Set();

function getText(message) {
  const m = message?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function unwrapMessage(message) {
  let m = message?.message;
  if (!m) return null;

  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;

  return m;
}

function findMedia(message) {
  const m = unwrapMessage(message);
  if (!m) return null;

  if (m.imageMessage) return { type: 'image' };
  if (m.videoMessage) return { type: 'video' };
  return null;
}

function getQuotedMessage(message) {
  const ctx = message?.message?.extendedTextMessage?.contextInfo;
  return ctx?.quotedMessage ? {
    key: {
      remoteJid: message.key.remoteJid,
      id: ctx.stanzaId,
      participant: ctx.participant
    },
    message: ctx.quotedMessage
  } : null;
}

function isStickerCommand(text) {
  return /^(sticker|s|st)$/i.test(text.trim());
}

async function sendText(jid, text, quoted) {
  return sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}

async function createSticker(message, sourceMessage, mediaType) {
  const id = message.key.id;
  if (processing.has(id)) return;
  processing.add(id);

  const jid = message.key.remoteJid;

  try {
    await sock.sendMessage(jid, {
      react: { text: '⏳', key: message.key }
    });

    const buffer = await downloadMediaMessage(
      sourceMessage,
      'buffer',
      {},
      {
        logger: P({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      }
    );

    const sticker = new Sticker(buffer, {
      pack: 'el mejor bot',
      author: 'el mejor bot',
      type: mediaType === 'video' ? StickerTypes.FULL : StickerTypes.DEFAULT,
      quality: 80
    });

    const stickerBuffer = await sticker.toBuffer();

    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    await sock.sendMessage(jid, {
      react: { text: '✅', key: message.key }
    });
  } catch (error) {
    console.error('Error creando sticker:', error);
    await sendText(jid, '❌ No pude crear el sticker.', message).catch(() => {});
  } finally {
    processing.delete(id);
  }
}

async function handleMessage(update) {
  const message = update?.messages?.[0];
  if (!message || message.key?.fromMe) return;

  const text = getText(message);

  if (/^(menu|ayuda|help)$/i.test(text)) {
    return sendText(
      message.key.remoteJid,
      '🤖 *el mejor bot*\n\n📸 Imagen + *sticker*\n🎥 Video + *sticker*\n↩️ También puedes responder una imagen o video con *sticker*.',
      message
    );
  }

  if (!isStickerCommand(text)) return;

  const direct = findMedia(message);
  if (direct) {
    return createSticker(message, message, direct.type);
  }

  const quoted = getQuotedMessage(message);
  if (quoted) {
    const quotedMedia = findMedia(quoted);
    if (quotedMedia) {
      return createSticker(message, quoted, quotedMedia.type);
    }
  }

  return sendText(
    message.key.remoteJid,
    '📸 Mándame una imagen o video con *sticker*.',
    message
  );
}

async function startSocket() {
  if (sock && connectionState !== 'desconectado') return sock;

  authState = await useMultiFileAuthState(SESSION_DIR);
  connectionState = 'conectando';

  sock = makeWASocket({
    auth: authState.state,
    logger: P({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', authState.saveCreds);
  sock.ev.on('messages.upsert', handleMessage);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        qrDataUrl = await QRCode.toDataURL(qr);
        pairingCode = null;
      } catch (error) {
        console.error('Error generando QR:', error);
      }
    }

    if (connection === 'open') {
      connectionState = 'conectado';
      qrDataUrl = null;
      pairingCode = null;
      console.log('el mejor bot conectado');
    }

    if (connection === 'close') {
      connectionState = 'desconectado';
      sock = null;
      authState = null;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ||
        lastDisconnect?.error?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        qrDataUrl = null;
        pairingCode = null;
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        return;
      }

      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        startSocket().catch(error => console.error('Reconexión:', error));
      }, 3000);
    }
  });

  return sock;
}

app.get('/', (_req, res) => {
  const qr = qrDataUrl
    ? '<img src="' + qrDataUrl + '" alt="QR" style="width:280px;height:280px">'
    : '<p>No hay QR disponible.</p>';

  const code = pairingCode
    ? '<div style="font-size:30px;font-weight:bold;letter-spacing:5px;margin:20px">' + pairingCode + '</div>'
    : '<p>No hay código disponible.</p>';

  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>el mejor bot</title>
<style>
body{font-family:Arial,sans-serif;max-width:620px;margin:30px auto;padding:20px;text-align:center}
.card{border:1px solid #ddd;border-radius:14px;padding:20px;margin:15px 0}
input{padding:12px;width:90%;max-width:320px;margin:6px}
button{padding:12px 18px;border:0;border-radius:8px;cursor:pointer}
</style>
</head>
<body>
<h1>🤖 el mejor bot</h1>
<p>Estado: <b>${connectionState}</b></p>
<div class="card"><h2>QR</h2>${qr}</div>
<div class="card">
<h2>Código de 8 dígitos</h2>
<form method="POST" action="/iniciar">
<input name="numero" placeholder="521XXXXXXXXXX" required>
<br><button type="submit">Generar código</button>
</form>
${code}
</div>
<div class="card">
<form method="POST" action="/cerrar-sesion">
<button type="submit">Cerrar sesión</button>
</form>
</div>
</body>
</html>`);
});

app.get('/estado-vinculacion', (_req, res) => {
  res.json({
    conectado: connectionState === 'conectado',
    estado: connectionState,
    pairingCode
  });
});

app.post('/iniciar', async (req, res) => {
  const numero = String(req.body.numero || '').replace(/\D/g, '');

  if (!numero) return res.status(400).send('Número inválido.');

  try {
    const socket = await startSocket();

    if (authState?.state?.creds?.registered) {
      return res.redirect('/');
    }

    pairingCode = await socket.requestPairingCode(numero);
    qrDataUrl = null;
    res.redirect('/');
  } catch (error) {
    console.error('Error al generar código:', error);
    res.status(500).send('No se pudo generar el código.');
  }
});

app.post('/cerrar-sesion', async (_req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
  } finally {
    sock = null;
    authState = null;
    qrDataUrl = null;
    pairingCode = null;
    connectionState = 'desconectado';

    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch {}

    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  res.redirect('/');
});

app.get('/limpiar-whatsapp', async (_req, res) => {
  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
  } finally {
    sock = null;
    authState = null;
    qrDataUrl = null;
    pairingCode = null;
    connectionState = 'desconectado';

    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch {}

    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  res.json({ ok: true, mensaje: 'Sesión limpiada.' });
});

app.listen(PORT, () => {
  console.log('el mejor bot en puerto ' + PORT);
  startSocket().catch(error => console.error('Error iniciando WhatsApp:', error));
});
