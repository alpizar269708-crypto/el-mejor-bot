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
const { inspectWebpAnimation } = require('./stickerUtils');
const { validateSessionSnapshot } = require('./sessionUtils');

const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { comandoDescargaSocial, extraerUrl, detectarPlataforma, liberarColaDescargas, estadoColaDescargas } = require('./descargasSociales');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GITHUB_REPO = process.env.GITHUB_REPO || 'alpizar269708-crypto/el-mejor-bot';
const SESSION_BRANCH = process.env.SESSION_BRANCH || 'session-data';
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || SESSION_PASSWORD?.trim() || null;
const ENCRYPTED_SESSION_FILE = 'session.enc';
const LAST_GOOD_SESSION_FILE = 'session.last-good.enc';
let restoredSessionSource = null;

// Memoria persistente del bot.
// Se mantiene en RAM para máxima velocidad y se sincroniza en segundo plano
// con una rama independiente de GitHub para no competir con la sesión de WhatsApp.
const MEMORY_BRANCH = process.env.MEMORY_BRANCH || 'memory-data';
const ENCRYPTED_MEMORY_FILE = 'memory.enc';
const LAST_GOOD_MEMORY_FILE = 'memory.last-good.enc';

let memoryStore = {
  version: 1,
  updatedAt: null,
  stats: {
    totalMessages: 0,
    totalStickers: 0,
    totalVideoStickers: 0,
    totalImageStickers: 0
  },
  chats: {}
};

let memoryLoaded = false;
let memoryDirty = false;
let memorySaveTimer = null;
let memorySaveRunning = false;
let memorySaveAgain = false;
let lastMemorySaveAt = null;
let lastMemorySaveOk = null;
let lastMemorySaveError = null;

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

function memorySecurityReady() {
  return Boolean(GITHUB_TOKEN && SESSION_PASSWORD);
}

function normalizeMemory() {
  if (!memoryStore || typeof memoryStore !== 'object') memoryStore = {};
  if (!memoryStore.stats || typeof memoryStore.stats !== 'object') memoryStore.stats = {};
  memoryStore.version = 1;
  memoryStore.updatedAt = memoryStore.updatedAt || null;
  memoryStore.stats.totalMessages = Number(memoryStore.stats.totalMessages || 0);
  memoryStore.stats.totalStickers = Number(memoryStore.stats.totalStickers || 0);
  memoryStore.stats.totalVideoStickers = Number(memoryStore.stats.totalVideoStickers || 0);
  memoryStore.stats.totalImageStickers = Number(memoryStore.stats.totalImageStickers || 0);
  if (!memoryStore.chats || typeof memoryStore.chats !== 'object') memoryStore.chats = {};
}

async function readEncryptedMemoryFile(filename) {
  const url =
    'https://api.github.com/repos/' + GITHUB_REPO +
    '/contents/' + filename +
    '?ref=' + encodeURIComponent(MEMORY_BRANCH);

  const response = await githubRequest(url);

  if (response.status === 404) return null;
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(
      'GitHub memoria HTTP ' + response.status +
      (details ? ' - ' + details.slice(0, 300) : '')
    );
  }

  const file = await response.json();
  const encrypted = Buffer.from(
    file.content.replace(/\\n/g, ''),
    'base64'
  ).toString('utf8');

  const decrypted = decryptSession(encrypted);
  const parsed = JSON.parse(decrypted);

  return {
    data: parsed,
    sha: file.sha
  };
}

async function loadPersistentMemory() {
  if (!memorySecurityReady()) {
    console.warn('⚠️ Memoria GitHub no disponible: faltan GITHUB_TOKEN o SESSION_PASSWORD.');
    memoryLoaded = false;
    return false;
  }

  try {
    const primary = await readEncryptedMemoryFile(ENCRYPTED_MEMORY_FILE);

    if (primary?.data) {
      memoryStore = primary.data;
      normalizeMemory();
      memoryLoaded = true;
      console.log('🧠 Memoria restaurada desde GitHub.');
      return true;
    }

    const backup = await readEncryptedMemoryFile(LAST_GOOD_MEMORY_FILE);

    if (backup?.data) {
      memoryStore = backup.data;
      normalizeMemory();
      memoryLoaded = true;
      console.log('🛡️ Memoria restaurada desde el respaldo de GitHub.');
      scheduleMemorySave(3000);
      return true;
    }

    normalizeMemory();
    memoryLoaded = true;
    memoryDirty = true;
    console.log('🧠 Nueva memoria inicializada.');
    scheduleMemorySave(1000);
    return false;
  } catch (error) {
    console.error('⚠️ No se pudo cargar la memoria principal:', error.message);

    try {
      const backup = await readEncryptedMemoryFile(LAST_GOOD_MEMORY_FILE);
      if (backup?.data) {
        memoryStore = backup.data;
        normalizeMemory();
        memoryLoaded = true;
        console.log('🛡️ Memoria recuperada desde el respaldo.');
        return true;
      }
    } catch (backupError) {
      console.error('❌ Tampoco se pudo recuperar la memoria de respaldo:', backupError.message);
    }

    normalizeMemory();
    memoryLoaded = true;
    return false;
  }
}

function rememberActivity(jid, mediaType = null) {
  normalizeMemory();

  memoryStore.updatedAt = new Date().toISOString();
  memoryStore.stats.totalMessages += 1;

  if (!jid) {
    memoryDirty = true;
    scheduleMemorySave();
    return;
  }

  const key = String(jid);
  if (!memoryStore.chats[key]) {
    memoryStore.chats[key] = {
      firstSeenAt: memoryStore.updatedAt,
      lastSeenAt: memoryStore.updatedAt,
      messages: 0,
      stickers: 0,
      videoStickers: 0,
      imageStickers: 0
    };
  }

  const chat = memoryStore.chats[key];
  chat.lastSeenAt = memoryStore.updatedAt;
  chat.messages = Number(chat.messages || 0) + 1;

  if (mediaType === 'video') {
    memoryStore.stats.totalVideoStickers += 1;
    memoryStore.stats.totalStickers += 1;
    chat.videoStickers = Number(chat.videoStickers || 0) + 1;
    chat.stickers = Number(chat.stickers || 0) + 1;
  } else if (mediaType === 'image') {
    memoryStore.stats.totalImageStickers += 1;
    memoryStore.stats.totalStickers += 1;
    chat.imageStickers = Number(chat.imageStickers || 0) + 1;
    chat.stickers = Number(chat.stickers || 0) + 1;
  }

  memoryDirty = true;
  scheduleMemorySave();
}

async function savePersistentMemory() {
  if (!memorySecurityReady() || !memoryLoaded || !memoryDirty) return false;

  if (memorySaveRunning) {
    memorySaveAgain = true;
    return false;
  }

  memorySaveRunning = true;
  lastMemorySaveAt = new Date().toISOString();

  try {
    normalizeMemory();
    const encrypted = encryptSession(JSON.stringify(memoryStore));
    const contentBase64 = Buffer.from(encrypted, 'utf8').toString('base64');

    const url =
      'https://api.github.com/repos/' + GITHUB_REPO +
      '/contents/' + ENCRYPTED_MEMORY_FILE +
      '?ref=' + encodeURIComponent(MEMORY_BRANCH);

    let sha = null;
    const existing = await githubRequest(url);

    if (existing.ok) {
      const existingFile = await existing.json();
      sha = existingFile.sha;

      const currentContent = existingFile.content?.replace(/\\n/g, '');
      if (currentContent) {
        const backupUrl =
          'https://api.github.com/repos/' + GITHUB_REPO +
          '/contents/' + LAST_GOOD_MEMORY_FILE +
          '?ref=' + encodeURIComponent(MEMORY_BRANCH);

        const backupExisting = await githubRequest(backupUrl);
        let backupSha = null;

        if (backupExisting.ok) {
          const backupFile = await backupExisting.json();
          backupSha = backupFile.sha;
        } else if (backupExisting.status !== 404) {
          const details = await backupExisting.text().catch(() => '');
          throw new Error(
            'No se pudo consultar respaldo de memoria: HTTP ' +
            backupExisting.status +
            (details ? ' - ' + details.slice(0, 400) : '')
          );
        }

        const backupBody = {
          message: 'Respaldar memoria persistente del bot',
          content: currentContent,
          branch: MEMORY_BRANCH
        };

        if (backupSha) backupBody.sha = backupSha;

        const backupResponse = await githubRequest(backupUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(backupBody)
        });

        if (!backupResponse.ok) {
          const details = await backupResponse.text().catch(() => '');
          throw new Error(
            'No se pudo guardar respaldo de memoria: HTTP ' +
            backupResponse.status +
            (details ? ' - ' + details.slice(0, 500) : '')
          );
        }
      }
    } else if (existing.status !== 404) {
      const details = await existing.text().catch(() => '');
      throw new Error(
        'No se pudo consultar memoria: HTTP ' +
        existing.status +
        (details ? ' - ' + details.slice(0, 400) : '')
      );
    }

    const body = {
      message: 'Actualizar memoria persistente del bot',
      content: contentBase64,
      branch: MEMORY_BRANCH
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
        'GitHub rechazó la memoria: HTTP ' +
        response.status +
        (details ? ' - ' + details.slice(0, 600) : '')
      );
    }

    memoryDirty = false;
    lastMemorySaveOk = true;
    lastMemorySaveError = null;
    console.log('✅ Memoria guardada en GitHub.');
    return true;
  } catch (error) {
    lastMemorySaveOk = false;
    lastMemorySaveError = error.message;
    console.error('❌ No se pudo guardar la memoria:', error.message);
    return false;
  } finally {
    memorySaveRunning = false;

    if (memorySaveAgain || memoryDirty) {
      memorySaveAgain = false;
      scheduleMemorySave(15000);
    }
  }
}

function scheduleMemorySave(delay = 120000) {
  if (!memorySecurityReady() || shuttingDown) return;
  if (memorySaveTimer || memorySaveRunning) return;

  memorySaveTimer = setTimeout(() => {
    memorySaveTimer = null;
    savePersistentMemory().catch(error => {
      console.error('Error guardando memoria programada:', error.message);
    });
  }, delay);
}

function restoreSessionFiles(files, filename) {
  const restoreDir = path.join(path.dirname(SESSION_DIR), '.session-restore-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  const previousDir = SESSION_DIR + '.previous-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let movedPrevious = false;

  try {
    fs.mkdirSync(restoreDir, { recursive: true });

    for (const [relativePath, base64] of Object.entries(files)) {
      if (
        typeof relativePath !== 'string' ||
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes('..') ||
        typeof base64 !== 'string'
      ) {
        throw new Error('Archivo/ruta de sesión inválido');
      }

      const target = path.resolve(restoreDir, relativePath);
      if (!target.startsWith(restoreDir + path.sep)) {
        throw new Error('Ruta de sesión fuera de la carpeta temporal');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));
    }

    const credsPath = path.join(restoreDir, 'creds.json');
    if (!fs.existsSync(credsPath)) throw new Error(filename + ': falta creds.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    if (creds?.registered !== true) throw new Error(filename + ': credenciales sin vinculación confirmada');

    // Preparar la restauración completa fuera de SESSION_DIR para no dejar
    // credenciales a medias si el proceso falla durante la escritura.
    if (fs.existsSync(SESSION_DIR)) {
      fs.renameSync(SESSION_DIR, previousDir);
      movedPrevious = true;
    }

    try {
      fs.renameSync(restoreDir, SESSION_DIR);
    } catch (error) {
      if (movedPrevious && !fs.existsSync(SESSION_DIR)) {
        try { fs.renameSync(previousDir, SESSION_DIR); } catch {}
      }
      throw error;
    }

    if (movedPrevious) fs.rmSync(previousDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    fs.rmSync(restoreDir, { recursive: true, force: true });
    throw error;
  }
}

async function downloadEncryptedSession(options = {}) {
  if (!sessionSecurityReady()) {
    console.warn('⚠️ Sesión GitHub NO disponible: faltan GITHUB_TOKEN o SESSION_PASSWORD.');
    return false;
  }

  const backupOnly = options.backupOnly === true;
  const primaryOnly = options.primaryOnly === true;
  // Cada descarga restaura únicamente si la sesión no cambió durante el fetch.
  const expectedGeneration = options.expectedGeneration ?? socketGeneration;

  async function tryRestore(filename, label) {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename + '?ref=' + encodeURIComponent(SESSION_BRANCH);
    const response = await githubRequest(url);

    if (response.status === 404) return false;
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error('GitHub HTTP ' + response.status + (details ? ' - ' + details.slice(0, 300) : ''));
    }

    const file = await response.json();
    const encrypted = Buffer.from(file.content.replace(/\\n/g, ''), 'base64').toString('utf8');
    const decrypted = decryptSession(encrypted);
    const files = JSON.parse(decrypted);

    try {
      validateSessionSnapshot(files);
    } catch (error) {
      console.warn('⚠️ Se ignora ' + filename + ': ' + error.message);
      return false;
    }

    if (shuttingDown || expectedGeneration !== socketGeneration) {
      console.warn('⏭️ Se cancela la restauración de ' + filename + ': empezó otra operación de sesión.');
      return false;
    }

    restoreSessionFiles(files, filename);
    restoredSessionSource = filename;
    console.log(label);
    return true;
  }

  // Restaurar el archivo principal salvo que el código de WhatsApp ya haya
  // confirmado que no es válido; en ese caso probamos únicamente el respaldo.
  if (!backupOnly) {
    try {
      if (await tryRestore(ENCRYPTED_SESSION_FILE, 'Sesión cifrada restaurada desde GitHub.')) return true;
    } catch (error) {
      console.error('⚠️ No se pudo restaurar session.enc:', error.message);
    }
  }

  if (primaryOnly) {
    console.warn('ℹ️ No se restauró session.enc; se evita utilizar un respaldo que WhatsApp ya rechazó.');
    restoredSessionSource = null;
    return false;
  }

  try {
    if (await tryRestore(LAST_GOOD_SESSION_FILE, '🛡️ Sesión restaurada desde el respaldo de última sesión válida.')) return true;
  } catch (error) {
    console.error('❌ No se pudo restaurar session.last-good.enc:', error.message);
  }

  if (backupOnly) console.warn('⚠️ No se pudo recuperar ninguna sesión válida desde el respaldo.');
  else console.log('ℹ️ GitHub no tiene una sesión válida disponible para restaurar.');
  restoredSessionSource = null;
  return false;
}

async function deleteEncryptedSessionFile(filename = ENCRYPTED_SESSION_FILE) {
  if (!sessionSecurityReady()) return false;

  try {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename + '?ref=' + encodeURIComponent(SESSION_BRANCH);
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
        message: 'Eliminar archivo de sesión inválido: ' + filename,
        sha: file.sha,
        branch: SESSION_BRANCH
      })
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error('GitHub rechazó el borrado: HTTP ' + response.status + (details ? ' - ' + details.slice(0, 500) : ''));
    }

    console.log('🗑️ Archivo de sesión eliminado de GitHub: ' + filename);
    return true;
  } catch (error) {
    console.error('❌ No se pudo eliminar el archivo de sesión de GitHub (' + filename + '):', error.message);
    return false;
  }
}


async function deleteEncryptedSession() {
  return deleteEncryptedSessionFile(ENCRYPTED_SESSION_FILE);
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

  if (uploadRunning) {
    uploadAgain = true;
    return false;
  }

  uploadRunning = true;
  let resolveUploadDone;
  const uploadDone = new Promise(resolve => { resolveUploadDone = resolve; });
  sessionUploadDone = uploadDone;

  try {
    const snapshotTask = sessionIoTail.then(async () => {
      const snapshot = await collectSession();
      if (!snapshot['creds.json']) {
        throw new Error('La sesión está vacía o creds.json no pudo leerse');
      }
      validateSessionSnapshot(snapshot);
      return snapshot;
    });
    sessionIoTail = snapshotTask.then(() => undefined, () => undefined);
    const files = await snapshotTask;

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
    if (sha && existing.ok && !remotePrimarySessionRejected) {
      const currentFileResponse = await githubRequest(url);
      const existingFile = currentFileResponse.ok
        ? await currentFileResponse.json().catch(() => null)
        : null;
      if (existingFile?.content) {
        // Solo respaldar el archivo principal si contiene una sesión ya vinculada.
        // Un session.enc incompleto jamás debe pisar el último respaldo bueno.
        let existingSessionIsRegistered = false;
        try {
          const encryptedExisting = Buffer.from(existingFile.content.replace(/\n/g, ''), 'base64').toString('utf8');
          const filesExisting = JSON.parse(decryptSession(encryptedExisting));
          validateSessionSnapshot(filesExisting);
          existingSessionIsRegistered = true;
        } catch (validationError) {
          console.warn('⚠️ No se usará session.enc como respaldo porque no se pudo validar:', validationError.message);
        }

        if (existingSessionIsRegistered) {
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
        } else {
          console.warn('⏭️ No se reemplaza session.last-good.enc: session.enc no contiene una sesión vinculada válida.');
        }
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
    remotePrimarySessionRejected = false;
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
    resolveUploadDone();
    if (sessionUploadDone === uploadDone) sessionUploadDone = null;

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
    statusCode === 440 ? 30000 :
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


function scheduleSessionRestoreRetry(mode = 'backupOnly', attempt = 1) {
  if (!sessionSecurityReady() || shuttingDown || sessionRestoreRetryTimer) return;

  const delay = Math.min(15000 * Math.pow(2, Math.max(0, attempt - 1)), 120000);
  const modeText = mode === 'primaryOnly' ? 'sesión principal' : 'respaldo';
  pairingError = 'Recuperación automática de ' + modeText + ' en curso. La copia cifrada se conservará mientras se reintenta.';

  sessionRestoreRetryTimer = setTimeout(async () => {
    sessionRestoreRetryTimer = null;
    if (
      shuttingDown ||
      loginRefreshPromise ||
      connectionState === 'conectado' ||
      connectionState === 'conectando'
    ) return;

    const generation = socketGeneration;
    const options = { expectedGeneration: generation };
    if (mode === 'backupOnly') options.backupOnly = true;
    if (mode === 'primaryOnly') options.primaryOnly = true;

    let restored = false;
    try {
      restored = await downloadEncryptedSession(options);
    } catch (error) {
      console.error('⚠️ Reintento de recuperación de sesión:', error.message);
    }

    if (shuttingDown || generation !== socketGeneration) return;

    if (restored) {
      sessionRecoveryFailures = 0;
      pairingError = null;
      console.log('🛡️ Sesión recuperada automáticamente en el intento ' + attempt + '.');
      try {
        await startSocket(false);
      } catch (error) {
        console.error('❌ No se pudo iniciar WhatsApp después de restaurar la sesión:', error.message);
        scheduleReconnect(null);
      }
      return;
    }

    if (attempt < 5) {
      scheduleSessionRestoreRetry(mode, attempt + 1);
      return;
    }

    pairingError = 'No se pudo recuperar automáticamente la sesión tras varios intentos. Las copias cifradas se conservaron; puedes generar un nuevo código si necesitas vincular de nuevo.';
    console.error('❌ Finalizaron los reintentos de recuperación; no se eliminaron los respaldos restantes.');
  }, delay);
}

async function startSocketAfterWake() {
  if (shuttingDown) return;

  if (startupPromise && !startupReady) {
    try { await startupPromise; } catch {}
  }
  if (shuttingDown) return;

  // Una vinculación manual es dueña de la carpeta de sesión hasta que termina
  // de inicializar su socket. El keepalive no puede competir con ella.
  if (loginRefreshPromise) {
    try { await loginRefreshPromise; } catch {}
    return;
  }
  if (connectionState === 'conectado' || connectionState === 'conectando' || startSocketPromise) return;

  const credsPath = path.join(SESSION_DIR, 'creds.json');
  if (!fs.existsSync(credsPath) && sessionSecurityReady()) {
    const expectedGeneration = socketGeneration;
    await downloadEncryptedSession({ expectedGeneration });
    if (shuttingDown || expectedGeneration !== socketGeneration || loginRefreshPromise) return;
  }

  if (fs.existsSync(credsPath)) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch (error) {
      console.error('⚠️ Credenciales locales inválidas al despertar:', error.message);
      return;
    }
    if (saved?.registered === true) {
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
let startSocketPromise = null;
let startupPromise = null;
let startupReady = false;
let authTransitionTail = Promise.resolve();
let sessionIoTail = Promise.resolve();
let sessionUploadDone = null;
const pendingCredentialWrites = new Set();
let connectionState = 'desconectado';
let reconnectTimer = null;
let sessionRestoreRetryTimer = null;
let reconnectAttempts = 0;
let sessionRecoveryFailures = 0;
let remotePrimarySessionRejected = false;
let lastConnectedAt = null;
let lastDisconnectAt = null;
let lastDisconnectCode = null;
let lastDisconnectReason = null;
let socketGeneration = 0;
let shuttingDown = false;
const processing = new Set();
const processedMessageIds = new Set();
let lastMessageReceivedAt = null;
let lastMessageProcessedAt = null;

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

function serializeAuthTransition(action) {
  const operation = authTransitionTail.then(action, action);
  authTransitionTail = operation.catch(error => {
    console.error('❌ Falló una transición de autenticación:', error?.message || error);
  });
  return operation;
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    console.error('⚠️ Panel de administración bloqueado: configura ADMIN_PASSWORD en Render.');
    return res.status(503).type('text/plain').send(
      'Panel de vinculación desactivado. Configura ADMIN_PASSWORD en Render y vuelve a abrir esta página.'
    );
  }

  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="el-mejor-bot", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Autenticación requerida para administrar WhatsApp.');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {}

  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const supplied = Buffer.from(separator >= 0 ? decoded.slice(separator + 1) : '');
  const expected = Buffer.from(ADMIN_PASSWORD);
  const passwordMatches = supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);

  if (username !== 'admin' || !passwordMatches) {
    res.set('WWW-Authenticate', 'Basic realm="el-mejor-bot", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Usuario o contraseña incorrectos.');
  }

  return next();
}

async function requestPairingCodeIfNeeded() {
  if (!sock || !pairingNumber || pairingRequested) return;
  if (authState?.state?.creds?.registered) return;

  const requestSocket = sock;
  const requestGeneration = socketGeneration;
  const requestNumber = pairingNumber;
  pairingRequested = true;

  try {
    const code = await requestSocket.requestPairingCode(requestNumber);
    if (
      requestSocket !== sock ||
      requestGeneration !== socketGeneration ||
      requestNumber !== pairingNumber
    ) return;

    pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    pairingError = null;
    qrDataUrl = null;
    console.log('\\n🔢 CÓDIGO DE VINCULACIÓN:', pairingCode, '\\n');
  } catch (error) {
    if (requestGeneration !== socketGeneration || requestSocket !== sock) return;
    pairingRequested = false;
    pairingError = error?.message || 'No se pudo generar el código.';
    console.error('❌ Error generando código de vinculación:', pairingError);
  }
}

const FFMPEG_STICKER_TIMEOUT_MS = 90000;
const MAX_ANIMATED_STICKER_BYTES = 450 * 1024;
const MAX_VIDEO_STICKER_QUEUE = 30;
const videoQueue = [];
let videoQueueRunning = false;

function runStickerFfmpeg(command, output, label = 'FFmpeg') {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      console.error('⏱️ ' + label + ' excedió el límite de procesamiento.');
      try { command.kill('SIGKILL'); } catch {}
      finish(new Error('La conversión del video superó el límite de 90 segundos.'));
    }, FFMPEG_STICKER_TIMEOUT_MS);

    command
      .on('end', () => finish())
      .on('error', error => finish(error))
      .save(output);
  });
}

async function createAnimatedWebpSticker(buffer, duration = 10, fps = 12, quality = 55) {
  const actualDuration = Math.min(Math.max(Number(duration) || 10, 0.1), 10);
  const actualFps = Math.min(Math.max(Number(fps) || 12, 1), 15);
  const actualQuality = Math.min(Math.max(Number(quality) || 55, 20), 80);
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'el-mejor-bot-sticker-'));
  const input = path.join(tempDir, 'input');
  const output = path.join(tempDir, 'sticker.webp');

  try {
    await fs.promises.writeFile(input, buffer);
    const command = ffmpeg(input)
      .videoFilters([
        'fps=' + actualFps,
        'scale=512:512:force_original_aspect_ratio=increase:flags=bicubic',
        'crop=512:512:(iw-512)/2:(ih-512)/2',
        'setsar=1'
      ])
      .outputOptions([
        '-t ' + actualDuration,
        '-an',
        '-c:v libwebp_anim',
        '-lossless 0',
        '-q:v ' + actualQuality,
        '-compression_level 4',
        '-loop 0',
        '-preset picture',
        '-threads 2'
      ]);

    await runStickerFfmpeg(command, output, 'FFmpeg sticker animado');
    const result = await fs.promises.readFile(output);
    const inspection = inspectWebpAnimation(result);
    if (!inspection.valid || !inspection.animated) {
      throw new Error(
        'FFmpeg produjo un WebP inválido o estático (' +
        (inspection.reason || inspection.frameCount + ' fotogramas') +
        '). Se probará una conversión alternativa.'
      );
    }

    console.log(
      '🎞️ WebP animado validado: ' + inspection.frameCount + ' fotogramas, ' +
      Math.round(result.length / 1024 * 10) / 10 + ' KB, ' + actualFps + ' FPS.'
    );
    return result;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function enqueueVideoSticker(task) {
  if (videoQueue.length >= MAX_VIDEO_STICKER_QUEUE) {
    return Promise.reject(new Error('La cola de stickers de video está llena; vuelve a intentarlo en unos minutos.'));
  }
  return new Promise((resolve, reject) => {
    videoQueue.push({ task, resolve, reject });
    drainVideoQueue();
  });
}

async function drainVideoQueue() {
  if (videoQueueRunning) return;
  videoQueueRunning = true;
  try {
    while (videoQueue.length) {
      const job = videoQueue.shift();
      console.log('🎬 Procesando video. Cola restante:', videoQueue.length);
      try {
        job.resolve(await job.task());
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    videoQueueRunning = false;
  }
}

async function createFastVideoSticker(buffer, duration) {
  const actualDuration = Math.min(Math.max(Number(duration) || 10, 0.1), 10);
  const attempts = [
    { fps: 12, quality: 55, duration: actualDuration },
    { fps: 10, quality: 45, duration: actualDuration },
    { fps: 8, quality: 38, duration: actualDuration },
    { fps: 6, quality: 30, duration: Math.min(actualDuration, 8) }
  ];
  let lastError = null;

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    try {
      const result = await createAnimatedWebpSticker(
        buffer,
        attempt.duration,
        attempt.fps,
        attempt.quality
      );

      if (result.length <= MAX_ANIMATED_STICKER_BYTES) return result;
      lastError = new Error('El WebP animado pesa ' + Math.ceil(result.length / 1024) + ' KB (límite interno: 450 KB).');
      console.warn('⚠️ Sticker demasiado pesado; reintentando con menor FPS/calidad (' + (index + 2) + '/4).');
    } catch (error) {
      lastError = error;
      console.warn('⚠️ Intento de sticker animado ' + (index + 1) + '/4: ' + error.message);
    }
  }

  throw new Error(
    'No se pudo generar un sticker animado válido de menos de 450 KB tras 4 intentos. ' +
    (lastError?.message || 'Error de conversión desconocido.')
  );
}

async function createStickerWork(message, sourceMessage, mediaType) {
  const jid = message.key.remoteJid;

  // En vez de reacciones, avisar directamente sobre el mensaje que se
  // convertirá en sticker para que quede claro qué está procesando.
  try {
    await sock.sendMessage(
      jid,
      { text: mediaType === 'video'
        ? '🎥 Voy a empezar a hacer tu sticker. ⏳ Espera un momento...'
        : '⏳ Voy a empezar a hacer tu sticker. Espera un momento...' },
      { quoted: sourceMessage }
    );
  } catch (ackError) {
    console.error('⚠️ No se pudo enviar el aviso inicial; continuaré con el sticker:', ackError.message);
  }

  let buffer = await downloadMediaMessage(
    sourceMessage,
    'buffer',
    {},
    {
      logger: P({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage
    }
  );
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('WhatsApp no entregó el archivo multimedia completo. Intenta reenviar la imagen o el video.');
  }

  if (mediaType === 'video') {
    const videoMessage = unwrapMessage(sourceMessage)?.videoMessage || {};
    const duration = Number(videoMessage.seconds || 10);

    const stickerBuffer = await createFastVideoSticker(buffer, Math.min(duration, 10));

    // Liberar la referencia al video original antes de enviar.
    buffer = null;

    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    rememberActivity(jid, 'video');
  } else {
    // WhatsApp limita los stickers estáticos a 100 KB. Dejar margen evita
    // rechazos al volver a empaquetar/reenviar el sticker.
    const MAX_STATIC_STICKER_BYTES = 95 * 1024;
    let stickerBuffer = null;
    let lastSize = 0;

    for (const quality of [85, 75, 65, 55, 45, 35]) {
      const sticker = new Sticker(buffer, {
        pack: 'el mejor bot',
        author: 'el mejor bot',
        type: StickerTypes.DEFAULT,
        quality
      });
      const candidate = await sticker.toBuffer();
      const inspection = inspectWebpAnimation(candidate);

      if (!inspection.valid || inspection.animated) {
        throw new Error('La imagen no se convirtió en un WebP estático válido.');
      }
      lastSize = candidate.length;
      if (candidate.length <= MAX_STATIC_STICKER_BYTES) {
        stickerBuffer = candidate;
        break;
      }
      console.warn('⚠️ Sticker estático supera el límite; bajando calidad (' + Math.ceil(candidate.length / 1024) + ' KB).');
    }

    if (!stickerBuffer) {
      throw new Error('La imagen no cabe en el límite de 95 KB para stickers estáticos (último intento: ' + Math.ceil(lastSize / 1024) + ' KB).');
    }

    buffer = null;
    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    rememberActivity(jid, 'image');
  }

}

async function createSticker(message, sourceMessage, mediaType) {
  const id = message.key.id;
  if (processing.has(id)) return;
  processing.add(id);

  const run = () => createStickerWork(message, sourceMessage, mediaType);

  try {
    if (mediaType === 'video') {
      await enqueueVideoSticker(run);
    } else {
      await run();
    }
  } catch (error) {
    console.error('Error creando sticker:', error);

    let reason = error?.message || error?.toString?.() || 'Error desconocido';
    reason = reason
      .replace(/\s+/g, ' ')
      .replace(/^Error:\s*/i, '')
      .trim();

    if (reason.length > 220) reason = reason.slice(0, 217) + '...';

    await sendText(
      message.key.remoteJid,
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
  if (update?.type && update.type !== 'notify') return;
  const messageId = message.key?.id;
  const processedId = messageId
    ? [message.key?.remoteJid || '', message.key?.participant || '', messageId].join(':')
    : null;
  if (processedId) {
    if (processedMessageIds.has(processedId)) return;
    processedMessageIds.add(processedId);
    if (processedMessageIds.size > 2000) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }
  }
  lastMessageReceivedAt = new Date().toISOString();

  const text = getText(message);

  // Registro ligero en memoria: no toca GitHub aquí.
  // Solo actualiza RAM y el guardado se agrupa en segundo plano.
  rememberActivity(message.key?.remoteJid, null);
  lastMessageProcessedAt = new Date().toISOString();

  if (/^liberarcache$/i.test(text.trim())) {
    const descargas = liberarColaDescargas();
    const stickersCancelados = videoQueue.splice(0);
    for (const job of stickersCancelados) {
      job.reject(new Error('Solicitud cancelada por liberarcache.'));
    }
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
    const estado = estadoColaDescargas();
    const memoria = process.memoryUsage();
    const mb = bytes => Math.round(bytes / 1024 / 1024);
    return sendText(
      message.key.remoteJid,
      '🧹 *LIBERARCACHE*\n\n' +
      '📥 Descargas pendientes canceladas: ' + descargas.pendientesCancelados + '\n' +
      '🎬 Stickers de video pendientes cancelados: ' + stickersCancelados.length + '\n' +
      '⏳ Descarga activa: ' + (estado.descargaActiva ? 'sí (' + estado.segundosActiva + ' s)' : 'no') + '\n' +
      '📦 Descargas pendientes restantes: ' + estado.pendientes + '\n' +
      '🧠 RAM usada: ' + mb(memoria.heapUsed) + ' MB heap; ' + mb(memoria.rss) + ' MB total\n' +
      (typeof global.gc === 'function'
        ? '✅ Recolección de memoria solicitada.'
        : 'ℹ️ La recolección automática de memoria sigue activa; este proceso no permite forzarla.') + '\n\n' +
      'Nota: no se borra la sesión ni la memoria persistente. Si una descarga activa está bloqueada, tiene un límite de tiempo y no se cancela a la fuerza.',
      message
    );
  }

  if (/^(menu|ayuda|help)$/i.test(text)) {
    return sendText(
      message.key.remoteJid,
      '🤖 *el mejor bot*\n\n📸 Imagen + *sticker*\n🎥 Video + *sticker*\n⬇️ Envía un enlace público de TikTok, Instagram, YouTube, X, Pinterest, Facebook, Reddit, Threads u otro sitio compatible. También acepta enlaces directos de imagen o video; usa *descargar enlace* para sitios genéricos.\n🧹 *liberarcache* para limpiar colas pendientes y revisar procesos.\n↩️ También puedes responder una imagen o video con *sticker*.',
      message
    );
  }

  const trimmedText = text.trim();
  const genericDownload = trimmedText.match(/^(?:descargar|descarga|download)\s+([\s\S]+)$/i);
  if (genericDownload) {
    const url = extraerUrl(genericDownload[1], 'auto');
    if (!url) {
      return sendText(message.key.remoteJid, '⚠️ Usa: descargar https://enlace-publico-de-imagen-o-video', message);
    }
    return comandoDescargaSocial(
      sock,
      message.key.remoteJid,
      message,
      url,
      detectarPlataforma(url) || 'auto'
    );
  }

  const socialMatch = trimmedText.match(/^(tiktok|instagram|x|twitter|youtube|youtu\.be|pinterest|facebook|reddit|threads)\b/i);
  if (socialMatch) {
    const comando = socialMatch[1].toLowerCase();
    const plataforma = comando === 'twitter' ? 'x' : comando === 'youtu.be' ? 'youtube' : comando;
    const argumentos = trimmedText.replace(/^(tiktok|instagram|x|twitter|youtube|youtu\.be|pinterest|facebook|reddit|threads)\b/i, '').trim();
    return comandoDescargaSocial(sock, message.key.remoteJid, message, argumentos, plataforma);
  }

  // Descargar automáticamente enlaces públicos a contenido multimedia, aunque
  // el host no tenga un extractor dedicado. Para texto normal se requiere una URL sola.
  const isBareUrl = /^(?:https?:\/\/)?(?:[a-z0-9.-]+)(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(trimmedText);
  if (isBareUrl) {
    const url = extraerUrl(trimmedText, 'auto');
    if (url) {
      return comandoDescargaSocial(
        sock,
        message.key.remoteJid,
        message,
        url,
        detectarPlataforma(url) || 'auto'
      );
    }
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
    // No tocar la carpeta mientras el arranque inicial todavía está restaurando
    // el respaldo cifrado remoto.
    if (startupPromise && !startupReady) {
      try { await startupPromise; } catch {}
    }
    // Esperar al socket en curso y bloquear inmediatamente cualquier callback
    // viejo, para que no pueda restaurar o escribir encima de la nueva sesión.
    if (startSocketPromise) {
      try { await startSocketPromise; } catch {}
    }
    clearTimeout(reconnectTimer);
    clearTimeout(uploadTimer);
    socketGeneration += 1;
    await Promise.allSettled([...pendingCredentialWrites]);
    if (sessionUploadDone) await sessionUploadDone;
    clearTimeout(uploadTimer);
    uploadAgain = false;
    await sessionIoTail.catch(() => {});
    restoredSessionSource = null;
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
  if (startSocketPromise) return startSocketPromise;

  const started = startSocketInternal(restoreSession);
  startSocketPromise = started;
  try {
    return await started;
  } finally {
    if (startSocketPromise === started) startSocketPromise = null;
  }
}

async function startSocketInternal(restoreSession = true) {
  if (shuttingDown) return null;
  if (sock && (connectionState === 'conectado' || connectionState === 'conectando')) return sock;

  const generationBeforeRestore = socketGeneration;
  if (restoreSession && sessionSecurityReady()) {
    await downloadEncryptedSession({ expectedGeneration: generationBeforeRestore });
    if (shuttingDown || generationBeforeRestore !== socketGeneration) return null;
  }

  const socketAuthState = await useMultiFileAuthState(SESSION_DIR);
  if (shuttingDown || generationBeforeRestore !== socketGeneration) return null;
  authState = socketAuthState;
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

  // Baileys puede emitir varios creds.update seguidos. Todas las escrituras y
  // los snapshots remotos comparten una misma cola de I/O para no mezclar archivos.
  newSock.ev.on('creds.update', async () => {
    if (shuttingDown || myGeneration !== socketGeneration || sock !== newSock) return;

    const task = sessionIoTail.then(async () => {
      if (myGeneration !== socketGeneration || sock !== newSock) return;
      await socketAuthState.saveCreds();
      if (myGeneration !== socketGeneration || sock !== newSock) return;

      if (socketAuthState?.state?.creds?.registered === true) {
        scheduleSessionUpload(1500);
      }
    });
    pendingCredentialWrites.add(task);
    sessionIoTail = task.catch(error => {
      console.error('❌ Error guardando credenciales locales:', error.message);
    });

    try {
      await task;
    } catch (error) {
      console.error('❌ Falló una escritura serializada de credenciales:', error.message);
    } finally {
      pendingCredentialWrites.delete(task);
    }
  });

  newSock.ev.on('messages.upsert', async update => {
    // 'append' suele ser historial o mensajes añadidos posteriormente; procesar
    // solo notificaciones nuevas evita ejecutar dos veces comandos/descargas.
    if (update?.type && update.type !== 'notify') return;
    for (const message of update?.messages || []) {
      try {
        // No bloquear la recepción de mensajes mientras FFmpeg/Sticker Formatter
        // procesa un sticker. Así el bot puede seguir contestando y recibiendo
        // mensajes aunque un video tarde en convertirse.
        handleMessage({ type: update?.type, messages: [message] }).catch(error => {
          console.error('Error procesando mensaje:', error);
        });
      } catch (error) {
        console.error('Error iniciando procesamiento del mensaje:', error);
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
          const generatedQr = await QRCode.toDataURL(qr);
          if (myGeneration !== socketGeneration || sock !== newSock) return;
          qrDataUrl = generatedQr;
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
      // No competir con FFmpeg justo al conectar. El respaldo de sesión sigue
      // haciéndose automáticamente, pero unos segundos después.
      scheduleSessionUpload(10000);
      return;
    }

    if (connection === 'close') {
      const statusCode = getDisconnectCode(lastDisconnect);
      const reason = getDisconnectReason(lastDisconnect);
      const rejectedSourceAtClose = restoredSessionSource;
      const registeredSessionAtClose = socketAuthState?.state?.creds?.registered === true;
      const pairingWasInProgress = Boolean(pairingNumber) || !registeredSessionAtClose;

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

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession ||
        statusCode === 401
      ) {
        sessionRecoveryFailures += 1;
        console.error('🚪 WhatsApp rechazó la sesión (LOGGED OUT / BAD SESSION). Se comprobarán las copias cifradas.');
        qrDataUrl = null;
        pairingCode = null;
        pairingNumber = null;
        pairingRequested = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;

        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch {}
        fs.mkdirSync(SESSION_DIR, { recursive: true });

        const rejectedSource = rejectedSourceAtClose;
        restoredSessionSource = null;

        // Una vinculación manual incompleta nunca debe sustituirse por un vínculo viejo.
        if (pairingWasInProgress) {
          pairingError = 'No se pudo completar la vinculación. Genera un nuevo código e inténtalo otra vez.';
          connectionState = 'desconectado';
          return;
        }

        if (!sessionSecurityReady()) {
          pairingError = 'WhatsApp rechazó las credenciales y no hay respaldo cifrado configurado. Revisa GITHUB_TOKEN y SESSION_PASSWORD.';
          connectionState = 'desconectado';
          return;
        }

        // Si WhatsApp rechazó el respaldo, retiramos únicamente esa copia e
        // intentamos la principal en modo aislado, sin volver al mismo respaldo.
        if (rejectedSource === LAST_GOOD_SESSION_FILE) {
          await deleteEncryptedSessionFile(LAST_GOOD_SESSION_FILE);
          if (myGeneration !== socketGeneration) return;

          const primaryRestored = await downloadEncryptedSession({
            primaryOnly: true,
            expectedGeneration: myGeneration
          });
          if (myGeneration !== socketGeneration) return;

          if (primaryRestored) {
            sessionRecoveryFailures = 0;
            pairingError = null;
            console.warn('🛡️ El respaldo fue rechazado; se conserva la sesión principal y se volverá a probar.');
            scheduleReconnect(statusCode);
            return;
          }

          connectionState = 'desconectado';
          scheduleSessionRestoreRetry('primaryOnly', 1);
          return;
        }

        // Si la principal fue rechazada, no se promueve a last-good.
        const backupRestored = await downloadEncryptedSession({
          backupOnly: true,
          expectedGeneration: myGeneration
        });
        if (myGeneration !== socketGeneration) return;

        if (rejectedSource === ENCRYPTED_SESSION_FILE) {
          remotePrimarySessionRejected = true;
          const primaryDeleted = await deleteEncryptedSession();
          if (myGeneration !== socketGeneration) return;
          if (!primaryDeleted) {
            console.warn('⚠️ No se pudo retirar session.enc rechazada; se omitirá como respaldo hasta guardar una sesión nueva.');
          }
        }

        if (backupRestored) {
          sessionRecoveryFailures = 0;
          pairingError = null;
          console.warn('🛡️ Sesión alternativa restaurada; se intentará reconectar.');
          scheduleReconnect(statusCode);
          return;
        }

        connectionState = 'desconectado';
        scheduleSessionRestoreRetry('backupOnly', 1);
        return;
      }

      if (statusCode !== 515) {
        pairingRequested = false;
      }

      // Los códigos 440 (conflicto) y 408/428 (transitorios) no significan
      // que las credenciales estén corruptas. Nunca borrar la sesión por ellos.
      if (statusCode === 440) {
        sessionRecoveryFailures = 0;
        console.warn('⚠️ Conflicto 440: se conservarán las credenciales. Comprueba que solo haya una instancia del bot conectada a este WhatsApp.');
        scheduleReconnect(statusCode);
        return;
      }

      if (statusCode === 408 || statusCode === 428 || statusCode === 515) {
        sessionRecoveryFailures = 0;
        console.warn('⚠️ Desconexión transitoria (' + statusCode + '); se conservará la sesión.');
        scheduleReconnect(statusCode);
        return;
      }

      scheduleReconnect(statusCode);
    }
  });

  return newSock;
}

app.get('/', requireAdminAuth, async (_req, res) => {
  try {
    if (startupPromise && !startupReady) {
      try { await startupPromise; } catch {}
    }
    if (startupReady && !authState?.state?.creds?.registered && connectionState === 'desconectado') {
      await startSocket(false);
    }
  } catch (error) {
    pairingError = error?.message || 'No se pudo iniciar WhatsApp.';
  }

  const qr = qrDataUrl
    ? '<img id="qrImage" src="' + qrDataUrl + '" alt="QR" style="width:280px;height:280px">'
    : '<p id="qrEmpty">No hay QR disponible.</p>';

  const codeHtml = pairingCode
    ? '<div id="pairingCodeValue" style="font-size:30px;font-weight:bold;letter-spacing:5px;margin:20px">' + pairingCode + '</div><p id="pairingHelp">En WhatsApp: Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono.</p>'
    : pairingError
      ? '<p id="pairingCodeValue" style="color:#b91c1c">❌ ' + pairingError + '</p>'
      : '<p id="pairingCodeValue">Escribe tu número y pulsa Generar código.</p>';

  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>el mejor bot</title>
<style>
body{font-family:Arial,sans-serif;max-width:620px;margin:30px auto;padding:20px;text-align:center}
.card{border:1px solid #ddd;border-radius:14px;padding:20px;margin:15px 0}
input{padding:12px;width:90%;max-width:320px;margin:6px;font-size:16px}
button{padding:12px 18px;border:0;border-radius:8px;cursor:pointer}
</style>
</head>
<body>
<h1>🤖 el mejor bot</h1>
<p>Estado: <b id="connectionState">${connectionState}</b></p>

<div class="card"><h2>QR</h2><div id="qrContainer">${qr}</div></div>

<div class="card">
<h2>Código de 8 dígitos</h2>
<form method="POST" action="/iniciar">
<input id="numero" name="numero" placeholder="521XXXXXXXXXX" required autocomplete="tel" inputmode="numeric">
<br><button type="submit">Generar código</button>
</form>
<div id="pairingContainer">${codeHtml}</div>
</div>

<div class="card">
<form method="POST" action="/cerrar-sesion">
<button type="submit">Cerrar sesión</button>
</form>
</div>

<script>
async function actualizarEstado() {
  try {
    const response = await fetch('/estado-vinculacion', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();

    document.getElementById('connectionState').textContent = data.estado || 'desconectado';

    const pairingContainer = document.getElementById('pairingContainer');

    if (data.pairingCode) {
      pairingContainer.innerHTML =
        '<div style="font-size:30px;font-weight:bold;letter-spacing:5px;margin:20px">' +
        data.pairingCode +
        '</div><p>En WhatsApp: Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono.</p>';
    } else if (data.pairingError) {
      pairingContainer.innerHTML =
        '<p style="color:#b91c1c">❌ ' + data.pairingError + '</p>';
    }
  } catch {}
}

setInterval(actualizarEstado, 2000);
actualizarEstado();
</script>
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
    memoriaCargada: memoryLoaded,
    memoriaPendiente: memoryDirty,
    ultimaGuardadoMemoria: lastMemorySaveAt,
    ultimaGuardadoMemoriaExitoso: lastMemorySaveOk,
    ultimoErrorMemoria: lastMemorySaveError,
    ramaMemoria: MEMORY_BRANCH,
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

app.get('/estado-vinculacion', requireAdminAuth, (_req, res) => {
  res.json({
    conectado: connectionState === 'conectado',
    estado: connectionState,
    pairingCode,
    pairingError,
    qrDataUrl
  });
});

app.post('/iniciar', requireAdminAuth, async (req, res) => {
  const numero = normalizePhoneNumber(req.body.numero);

  if (!numero) return res.status(400).send('Número inválido.');
  if (numero.length < 8 || numero.length > 15) {
    return res.status(400).send('Número inválido. Usa código de país y solo números.');
  }

  try {
    await serializeAuthTransition(async () => {
      if (startupPromise && !startupReady) {
        try { await startupPromise; } catch {}
      }

      pairingNumber = numero;
      pairingCode = null;
      pairingRequested = false;
      pairingError = null;
      qrDataUrl = null;

      await restartForFreshLogin();
      setTimeout(() => requestPairingCodeIfNeeded(), 500);
    });

    res.redirect('/');
  } catch (error) {
    pairingRequested = false;
    pairingError = error?.message || 'No se pudo iniciar la vinculación.';
    console.error('Error al iniciar vinculación:', error);
    res.redirect('/');
  }
});

async function logoutAndForgetSession() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  clearTimeout(uploadTimer);
  socketGeneration += 1;
  const inFlightStart = startSocketPromise;
  if (inFlightStart) {
    try { await inFlightStart; } catch {}
  }

  // Dejar terminar las escrituras ya iniciadas; después invalidar la sesión en
  // WhatsApp y eliminar ambos archivos cifrados para que un redeploy no restaure
  // una sesión que el usuario pidió cerrar.
  await Promise.allSettled([...pendingCredentialWrites]);
  if (sessionUploadDone) await sessionUploadDone;
  await sessionIoTail.catch(() => {});

  const currentSocket = sock;
  try {
    if (currentSocket) await currentSocket.logout();
  } catch (error) {
    console.warn('⚠️ WhatsApp no confirmó el cierre remoto:', error?.message || error);
  }

  let remoteSessionClean = true;
  if (sessionSecurityReady()) {
    const [primaryDeleted, backupDeleted] = await Promise.all([
      deleteEncryptedSession(),
      deleteEncryptedSessionFile(LAST_GOOD_SESSION_FILE)
    ]);
    remoteSessionClean = primaryDeleted && backupDeleted;
    if (!remoteSessionClean) {
      console.error('❌ No se pudieron borrar todos los respaldos remotos; una sesión antigua podría seguir disponible en GitHub.');
    }
  }

  try {
    if (currentSocket) {
      try { currentSocket.ev.removeAllListeners(); } catch {}
      try { currentSocket.ws?.close(); } catch {}
    }
  } finally {
    sock = null;
    authState = null;
    restoredSessionSource = null;
    qrDataUrl = null;
    pairingCode = null;
    pairingNumber = null;
    pairingRequested = false;
    pairingError = null;
    lastQrAt = 0;
    connectionState = 'desconectado';
    reconnectAttempts = 0;
    sessionRecoveryFailures = 0;

    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    shuttingDown = false;
  }

  return remoteSessionClean;
}

app.post('/cerrar-sesion', requireAdminAuth, async (_req, res) => {
  try {
    await serializeAuthTransition(logoutAndForgetSession);
  } catch (error) {
    console.error('❌ Error cerrando sesión:', error.message);
  }
  res.redirect('/');
});

app.get('/limpiar-whatsapp', requireAdminAuth, async (_req, res) => {
  try {
    const remoteSessionClean = await serializeAuthTransition(logoutAndForgetSession);
    res.status(remoteSessionClean ? 200 : 503).json({
      ok: remoteSessionClean,
      mensaje: remoteSessionClean
        ? 'Sesión local y respaldos remotos limpiados.'
        : 'Sesión local limpiada, pero falló el borrado de uno o más respaldos remotos.'
    });
  } catch (error) {
    console.error('❌ Error limpiando WhatsApp:', error.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo completar la limpieza.' });
  }
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
    await Promise.allSettled([...pendingCredentialWrites]);
    if (sessionUploadDone) await sessionUploadDone;
    await sessionIoTail.catch(() => {});
    if (authState?.saveCreds) await authState.saveCreds();

    // Al apagar Render, jamás subir una sesión de vinculación incompleta.
    // Solo conservamos/reemplazamos el respaldo remoto si ya está registrada.
    if (authState?.state?.creds?.registered === true) {
      await uploadEncryptedSession();
    } else {
      console.log('⏸️ Apagado: no se sobrescribe la sesión de GitHub porque no está vinculada.');
    }

    clearTimeout(memorySaveTimer);
    await savePersistentMemory();
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

app.listen(PORT, () => {
  console.log('el mejor bot en puerto ' + PORT);

  // Express comienza a escuchar antes de que termine la restauración remota.
  // Marcar esta promesa permite bloquear /, keepalive y un nuevo login durante
  // esa ventana; así nunca se crea un socket con una carpeta vacía.
  startupPromise = (async () => {
    try {
      if (sessionSecurityReady()) {
        await downloadEncryptedSession();
        await loadPersistentMemory();
      } else {
        console.warn('⚠️ Render no tiene configurados GITHUB_TOKEN + SESSION_PASSWORD; la sesión y memoria no podrán sobrevivir a un redeploy.');
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
          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          } catch {}
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          // Mantener el respaldo remoto para que una vinculación interrumpida
          // nunca destruya la última sesión válida.
          connectionState = 'desconectado';
          pairingError = 'La sesión anterior estaba incompleta. Genera un nuevo código de vinculación.';
        }
      } else {
        console.log('Sin sesión válida. Esperando QR o código solicitado por el usuario.');
      }
    } catch (error) {
      console.error('❌ Error restaurando sesión inicial:', error.message);
      scheduleReconnect(null);
    }
  })().finally(() => {
    startupReady = true;
  });
});
