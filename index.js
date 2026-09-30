require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GITHUB_REPO = process.env.GITHUB_REPO || 'alpizar269708-crypto/el-mejor-bot';
const SESSION_BRANCH = process.env.SESSION_BRANCH || 'session-data';
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const ENCRYPTED_SESSION_FILE = 'session.enc';
const LAST_GOOD_SESSION_FILE = 'session.last-good.enc';

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
    console.warn('⚠️ Sesión GitHub NO disponible: faltan GITHUB_TOKEN o SESSION_PASSWORD.');
    return false;
  }

  async function tryRestore(filename, label) {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename + '?ref=' + encodeURIComponent(SESSION_BRANCH);
    const response = await githubRequest(url);

    if (response.status === 404) return false;
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error('GitHub HTTP ' + response.status + (details ? ' - ' + details.slice(0, 300) : ''));
    }

    const file = await response.json();
    const encrypted = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const decrypted = decryptSession(encrypted);
    const files = JSON.parse(decrypted);

    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    for (const [relativePath, base64] of Object.entries(files)) {
      const target = path.join(SESSION_DIR, relativePath);
      if (!target.startsWith(SESSION_DIR + path.sep)) throw new Error('Ruta de sesión inválida');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));
    }

    console.log(label);
    return true;
  }

  try {
    if (await tryRestore(ENCRYPTED_SESSION_FILE, 'Sesión cifrada restaurada desde GitHub.')) {
      return true;
    }

    if (await tryRestore(LAST_GOOD_SESSION_FILE, '🛡️ Sesión restaurada desde el respaldo de última sesión válida.')) {
      return true;
    }

    console.log('ℹ️ GitHub: todavía no existe un respaldo de sesión.');
    return false;
  } catch (error) {
    console.error('⚠️ No se pudo restaurar la sesión principal:', error.message);

    try {
      if (await tryRestore(LAST_GOOD_SESSION_FILE, '🛡️ Sesión restaurada desde el respaldo de última sesión válida.')) {
        return true;
      }
    } catch (backupError) {
      console.error('❌ Tampoco se pudo restaurar el respaldo de seguridad:', backupError.message);
    }

    return false;
  }
}
async function deleteEncryptedSession() {
  if (!sessionSecurityReady()) return false;

  try {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + ENCRYPTED_SESSION_FILE + '?ref=' + encodeURIComponent(SESSION_BRANCH);
    const existing = await githubRequest(url);

    if (existing.status === 404) return true;
    if (!existing.ok) {
      const details = await existing.text().catch(() => '');
      throw new Error('GitHub HTTP ' + existing.status + (details ? ' - ' + details.slice(0, 300) : ''));
    }

    const file = await existing.json();
    const response = await githubRequest(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Eliminar sesión cifrada para nueva vinculación',
        sha: file.sha,
        branch: SESSION_BRANCH
      })
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error('GitHub rechazó el borrado: HTTP ' + response.status + (details ? ' - ' + details.slice(0, 500) : ''));
    }

    console.log('🗑️ Sesión cifrada anterior eliminada de GitHub.');
    return true;
  } catch (error) {
    console.error('❌ No se pudo eliminar la sesión cifrada anterior:', error.message);
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
let lastSessionUploadAt = null;
let lastSessionUploadOk = null;
let lastSessionUploadError = null;
let sessionUploadFailures = 0;

async function uploadEncryptedSession() {
  lastSessionUploadAt = new Date().toISOString();

  if (!sessionSecurityReady()) {
    lastSessionUploadOk = false;
    lastSessionUploadError = 'Faltan GITHUB_TOKEN o SESSION_PASSWORD';
    console.warn('⚠️ Sesión NO guardada: faltan GITHUB_TOKEN o SESSION_PASSWORD.');
    return false;
  }

  const credsPath = path.join(SESSION_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    lastSessionUploadOk = false;
    lastSessionUploadError = 'No existe creds.json';
    console.warn('⚠️ Sesión NO guardada: todavía no existe creds.json.');
    return false;
  }

  // NUNCA sobrescribir el respaldo de GitHub con una vinculación incompleta.
  // Esto evita que un deploy/reinicio durante el login destruya la última sesión válida.
  let creds;
  try {
    creds = JSON.parse(await fs.promises.readFile(credsPath, 'utf8'));
  } catch {
    lastSessionUploadOk = false;
    lastSessionUploadError = 'creds.json inválido';
    console.warn('⚠️ Sesión NO guardada: creds.json no pudo validarse.');
    return false;
  }

  // Si WhatsApp ya abrió la conexión, la sesión está vinculada aunque
  // creds.json todavía no haya alcanzado a reflejar registered=true.
  // Esto evita la carrera entre connection.open y creds.update.
  if (creds?.registered !== true && connectionState !== 'conectado') {
    lastSessionUploadOk = false;
    lastSessionUploadError = 'La sesión todavía no está vinculada';
    console.log('⏸️ Sesión no guardada: la vinculación de WhatsApp todavía no terminó.');
    return false;
  }

  if (uploadRunning) {
    uploadAgain = true;
    return false;
  }

  uploadRunning = true;

  try {
    const files = await collectSession();
    if (!files['creds.json']) {
      throw new Error('La sesión está vacía o creds.json no pudo leerse');
    }

    const encrypted = encryptSession(JSON.stringify(files));
    const content = Buffer.from(encrypted, 'utf8').toString('base64');
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + ENCRYPTED_SESSION_FILE + '?ref=' + encodeURIComponent(SESSION_BRANCH);

    let sha = null;
    const existing = await githubRequest(url);

    if (existing.ok) {
      const existingFile = await existing.json();
      sha = existingFile.sha;
    } else if (existing.status !== 404) {
      const details = await existing.text().catch(() => '');
      throw new Error(
        'GitHub no permite consultar session.enc: HTTP ' +
        existing.status +
        (details ? ' - ' + details.slice(0, 500) : '')
      );
    }

    // Antes de reemplazar la sesión actual, conservar la última sesión válida.
    // Si un deploy defectuoso genera credenciales registradas pero problemáticas,
    // esta copia permite recuperar la sesión anterior.
    if (sha && existing.ok) {
      const currentFileResponse = await githubRequest(url);
      const existingFile = currentFileResponse.ok
        ? await currentFileResponse.json().catch(() => null)
        : null;
      if (existingFile?.content) {
        const backupUrl = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + LAST_GOOD_SESSION_FILE + '?ref=' + encodeURIComponent(SESSION_BRANCH);
        const backupExisting = await githubRequest(backupUrl);
        let backupSha = null;

        if (backupExisting.ok) {
          const backupFile = await backupExisting.json();
          backupSha = backupFile.sha;
        } else if (backupExisting.status !== 404) {
          const details = await backupExisting.text().catch(() => '');
          throw new Error('No se pudo consultar el respaldo de seguridad: HTTP ' + backupExisting.status + (details ? ' - ' + details.slice(0, 500) : ''));
        }

        const backupBody = {
          message: 'Conservar última sesión válida de WhatsApp',
          content: existingFile.content.replace(/\n/g, ''),
          branch: SESSION_BRANCH
        };

        if (backupSha) backupBody.sha = backupSha;

        const backupResponse = await githubRequest(backupUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backupBody)
        });

        if (!backupResponse.ok) {
          const details = await backupResponse.text().catch(() => '');
          throw new Error('No se pudo guardar el respaldo de seguridad: HTTP ' + backupResponse.status + (details ? ' - ' + details.slice(0, 700) : ''));
        }

        console.log('🛡️ Última sesión válida respaldada antes de actualizar.');
      }
    }

    const body = {
      message: 'Actualizar sesión cifrada de WhatsApp',
      content,
      branch: SESSION_BRANCH
    };

    if (sha) body.sha = sha;

    const response = await githubRequest(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(
        'GitHub rechazó la escritura: HTTP ' +
        response.status +
        (details ? ' - ' + details.slice(0, 700) : '')
      );
    }

    lastSessionUploadOk = true;
    lastSessionUploadError = null;
    sessionUploadFailures = 0;
    console.log('✅ Sesión cifrada guardada en GitHub.');
    return true;
  } catch (error) {
    lastSessionUploadOk = false;
    lastSessionUploadError = error.message;
    sessionUploadFailures += 1;
    console.error('❌ No se pudo guardar la sesión en GitHub:', error.message);

    // Mantener reintentos mientras WhatsApp siga conectado.
    if (!shuttingDown && connectionState === 'conectado') {
      const retryDelay = Math.min(15000 * Math.max(1, sessionUploadFailures), 120000);
      scheduleSessionUpload(retryDelay);
    }

    return false;
  } finally {
    uploadRunning = false;

    if (uploadAgain) {
      uploadAgain = false;
      scheduleSessionUpload();
    }
  }
}

function scheduleSessionUpload(delay = 3000) {
  if (!sessionSecurityReady() || shuttingDown) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadEncryptedSession().catch(error => {
      console.error('Error en guardado programado:', error.message);
    });
  }, delay);
}

function getDisconnectCode(lastDisconnect) {
  return (
    lastDisconnect?.error?.output?.statusCode ||
    lastDisconnect?.error?.statusCode ||
    lastDisconnect?.error?.data?.statusCode ||
    null
  );
}

function getDisconnectReason(lastDisconnect) {
  const error = lastDisconnect?.error;
  if (!error) return 'sin detalle';
  return error?.message || error?.data?.message || String(error);
}

function scheduleReconnect(statusCode) {
  if (shuttingDown) return;

  clearTimeout(reconnectTimer);
  reconnectAttempts += 1;

  const baseDelay =
    statusCode === DisconnectReason.restartRequired ? 1000 :
    statusCode === 408 ? 3000 :
    statusCode === 428 ? 3000 :
    statusCode === 440 ? 5000 :
    5000;

  const delay = Math.min(
    baseDelay * Math.pow(2, Math.max(0, reconnectAttempts - 1)),
    60000
  );

  console.log(
    '🔄 Reconexión #' + reconnectAttempts +
    ' en ' + Math.round(delay / 1000) + 's. Código: ' +
    (statusCode ?? 'desconocido')
  );

  reconnectTimer = setTimeout(() => {
    startSocket(false).catch(error => {
      console.error('❌ Error levantando reconexión:', error.message);
      scheduleReconnect(statusCode);
    });
  }, delay);
}

async function startSocketAfterWake() {
  if (shuttingDown) return;
  if (connectionState === 'conectado' || connectionState === 'conectando') return;

  const credsPath = path.join(SESSION_DIR, 'creds.json');

  if (!fs.existsSync(credsPath) && sessionSecurityReady()) {
    await downloadEncryptedSession();
  }

  if (fs.existsSync(credsPath)) {
    const saved = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (saved?.registered) {
      await startSocket(false);
    }
  }
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
let pairingNumber = null;
let pairingRequested = false;
let pairingError = null;
let lastQrAt = 0;
let loginRefreshPromise = null;
let connectionState = 'desconectado';
let reconnectTimer = null;
let reconnectAttempts = 0;
let sessionRecoveryFailures = 0;
let lastConnectedAt = null;
let lastDisconnectAt = null;
let lastDisconnectCode = null;
let lastDisconnectReason = null;
let socketGeneration = 0;
let shuttingDown = false;
const processing = new Set();

function getText(message) {
  const m = unwrapMessage(message);
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
  const m = unwrapMessage(message);
  const ctx = m?.extendedTextMessage?.contextInfo;
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

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

async function requestPairingCodeIfNeeded() {
  if (!sock || !pairingNumber || pairingRequested) return;
  if (authState?.state?.creds?.registered) return;

  pairingRequested = true;

  try {
    const code = await sock.requestPairingCode(pairingNumber);
    pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    pairingError = null;
    qrDataUrl = null;
    console.log('\\n🔢 CÓDIGO DE VINCULACIÓN:', pairingCode, '\\n');
  } catch (error) {
    pairingRequested = false;
    pairingError = error?.message || 'No se pudo generar el código.';
    console.error('❌ Error generando código de vinculación:', pairingError);
  }
}

async function optimizeHeavyVideo(buffer, videoMessage = {}) {
  const duration = Number(videoMessage.seconds || 0);
  const width = Number(videoMessage.width || 0);
  const height = Number(videoMessage.height || 0);

  // Videos cortos y de tamaño razonable: NO hacemos un transcode previo.
  // wa-sticker-formatter hará la conversión final directamente, evitando
  // procesar el video dos veces. Esto acelera mucho y conserva mejor calidad.
  const sourceMegabytes = buffer.length / 1024 / 1024;
  const sourceMaxDimension = Math.max(width, height);

  if (
    duration > 0 &&
    duration <= 10 &&
    sourceMegabytes <= 5 &&
    width > 0 &&
    height > 0 &&
    sourceMaxDimension <= 1280
  ) {
    console.log(
      '🎥 Video corto: conversión directa a sticker.',
      '(' + width + 'x' + height + ', ' + duration + 's, ' +
      Math.round(sourceMegabytes * 100) / 100 + ' MB)'
    );
    return { buffer, optimized: false };
  }

  // Perfil adaptativo: los videos muy pesados necesitan un transcode
  // más agresivo para que WhatsApp pueda convertirlos en sticker sin fallar.
  // Los videos que no entraron en conversión directa sí necesitan precompresión.
  // Compresión agresiva para que incluso videos grandes puedan convertirse
  // en sticker dentro de los límites de CPU/memoria de Render.
  const veryHeavy = sourceMegabytes >= 8 || sourceMaxDimension >= 720;

  // Perfil ultrarrápido: prioriza que el sticker salga rápido.
  // La conversión a sticker hará la compresión final después.
  const actualDuration = duration > 0 ? Math.min(duration, 10) : 10;

  const profile = veryHeavy
    ? {
        duration: actualDuration,
        fps: 8,
        size: 200,
        bitrate: '115k',
        crf: 36
      }
    : {
        duration: actualDuration,
        fps: 12,
        size: 220,
        bitrate: '135k',
        crf: 34
      };

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'el-mejor-bot-'));
  const input = path.join(tempDir, 'input');
  const output = path.join(tempDir, 'optimized.mp4');

  try {
    await fs.promises.writeFile(input, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .videoFilters([
          'fps=' + profile.fps,
          'scale=' + profile.size + ':' + profile.size +
            ':force_original_aspect_ratio=decrease:flags=fast_bilinear',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2'
        ])
        .outputOptions([
          '-t ' + profile.duration,
          '-an',
          '-c:v libx264',
          '-preset ultrafast',
          '-crf ' + profile.crf,
          '-b:v ' + profile.bitrate,
          '-maxrate ' + profile.bitrate,
          '-bufsize 240k',
          '-pix_fmt yuv420p',
          '-threads 2',
          '-movflags +faststart'
        ])
        .on('end', resolve)
        .on('error', reject)
        .save(output);
    });

    const optimized = await fs.promises.readFile(output);

    console.log(
      '🎥 Video optimizado para sticker:',
      Math.round(buffer.length / 1024 / 1024 * 100) / 100 + ' MB →',
      Math.round(optimized.length / 1024 * 100) / 100 + ' KB',
      '(' + profile.size + 'px, ' + profile.fps + ' fps, ' +
      profile.duration + 's, ' + (veryHeavy ? 'perfil pesado' : 'perfil normal') + ')'
    );

    return { buffer: optimized, optimized: true };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
async function optimizeVideoFallback(buffer, duration = 10) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'el-mejor-bot-fallback-'));
  const input = path.join(tempDir, 'input');
  const output = path.join(tempDir, 'fallback.mp4');

  try {
    await fs.promises.writeFile(input, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .videoFilters([
          'fps=12',
          'scale=220:220:force_original_aspect_ratio=decrease:flags=fast_bilinear',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2'
        ])
        .outputOptions([
          '-t ' + Math.min(Math.max(Number(duration) || 10, 0.1), 10),
          '-an',
          '-c:v libx264',
          '-preset ultrafast',
          '-crf 32',
          '-b:v 160k',
          '-maxrate 160k',
          '-bufsize 240k',
          '-pix_fmt yuv420p',
          '-threads 2',
          '-movflags +faststart'
        ])
        .on('end', resolve)
        .on('error', reject)
        .save(output);
    });

    const fallback = await fs.promises.readFile(output);
    console.log('🆘 Fallback extremo de video:', Math.round(fallback.length / 1024) + ' KB');
    return fallback;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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

    let buffer = await downloadMediaMessage(
      sourceMessage,
      'buffer',
      {},
      {
        logger: P({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (mediaType === 'video') {
      const videoMessage = unwrapMessage(sourceMessage)?.videoMessage || {};
      const optimized = await optimizeHeavyVideo(buffer, videoMessage);
      buffer = optimized.buffer;
    }

    let stickerBuffer;

    try {
      const sticker = new Sticker(buffer, {
        pack: 'el mejor bot',
        author: 'el mejor bot',
        type: mediaType === 'video' ? StickerTypes.FULL : StickerTypes.DEFAULT,
        quality: mediaType === 'video' ? 40 : 90
      });
      stickerBuffer = await sticker.toBuffer();
    } catch (firstError) {
      if (mediaType !== 'video') throw firstError;

      console.warn('⚠️ Primer intento de sticker de video falló. Reintentando con compresión extrema.');

      const fallback = await optimizeVideoFallback(buffer, Number(unwrapMessage(sourceMessage)?.videoMessage?.seconds || 10));
      const sticker = new Sticker(fallback, {
        pack: 'el mejor bot',
        author: 'el mejor bot',
        type: StickerTypes.FULL,
        quality: 30
      });
      stickerBuffer = await sticker.toBuffer();
    }

    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    await sock.sendMessage(jid, {
      react: { text: '✅', key: message.key }
    });
  } catch (error) {
    console.error('Error creando sticker:', error);

    let reason = error?.message || error?.toString?.() || 'Error desconocido';
    reason = reason
      .replace(/\s+/g, ' ')
      .replace(/^Error:\s*/i, '')
      .trim();

    if (reason.length > 220) reason = reason.slice(0, 217) + '...';

    await sendText(
      jid,
      '❌ No pude crear el sticker.\\n📌 Razón: ' + reason,
      message
    ).catch(() => {});
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

async function restartForFreshLogin() {
  if (loginRefreshPromise) return loginRefreshPromise;

  loginRefreshPromise = (async () => {
    pairingError = null;
    pairingCode = null;
    qrDataUrl = null;
    pairingRequested = false;

    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.ws?.close(); } catch {}
    }

    sock = null;
    authState = null;
    connectionState = 'desconectado';

    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });

    // Una vinculación nueva empieza con sesión local limpia,
    // pero NO borramos todavía el respaldo cifrado de GitHub.
    // Solo se reemplazará cuando la nueva vinculación termine correctamente.
    return startSocket(false);
  })().finally(() => {
    loginRefreshPromise = null;
  });

  return loginRefreshPromise;
}

async function startSocket(restoreSession = true) {
  if (shuttingDown) return null;
  if (sock && (connectionState === 'conectado' || connectionState === 'conectando')) return sock;

  if (restoreSession && sessionSecurityReady()) {
    await downloadEncryptedSession();
  }

  authState = await useMultiFileAuthState(SESSION_DIR);
  connectionState = 'conectando';
  const myGeneration = ++socketGeneration;

  const newSock = makeWASocket({
    auth: authState.state,
    logger: P({ level: 'silent' }),
    browser: ['Windows', 'Chrome', 'Chrome 114.0.5735.198'],
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    qrTimeout: 120000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock = newSock;

  newSock.ev.on('creds.update', async () => {
    try {
      await authState.saveCreds();

      // Las credenciales se guardan localmente en cada actualización,
      // pero el respaldo remoto SOLO se actualiza cuando registered=true.
      // Así un reinicio/deploy durante una vinculación nunca pisa una sesión válida.
      if (authState?.state?.creds?.registered === true) {
        // No dependemos de que el socket siga marcado como conectado.
        // Render puede enviar SIGTERM durante una transición y la sesión
        // ya registrada debe respaldarse de todos modos.
        scheduleSessionUpload(1500);
      }
    } catch (error) {
      console.error('❌ Error guardando credenciales locales:', error.message);
    }
  });

  newSock.ev.on('messages.upsert', async update => {
    for (const message of update?.messages || []) {
      try {
        await handleMessage({ messages: [message] });
      } catch (error) {
        console.error('Error procesando mensaje:', error);
      }
    }
  });

  newSock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (myGeneration !== socketGeneration) return;

    if (qr) {
      if (pairingNumber) {
        qrDataUrl = null;
        setTimeout(() => requestPairingCodeIfNeeded(), 800);
      } else {
        try {
          qrDataUrl = await QRCode.toDataURL(qr);
          pairingCode = null;
          lastQrAt = Date.now();
        } catch (error) {
          console.error('Error generando QR:', error);
        }
      }
    }

    if (connection === 'connecting' && pairingNumber) {
      setTimeout(() => requestPairingCodeIfNeeded(), 1200);
    }

    if (connection === 'open') {
      connectionState = 'conectado';
      reconnectAttempts = 0;
      sessionRecoveryFailures = 0;
      lastConnectedAt = new Date().toISOString();
      lastDisconnectCode = null;
      lastDisconnectReason = null;
      qrDataUrl = null;
      pairingCode = null;
      pairingNumber = null;
      pairingRequested = false;
      pairingError = null;

      console.log('✅ el mejor bot conectado');
      console.log('🟢 WhatsApp conectado:', lastConnectedAt);

      clearTimeout(uploadTimer);
      uploadEncryptedSession().then(ok => {
        if (!ok) scheduleSessionUpload(5000);
      }).catch(error => {
        console.error('Guardado inmediato:', error.message);
        scheduleSessionUpload(5000);
      });
      return;
    }

    if (connection === 'close') {
      const statusCode = getDisconnectCode(lastDisconnect);
      const reason = getDisconnectReason(lastDisconnect);

      connectionState = 'desconectado';
      lastDisconnectAt = new Date().toISOString();
      lastDisconnectCode = statusCode;
      lastDisconnectReason = reason;

      console.error('🔴 WhatsApp desconectado');
      console.error('   Código:', statusCode ?? 'desconocido');
      console.error('   Motivo:', reason);

      if (sock === newSock) {
        sock = null;
        authState = null;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.error('🚪 WhatsApp indicó LOGGED OUT. No se reconectará automáticamente.');
        qrDataUrl = null;
        pairingCode = null;
        pairingNumber = null;
        pairingRequested = false;

        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        // NO borrar automáticamente el respaldo remoto. Si Render reinicia
        // mientras WhatsApp está cerrando la conexión, el respaldo válido debe
        // seguir disponible para el siguiente arranque. Una nueva vinculación
        // lo reemplazará únicamente cuando quede registrada.
        return;
      }

      if (statusCode !== 515) {
        pairingRequested = false;
      }

      // Una sesión restaurada puede fallar por credenciales antiguas o
      // desincronizadas. No la borramos al primer fallo: damos 4 intentos
      // antes de considerarla irrecuperable.
      const retryableSessionFailure =
        statusCode === 401 ||
        statusCode === 408 ||
        statusCode === 428 ||
        statusCode === 440;

      if (retryableSessionFailure) {
        sessionRecoveryFailures += 1;
        console.log(
          '🔐 Fallo de sesión restaurada #' +
          sessionRecoveryFailures +
          ' de 4.'
        );

        if (sessionRecoveryFailures >= 4) {
          console.error('🧹 La sesión restaurada falló 4 veces. Se limpiará para permitir una nueva vinculación.');
          clearTimeout(reconnectTimer);

          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          } catch {}
          fs.mkdirSync(SESSION_DIR, { recursive: true });

          // No borrar el respaldo remoto aquí. Una falla temporal o una
          // transición de WhatsApp no debe destruir la última sesión válida.
          // /iniciar podrá reemplazarlo después de una nueva vinculación.
          pairingNumber = null;
          pairingCode = null;
          pairingRequested = false;
          pairingError = 'La sesión anterior ya no es válida. Genera un nuevo código de vinculación.';
          connectionState = 'desconectado';
          return;
        }
      }

      scheduleReconnect(statusCode);
    }
  });

  return newSock;
}

app.get('/', async (_req, res) => {
  try {
    if (!authState?.state?.creds?.registered && connectionState === 'desconectado') {
      await startSocket(false);
    }
  } catch (error) {
    pairingError = error?.message || 'No se pudo iniciar WhatsApp.';
  }

  const qr = qrDataUrl
    ? '<img src="' + qrDataUrl + '" alt="QR" style="width:280px;height:280px">'
    : '<p>No hay QR disponible.</p>';

  const code = pairingCode
    ? '<div style="font-size:30px;font-weight:bold;letter-spacing:5px;margin:20px">' + pairingCode + '</div><p>En WhatsApp: Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono.</p>'
    : pairingError
      ? '<p style="color:#b91c1c">❌ ' + pairingError + '</p>'
      : '<p>Escribe tu número y pulsa Generar código.</p>';

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
<script>
setTimeout(() => location.reload(), 3000);
</script>
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

app.get('/keepalive', async (_req, res) => {
  try {
    await startSocketAfterWake();
    res.status(200).json({
      ok: true,
      estado: connectionState,
      whatsapp: connectionState === 'conectado'
    });
  } catch (error) {
    console.error('❌ Keepalive no pudo revisar WhatsApp:', error.message);
    res.status(503).json({ ok: false, estado: connectionState });
  }
});

app.get('/health', async (_req, res) => {
  let githubSession = 'sin configurar';
  let githubReadStatus = null;

  if (sessionSecurityReady()) {
    try {
      const check = await githubRequest(
        'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + ENCRYPTED_SESSION_FILE + '?ref=' + encodeURIComponent(SESSION_BRANCH)
      );
      githubReadStatus = check.status;
      githubSession =
        check.status === 200 ? 'guardada' :
        check.status === 404 ? 'no existe' :
        'error HTTP ' + check.status;
    } catch (error) {
      githubSession = 'error: ' + error.message;
    }
  }

  res.status(200).json({
    ok: true,
    estado: connectionState,
    ramaSesion: SESSION_BRANCH,
    whatsapp: connectionState === 'conectado',
    uptime: Math.round(process.uptime()),
    sessionLocal: fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
    githubSession,
    githubReadStatus,
    respaldoUltimaSesion: LAST_GOOD_SESSION_FILE,
    githubConfigurado: sessionSecurityReady(),
    ultimaSubidaSesion: lastSessionUploadAt,
    ultimaSubidaExitosa: lastSessionUploadOk,
    ultimoErrorSubidaSesion: lastSessionUploadError,
    fallosConsecutivosSubida: sessionUploadFailures,
    ultimaConexion: lastConnectedAt,
    ultimaDesconexion: lastDisconnectAt,
    ultimoCodigoDesconexion: lastDisconnectCode,
    intentosReconectar: reconnectAttempts,
    fallosSesionRestaurada: sessionRecoveryFailures
  });
});

app.get('/estado-vinculacion', (_req, res) => {
  res.json({
    conectado: connectionState === 'conectado',
    estado: connectionState,
    pairingCode
  });
});

app.post('/iniciar', async (req, res) => {
  const numero = normalizePhoneNumber(req.body.numero);

  if (!numero) return res.status(400).send('Número inválido.');
  if (numero.length < 8 || numero.length > 15) {
    return res.status(400).send('Número inválido. Usa código de país y solo números.');
  }

  try {
    pairingNumber = numero;
    pairingCode = null;
    pairingRequested = false;
    pairingError = null;
    qrDataUrl = null;

    await restartForFreshLogin();
    setTimeout(() => requestPairingCodeIfNeeded(), 500);

    res.redirect('/');
  } catch (error) {
    pairingRequested = false;
    pairingError = error?.message || 'No se pudo iniciar la vinculación.';
    console.error('Error al iniciar vinculación:', error);
    res.redirect('/');
  }
});

app.post('/cerrar-sesion', async (_req, res) => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearTimeout(uploadTimer);

  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
  } finally {
    sock = null;
    authState = null;
    qrDataUrl = null;
    pairingCode = null;
    pairingNumber = null;
    pairingRequested = false;
    pairingError = null;
    lastQrAt = 0;
    connectionState = 'desconectado';
    shuttingDown = false;

    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch {}

    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  res.redirect('/');
});

app.get('/limpiar-whatsapp', async (_req, res) => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearTimeout(uploadTimer);

  try {
    if (sock) {
      try { await sock.logout(); } catch {}
    }
  } finally {
    sock = null;
    authState = null;
    qrDataUrl = null;
    pairingCode = null;
    pairingNumber = null;
    pairingRequested = false;
    pairingError = null;
    connectionState = 'desconectado';
    shuttingDown = false;

    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch {}

    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  res.json({ ok: true, mensaje: 'Sesión limpiada.' });
});

process.on('unhandledRejection', error => {
  console.error('❌ UNHANDLED REJECTION:', error);
});

process.on('uncaughtException', error => {
  console.error('❌ UNCAUGHT EXCEPTION:', error);
  console.error('El proceso se cerrará para que Render lo reinicie limpiamente.');
  process.exit(1);
});

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearTimeout(uploadTimer);

  console.log('🛑 Señal de apagado:', signal);

  try {
    if (authState?.saveCreds) await authState.saveCreds();

    // Al apagar Render, jamás subir una sesión de vinculación incompleta.
    // Solo conservamos/reemplazamos el respaldo remoto si ya está registrada.
    if (authState?.state?.creds?.registered === true) {
      await uploadEncryptedSession();
    } else {
      console.log('⏸️ Apagado: no se sobrescribe la sesión de GitHub porque no está vinculada.');
    }
  } catch (error) {
    console.error('❌ No se pudo guardar la sesión al apagar:', error.message);
  }

  try {
    if (sock?.ws) sock.ws.close();
  } catch {}

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, async () => {
  console.log('el mejor bot en puerto ' + PORT);

  try {
    if (sessionSecurityReady()) {
      await downloadEncryptedSession();
    } else {
      console.warn('⚠️ Render no tiene configurados GITHUB_TOKEN + SESSION_PASSWORD; la sesión no podrá sobrevivir a un redeploy.');
    }

    const credsPath = path.join(SESSION_DIR, 'creds.json');

    if (fs.existsSync(credsPath)) {
      const saved = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

      const registered = saved?.registered === true;

      console.log(
        '🔐 Credenciales restauradas. registered=' +
        (registered ? 'true' : 'false') +
        (registered ? '. Iniciando WhatsApp...' : '. La sesión está incompleta; esperando una nueva vinculación.')
      );

      if (registered) {
        await startSocket(false);
      } else {
        // No dejar un socket colgado con credenciales de una vinculación
        // que nunca terminó. Limpiamos esa sesión incompleta para que
        // /iniciar pueda generar un código nuevo correctamente.
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        // El respaldo remoto NO se elimina automáticamente. Si existe, se
        // conserva para poder recuperarlo tras un reinicio. Una nueva sesión
        // válida lo reemplazará mediante uploadEncryptedSession().
        connectionState = 'desconectado';
        pairingError = 'La sesión anterior estaba incompleta. Genera un nuevo código de vinculación.';
      }
    } else {
      console.log('Sin sesión local. Esperando QR o código solicitado por el usuario.');
    }
  } catch (error) {
    console.error('❌ Error restaurando sesión inicial:', error.message);
    scheduleReconnect(null);
  }
});
