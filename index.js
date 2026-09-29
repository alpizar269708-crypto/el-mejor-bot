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

const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'alpizar269708-crypto/el-mejor-bot';
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const ENCRYPTED_SESSION_FILE = 'session.enc';

function sessionSecurityReady() {
  return Boolean(GITHUB_TOKEN && SESSION_PASSWORD);
}

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32);
}

function encryptSession(json) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(SESSION_PASSWORD, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64')
  });
}

function decryptSession(payload) {
  const p = JSON.parse(payload);
  const salt = Buffer.from(p.salt, 'base64');
  const iv = Buffer.from(p.iv, 'base64');
  const tag = Buffer.from(p.tag, 'base64');
  const data = Buffer.from(p.data, 'base64');
  const key = deriveKey(SESSION_PASSWORD, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function githubRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
}

async function downloadEncryptedSession() {
  if (!sessionSecurityReady()) {
    console.warn('Sesión GitHub: faltan GITHUB_TOKEN o SESSION_PASSWORD.');
    return false;
  }

  try {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + ENCRYPTED_SESSION_FILE;
    const response = await githubRequest(url);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error('GitHub HTTP ' + response.status);

    const file = await response.json();
    const encrypted = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const decrypted = decryptSession(encrypted);

    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const files = JSON.parse(decrypted);
    for (const [relativePath, base64] of Object.entries(files)) {
      const target = path.join(SESSION_DIR, relativePath);
      if (!target.startsWith(SESSION_DIR + path.sep)) throw new Error('Ruta de sesión inválida');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));
    }

    console.log('Sesión cifrada restaurada desde GitHub.');
    return true;
  } catch (error) {
    console.error('No se pudo restaurar la sesión cifrada:', error.message);
    return false;
  }
}

async function collectSession() {
  const files = {};
  const walk = async (dir, prefix = '') => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = path.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else files[rel.replaceAll(path.sep, '/')] = (await fs.promises.readFile(full)).toString('base64');
    }
  };
  await walk(SESSION_DIR);
  return files;
}

let uploadTimer = null;
let uploadRunning = false;
let uploadAgain = false;

async function uploadEncryptedSession() {
  if (!sessionSecurityReady()) return;
  if (uploadRunning) {
    uploadAgain = true;
    return;
  }

  uploadRunning = true;
  try {
    const files = await collectSession();
    const encrypted = encryptSession(JSON.stringify(files));
    const content = Buffer.from(encrypted, 'utf8').toString('base64');
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + ENCRYPTED_SESSION_FILE;

    let sha = null;
    const existing = await githubRequest(url);
    if (existing.ok) {
      sha = (await existing.json()).sha;
    } else if (existing.status !== 404) {
      throw new Error('GitHub HTTP ' + existing.status);
    }

    const body = {
      message: 'Actualizar sesión cifrada de WhatsApp',
      content
    };
    if (sha) body.sha = sha;

    const response = await githubRequest(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error('GitHub HTTP ' + response.status);
    console.log('Sesión cifrada guardada en GitHub.');
  } catch (error) {
    console.error('No se pudo guardar la sesión en GitHub:', error.message);
  } finally {
    uploadRunning = false;
    if (uploadAgain) {
      uploadAgain = false;
      scheduleSessionUpload();
    }
  }
}

function scheduleSessionUpload() {
  if (!sessionSecurityReady()) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => uploadEncryptedSession(), 15000);
}


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

  if (sessionSecurityReady()) await downloadEncryptedSession();
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

  sock.ev.on('creds.update', async () => {
    await authState.saveCreds();
    scheduleSessionUpload();
  });
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
      scheduleSessionUpload();
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
    if (sessionSecurityReady()) scheduleSessionUpload();
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
