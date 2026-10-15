require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('pino');
const QRCode = require('qrcode');
const sharp = require('sharp');

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { inspectWebpAnimation, parseMediaSizeBytes, resolveStickerDurationSeconds, buildVideoStickerAttempts, MAX_ANIMATED_STICKER_BYTES } = require('./stickerUtils');
const { validateSessionSnapshot } = require('./sessionUtils');

const crypto = require('crypto');
const { execFile } = require('child_process');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { comandoDescargaSocial, extraerUrl, analizarSolicitudDescarga, detectarPlataforma, MAX_MEDIA_BYTES, liberarColaDescargas, estadoColaDescargas } = require('./descargasSociales');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GITHUB_REPO = process.env.GITHUB_REPO || 'alpizar269708-crypto/el-mejor-bot';
const SESSION_BRANCH = process.env.SESSION_BRANCH || 'session-data';
// La sesión anterior se guardaba en main. Se conserva como fuente de recuperación
// de solo lectura mientras session-data vuelve a tener un session.enc válido.
const LEGACY_SESSION_BRANCH = process.env.LEGACY_SESSION_BRANCH || 'main';
// Ramas históricas detectadas con copias de session.enc. Solo se consultan
// después de la rama principal, el respaldo y la rama heredada; nunca se borran.
const SESSION_FALLBACK_BRANCHES = (process.env.SESSION_FALLBACK_BRANCHES ||
  'fix/descargas-hd,feature/tiktok-instagram-downloads,memory-data')
  .split(',')
  .map(branch => branch.trim())
  .filter((branch, index, all) =>
    branch && branch !== SESSION_BRANCH && branch !== LEGACY_SESSION_BRANCH &&
    all.indexOf(branch) === index
  );
const SESSION_PASSWORD = process.env.SESSION_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || SESSION_PASSWORD?.trim() || null;
const ENCRYPTED_SESSION_FILE = 'session.enc';
const LAST_GOOD_SESSION_FILE = 'session.last-good.enc';
let restoredSessionSource = null;
let restoredSessionBranch = null;
// Copias remotas rechazadas por WhatsApp se conservan, pero no se reintentan
// una y otra vez dentro del mismo proceso hasta que se guarde una sesión nueva.
const rejectedRemoteSessionSources = new Set();

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

function moveDirectoryPortable(source, destination) {
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }

  // Render puede montar directorios en dispositivos distintos. En ese caso,
  // copiar primero y retirar el origen solo después de completar la copia.
  fs.cpSync(source, destination, { recursive: true, errorOnExist: false, force: false });
  fs.rmSync(source, { recursive: true, force: true });
}

function quarantineLocalSessionDirectory(reason = 'rejected') {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    return true;
  }

  const safeReason = String(reason).replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'session';
  const destination = path.join(
    path.dirname(SESSION_DIR),
    '.session-quarantine-' + safeReason + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex')
  );

  try {
    // Apartar la carpeta completa en vez de destruir credenciales locales.
    // Está fuera de SESSION_DIR, así que no se sube como sesión activa.
    moveDirectoryPortable(SESSION_DIR, destination);
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    console.warn('📦 La copia local de la sesión se apartó para conservarla; no se borró.');
    return true;
  } catch (error) {
    console.error('❌ No se pudo apartar la copia local de sesión sin borrarla:', error.message);
    return false;
  }
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
      moveDirectoryPortable(SESSION_DIR, previousDir);
      movedPrevious = true;
    }

    try {
      moveDirectoryPortable(restoreDir, SESSION_DIR);
    } catch (error) {
      if (movedPrevious && !fs.existsSync(SESSION_DIR)) {
        try { moveDirectoryPortable(previousDir, SESSION_DIR); } catch (restoreError) { console.error('❌ No se pudo recuperar la carpeta anterior tras fallar la restauración:', restoreError.message); }
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
  const legacyOnly = options.legacyOnly === true;
  const allowLegacyFallback =
    LEGACY_SESSION_BRANCH !== SESSION_BRANCH &&
    (legacyOnly || (options.allowLegacyFallback !== false && !backupOnly && !primaryOnly));
  const expectedGeneration = options.expectedGeneration ?? socketGeneration;
  const invalidSnapshots = [];
  const restoreIssues = [];

  async function tryRestore(filename, label, branch = SESSION_BRANCH) {
    const sourceKey = branch + ':' + filename;
    if (rejectedRemoteSessionSources.has(sourceKey)) return false;

    const url = 'https://api.github.com/repos/' + GITHUB_REPO +
      '/contents/' + filename + '?ref=' + encodeURIComponent(branch);
    const response = await githubRequest(url);

    if (response.status === 404) return false;
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error('GitHub HTTP ' + response.status + (details ? ' - ' + details.slice(0, 300) : ''));
    }

    const file = await response.json();
    const encrypted = Buffer.from(String(file.content || '').replace(/\\n/g, ''), 'base64').toString('utf8');
    const decrypted = decryptSession(encrypted);
    const files = JSON.parse(decrypted);

    try {
      validateSessionSnapshot(files);
    } catch (error) {
      invalidSnapshots.push({ filename, branch, message: error.message });
      // No reintentar la misma copia defectuosa continuamente en este proceso.
      // Una subida nueva y válida limpia esta lista de bloqueos.
      rejectedRemoteSessionSources.add(sourceKey);
      return false;
    }

    if (shuttingDown || expectedGeneration !== socketGeneration) {
      console.warn('⏭️ Se cancela la restauración de ' + filename + ': empezó otra operación de sesión.');
      return false;
    }

    restoreSessionFiles(files, filename);
    restoredSessionSource = filename;
    restoredSessionBranch = branch;
    console.log(label);
    return true;
  }

  // Primero se intenta la rama de sesiones actual.
  if (!backupOnly && !legacyOnly) {
    try {
      if (await tryRestore(ENCRYPTED_SESSION_FILE, 'Sesión cifrada restaurada desde GitHub.', SESSION_BRANCH)) return true;
    } catch (error) {
      restoreIssues.push({ filename: ENCRYPTED_SESSION_FILE, branch: SESSION_BRANCH, message: error.message });
    }
  }

  if (primaryOnly) {
    for (const issue of restoreIssues) {
      console.warn('⚠️ No se pudo restaurar ' + issue.filename + ' desde ' + issue.branch + ': ' + issue.message);
    }
    for (const invalid of invalidSnapshots) {
      console.warn('⚠️ Se ignora ' + invalid.filename + ' en ' + invalid.branch + ': ' + invalid.message);
    }
    console.warn('ℹ️ No se restauró session.enc; se evita reutilizar un respaldo que WhatsApp ya rechazó.');
    restoredSessionSource = null;
    restoredSessionBranch = null;
    return false;
  }

  // El respaldo solo se usa si la principal no sirve; los avisos se difieren
  // hasta saber si otra copia válida puede recuperar la sesión.
  if (!legacyOnly) try {
    if (await tryRestore(LAST_GOOD_SESSION_FILE, '🛡️ Sesión restaurada desde el respaldo de última sesión válida.', SESSION_BRANCH)) return true;
  } catch (error) {
    restoreIssues.push({ filename: LAST_GOOD_SESSION_FILE, branch: SESSION_BRANCH, message: error.message });
  }

  // Históricamente el bot también guardó session.enc en main. Si la rama
  // dedicada no tiene una sesión válida, probar esa copia cifrada antes de
  // concluir que hace falta volver a vincular WhatsApp.
  if (allowLegacyFallback) {
    try {
      if (await tryRestore(
        ENCRYPTED_SESSION_FILE,
        '🛡️ Sesión cifrada recuperada desde la rama heredada ' + LEGACY_SESSION_BRANCH + '.',
        LEGACY_SESSION_BRANCH
      )) return true;
    } catch (error) {
      restoreIssues.push({ filename: ENCRYPTED_SESSION_FILE, branch: LEGACY_SESSION_BRANCH, message: error.message });
    }
  }

  // Algunas versiones anteriores guardaron session.enc en ramas de trabajo.
  // Probarlas como último recurso evita pedir una nueva vinculación si aún existe
  // una sesión válida. Se conserva cada archivo remoto incluso si WhatsApp lo rechaza.
  if (!backupOnly && !primaryOnly && !legacyOnly) {
    for (const fallbackBranch of SESSION_FALLBACK_BRANCHES) {
      try {
        if (await tryRestore(
          ENCRYPTED_SESSION_FILE,
          '🛡️ Sesión cifrada recuperada desde rama alternativa ' + fallbackBranch + '.',
          fallbackBranch
        )) return true;
      } catch (error) {
        restoreIssues.push({
          filename: ENCRYPTED_SESSION_FILE,
          branch: fallbackBranch,
          message: error.message
        });
      }
    }
  }

  // Los fallos de copias históricas no llenan los logs de cada deploy.
  // El diagnóstico detallado se activa manualmente con SESSION_DEBUG=1.
  if (process.env.SESSION_DEBUG === '1') {
    if (invalidSnapshots.length || restoreIssues.length) {
      console.warn(
        'SESSION_DEBUG: no se encontró una copia cifrada completa; se conservaron las copias remotas ' +
        '(incompletas: ' + invalidSnapshots.length + ', errores: ' + restoreIssues.length + ').'
      );
      for (const invalid of invalidSnapshots) {
        console.warn('SESSION_DEBUG: ' + invalid.filename + ' en ' + invalid.branch + ': ' + invalid.message);
      }
      for (const issue of restoreIssues) {
        console.warn('SESSION_DEBUG: ' + issue.filename + ' desde ' + issue.branch + ': ' + issue.message);
      }
    } else if (backupOnly) {
      console.warn('SESSION_DEBUG: no se pudo recuperar ninguna sesión válida del respaldo; las copias se conservaron.');
    } else {
      console.log('SESSION_DEBUG: no hay una copia cifrada válida para restaurar; no se borró ninguna copia remota.');
    }
  }
  restoredSessionSource = null;
  restoredSessionBranch = null;
  return false;
}

async function deleteEncryptedSessionFile(filename = ENCRYPTED_SESSION_FILE, branch = SESSION_BRANCH) {
  if (!sessionSecurityReady()) return false;

  try {
    const url = 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + filename + '?ref=' + encodeURIComponent(branch);
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
        branch
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
      // .gitkeep solo mantiene vacía la carpeta en GitHub; no forma parte
      // de las credenciales de Baileys y nunca debe entrar al respaldo cifrado.
      if (entry.name === '.gitkeep') continue;
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

    restoredSessionSource = ENCRYPTED_SESSION_FILE;
    restoredSessionBranch = SESSION_BRANCH;
    lastSessionUploadOk = true;
    lastSessionUploadError = null;
    sessionUploadFailures = 0;
    rejectedRemoteSessionSources.clear();
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
    if (mode === 'legacyOnly') options.legacyOnly = true;

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
  } else {
    // Si no hay sesión local, inicializar igualmente el socket para preparar
    // QR/vinculación y no depender de visitar la web o mandar un comando.
    await startSocket(false);
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
let onlineAnnouncementSent = false;
let lastDisconnectAt = null;
let lastDisconnectCode = null;
let lastDisconnectReason = null;
let socketGeneration = 0;
let shuttingDown = false;
const processing = new Set();
const processedMessageIds = new Set();
let lastMessageReceivedAt = null;
let lastMessageProcessedAt = null;
let lastMessageChatType = null;
let lastMessageJid = null;

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
    console.error('⚠️ Panel de administración bloqueado: configura ADMIN_PASSWORD en el entorno de ejecución.');
    return res.status(503).type('text/plain').send(
      'Panel de vinculación desactivado. Configura ADMIN_PASSWORD en el entorno de ejecución y vuelve a abrir esta página.'
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
    console.log('\n🔢 CÓDIGO DE VINCULACIÓN:', pairingCode, '\n');
  } catch (error) {
    if (requestGeneration !== socketGeneration || requestSocket !== sock) return;
    pairingRequested = false;
    pairingError = error?.message || 'No se pudo generar el código.';
    console.error('❌ Error generando código de vinculación:', pairingError);
  }
}

const FFMPEG_STICKER_TIMEOUT_MS = 90000;
const MAX_STICKER_QUEUE = 30;
// Solo los videos compiten por los dos espacios de conversión; las imágenes
// empiezan inmediatamente y nunca esperan detrás de un video.
const MAX_STICKER_VIDEO_CONCURRENCY = 2;
const stickerQueue = [];
const activeStickerJobs = new Set();
const activeStickerVideoJobs = new Set();
const activeStickerFfmpeg = new Set();
const activeStickerProbeProcesses = new Set();

function runStickerProbe(args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    child = execFile(ffmpegInstaller.path, args, options, (error, stdout, stderr) => {
      activeStickerProbeProcesses.delete(child);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    activeStickerProbeProcesses.add(child);
  });
}

function runStickerFfmpeg(command, output, label = 'FFmpeg') {
  return new Promise((resolve, reject) => {
    let finished = false;
    activeStickerFfmpeg.add(command);
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      activeStickerFfmpeg.delete(command);
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

async function createAnimatedWebpSticker(buffer, duration = 3, fps = 12, quality = 55, contentSize = 512) {
  const actualDuration = Math.min(Math.max(Number(duration) || 3, 0.1), 10);
  const actualFps = Math.min(Math.max(Number(fps) || 12, 1), 15);
  const actualQuality = Math.min(Math.max(Number(quality) || 55, 10), 80);
  const actualContentSize = Math.min(Math.max(Math.round((Number(contentSize) || 512) / 2) * 2, 320), 512);
  const videoFilters = [
    'fps=' + actualFps,
    'scale=' + actualContentSize + ':' + actualContentSize + ':force_original_aspect_ratio=increase:flags=bicubic',
    'crop=' + actualContentSize + ':' + actualContentSize + ':(iw-' + actualContentSize + ')/2:(ih-' + actualContentSize + ')/2'
  ];
  if (actualContentSize < 512) {
    // Mantener lienzo 512x512 requerido por WhatsApp, reduciendo el área útil
    // para ahorrar bytes sin bajar tanto los FPS. El borde añadido es transparente.
    videoFilters.push('format=rgba');
    videoFilters.push('pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0');
    videoFilters.push('format=yuva420p');
  }
  videoFilters.push('setsar=1');
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'el-mejor-bot-sticker-'));
  const input = path.join(tempDir, 'input');
  const output = path.join(tempDir, 'sticker.webp');

  try {
    await fs.promises.writeFile(input, buffer);
    const command = ffmpeg(input)
      .videoFilters(videoFilters)
      .outputOptions([
        '-t ' + actualDuration,
        '-an',
        '-c:v libwebp_anim',
        '-lossless 0',
        '-q:v ' + actualQuality,
        '-compression_level 6',
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

function enqueueSticker(task, mediaType = 'image') {
  return new Promise((resolve, reject) => {
    const job = { task, mediaType, resolve, reject, controller: new AbortController() };

    if (mediaType === 'video') {
      if (stickerQueue.length >= MAX_STICKER_QUEUE) {
        reject(new Error('La cola de videos está llena; vuelve a intentarlo en unos minutos.'));
        return;
      }
      stickerQueue.push(job);
      drainStickerQueue();
      return;
    }

    // Las imágenes arrancan en el acto, aunque haya dos videos convirtiéndose.
    activeStickerJobs.add(job);
    console.log('🖼️ Procesando sticker de imagen sin cola. Videos activos: ' + activeStickerVideoJobs.size + '/2; videos pendientes: ' + stickerQueue.length);
    Promise.resolve()
      .then(() => job.controller.signal.aborted ? Promise.reject(new Error('Solicitud cancelada por liberarcache.')) : job.task(job.controller.signal))
      .then(job.resolve, job.reject)
      .finally(() => activeStickerJobs.delete(job));
  });
}

function drainStickerQueue() {
  while (stickerQueue.length && activeStickerVideoJobs.size < MAX_STICKER_VIDEO_CONCURRENCY) {
    const job = stickerQueue.shift();
    activeStickerJobs.add(job);
    activeStickerVideoJobs.add(job);
    console.log('🎬 Procesando sticker de video. Videos activos: ' + activeStickerVideoJobs.size + '/2; videos pendientes: ' + stickerQueue.length);
    Promise.resolve()
      .then(() => job.controller.signal.aborted ? Promise.reject(new Error('Solicitud cancelada por liberarcache.')) : job.task(job.controller.signal))
      .then(job.resolve, job.reject)
      .finally(() => {
        activeStickerJobs.delete(job);
        activeStickerVideoJobs.delete(job);
        drainStickerQueue();
      });
  }
}

async function detectarDuracionVideoSticker(buffer, duracionDeclarada) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'el-mejor-bot-probe-'));
  const input = path.join(tempDir, 'video-original.mp4');

  try {
    await fs.promises.writeFile(input, buffer);
    let diagnostic = '';
    try {
      const result = await runStickerProbe([
        '-hide_banner',
        '-nostdin',
        '-i', input,
        '-frames:v', '1',
        '-f', 'null',
        '-'
      ], {
        timeout: 12000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      });
      diagnostic = String(result?.stderr || '') + '\n' + String(result?.stdout || '');
    } catch (error) {
      // FFmpeg suele devolver código distinto de cero si solo se le pide inspeccionar;
      // su diagnóstico de entrada sigue conteniendo la duración cuando está disponible.
      diagnostic = String(error?.stderr || '') + '\n' + String(error?.stdout || '') + '\n' + String(error?.message || '');
    }

    const duration = resolveStickerDurationSeconds(diagnostic, duracionDeclarada, 3);
    console.log(
      '⏱️ Duración detectada del video: ' + duration.toFixed(2) +
      ' s' + (Number(duracionDeclarada) > 0 ? ' (WhatsApp indica ' + Number(duracionDeclarada).toFixed(2) + ' s).' : '.')
    );
    return duration;
  } catch (error) {
    const fallback = resolveStickerDurationSeconds('', duracionDeclarada, 3);
    console.warn('⚠️ No se pudo leer la duración exacta del video; se usará ' + fallback.toFixed(2) + ' s.');
    return fallback;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createFastVideoSticker(buffer, duration, signal) {
  const attempts = buildVideoStickerAttempts(duration);
  let lastError = null;

  for (let index = 0; index < attempts.length; index++) {
    if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
    const attempt = attempts[index];
    try {
      const result = await createAnimatedWebpSticker(
        buffer,
        attempt.duration,
        attempt.fps,
        attempt.quality,
        attempt.size
      );

      if (result.length <= MAX_ANIMATED_STICKER_BYTES) return result;
      lastError = new Error(
        'El WebP animado pesa ' + Math.ceil(result.length / 1024) +
        ' KB (límite interno: ' + Math.floor(MAX_ANIMATED_STICKER_BYTES / 1024) + ' KB).'
      );
      console.warn(
        '⚠️ Sticker demasiado pesado; reintentando con ' + attempt.fps +
        ' FPS y calidad ' + attempt.quality + ' (' + (index + 2) + '/' + attempts.length + ').'
      );
    } catch (error) {
      if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
      lastError = error;
      console.warn(
        '⚠️ Intento de sticker animado ' + (index + 1) + '/' + attempts.length + ': ' + error.message
      );
    }
  }

  throw new Error(
    'No se pudo generar un sticker animado fluido dentro de ' +
    Math.floor(MAX_ANIMATED_STICKER_BYTES / 1024) + ' KB tras ' + attempts.length + ' intentos. ' +
    (lastError?.message || 'Error de conversión desconocido.')
  );
}

async function createStickerWork(message, sourceMessage, mediaType, signal) {
  const jid = message.key.remoteJid;
  const sourceContent = unwrapMessage(sourceMessage);
  const sourceMetadata = mediaType === 'video'
    ? sourceContent?.videoMessage
    : sourceContent?.imageMessage;
  const declaredBytes = parseMediaSizeBytes(sourceMetadata?.fileLength);

  // Rechazar videos/fotos enormes antes de bajarlos enteros a RAM para generar
  // un sticker pequeño. Para archivos grandes se debe usar "descargar enlace".
  if (declaredBytes !== null && declaredBytes > MAX_MEDIA_BYTES) {
    throw new Error('El archivo original supera 100 MB; no cabe en memoria como sticker. Para archivos grandes usa el comando descargar con el enlace.');
  }

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
  if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('WhatsApp no entregó el archivo multimedia completo. Intenta reenviar la imagen o el video.');
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    const sizeBytes = buffer.length;
    buffer = null;
    throw new Error('El archivo descargado pesa ' + (sizeBytes / 1_000_000).toFixed(1) + ' MB y supera el límite de 100 MB para crear un sticker. Para videos grandes usa descargar con el enlace.');
  }

  if (mediaType === 'video') {
    const videoMessage = unwrapMessage(sourceMessage)?.videoMessage || {};
    const duration = await detectarDuracionVideoSticker(buffer, videoMessage.seconds);

    const stickerBuffer = await createFastVideoSticker(buffer, duration, signal);
    if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');

    // Liberar la referencia al video original antes de enviar.
    buffer = null;

    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    rememberActivity(jid, 'video');
  } else {
    // WhatsApp limita los stickers estáticos a 100 KB. Dejar margen evita
    // rechazos al volver a empaquetar/reenviar el sticker.
    const MAX_STATIC_STICKER_BYTES = 95 * 1024;
    if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
    // Quitar márgenes transparentes y normalizar todas las imágenes al mismo
    // lienzo con un margen pequeño para evitar que unas se vean diminutas.
    const normalizedImage = await sharp(buffer, { failOn: 'none' })
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 10 })
      .resize(480, 480, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .extend({
        top: 16,
        bottom: 16,
        left: 16,
        right: 16,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
    if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
    let stickerBuffer = null;
    let lastSize = 0;

    for (const quality of [80, 65, 50, 35, 20, 10, 8]) {
      if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
      const sticker = new Sticker(normalizedImage, {
        pack: 'el mejor bot',
        author: 'el mejor bot',
        // Usar el tamaño estándar de WhatsApp; FULL agrega ajuste/espacio que puede hacer que el contenido se vea más pequeño.
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
      throw new Error('La imagen no cabe en el límite de 95 KB para stickers estáticos tras 7 niveles de compresión (último intento: ' + Math.ceil(lastSize / 1024) + ' KB).');
    }

    buffer = null;
    if (signal?.aborted) throw new Error('Solicitud cancelada por liberarcache.');
    await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: message });
    rememberActivity(jid, 'image');
  }

}

async function createSticker(message, sourceMessage, mediaType) {
  const id = message.key.id;
  if (processing.has(id)) return;
  processing.add(id);

  const run = signal => createStickerWork(message, sourceMessage, mediaType, signal);

  try {
    await enqueueSticker(run, mediaType);
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
      '❌ No pude crear el sticker.\n📌 Razón: ' + reason,
      message
    ).catch(() => {});
  } finally {
    processing.delete(id);
  }
}

async function handleMessage(update) {
  const message = update?.messages?.[0];
  if (!message) return;
  if (update?.type && update.type !== 'notify') return;

  // El dueño puede escribir comandos desde el mismo WhatsApp vinculado.
  // Ignorar sus mensajes normales evita bucles, pero no debe bloquear comandos
  // explícitos como "menu" enviados desde ese número dentro de un grupo.
  const text = getText(message);
  const explicitCommand =
    /^(menu|ayuda|help|liberarcache|sticker|s|st)$/i.test(text.trim()) ||
    Boolean(analizarSolicitudDescarga(text));
  if (message.key?.fromMe && !explicitCommand) return;

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
  lastMessageChatType = String(message.key?.remoteJid || '').endsWith('@g.us') ? 'grupo' : 'privado';
  lastMessageJid = message.key?.remoteJid || null;
  console.log('📩 Mensaje recibido (' + lastMessageChatType + '):', {
    jid: lastMessageJid,
    fromMe: message.key?.fromMe === true,
    tipo: Object.keys(unwrapMessage(message) || {}).join(',') || 'sin tipo',
    comando: explicitCommand ? text.slice(0, 80) : '(mensaje no comando)'
  });

  // Registro ligero en memoria: no toca GitHub aquí.
  // Solo actualiza RAM y el guardado se agrupa en segundo plano.
  rememberActivity(message.key?.remoteJid, null);
  lastMessageProcessedAt = new Date().toISOString();

  if (/^liberarcache$/i.test(text.trim())) {
    const descargas = liberarColaDescargas();
    const stickersCancelados = stickerQueue.splice(0);
    for (const job of stickersCancelados) {
      job.controller.abort(new Error('Solicitud cancelada por liberarcache.'));
      job.reject(new Error('Solicitud cancelada por liberarcache.'));
    }
    const stickersActivosCancelados = activeStickerJobs.size;
    for (const job of activeStickerJobs) job.controller.abort(new Error('Solicitud cancelada por liberarcache.'));
    let procesosStickerCancelados = 0;
    for (const command of [...activeStickerFfmpeg]) {
      try { command.kill('SIGKILL'); procesosStickerCancelados += 1; } catch {}
    }
    for (const proceso of [...activeStickerProbeProcesses]) {
      try { proceso.kill('SIGKILL'); procesosStickerCancelados += 1; } catch {}
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
      '🎬 Trabajos de stickers pendientes cancelados (imagen/video): ' + stickersCancelados.length + '\n' +
      '⚡ Trabajos de stickers activos señalados para cancelar: ' + stickersActivosCancelados + '\n' +
      '🧯 Procesos FFmpeg de stickers detenidos: ' + procesosStickerCancelados + '\n' +
      '🛑 Cancelación de descarga activa: ' + (descargas.descargaActivaCancelada ? 'solicitada' : 'no había descarga activa') + '\n' +
      '⚙️ Procesos de descarga detenidos: ' + (descargas.procesosCancelados || 0) + '\n' +
      '⏳ Descarga activa al ejecutar comando: ' + (descargas.descargaActiva ? 'sí (' + descargas.segundosActiva + ' s)' : 'no') + '\n' +
      '📦 Descargas pendientes restantes: ' + estado.pendientes + '\n' +
      '🎨 Stickers pendientes restantes: ' + stickerQueue.length + '\n' +
      '🧠 RAM usada: ' + mb(memoria.heapUsed) + ' MB heap; ' + mb(memoria.rss) + ' MB total\n' +
      (typeof global.gc === 'function'
        ? '✅ Recolección de memoria solicitada.'
        : 'ℹ️ La recolección automática de memoria sigue activa; este proceso no permite forzarla.') + '\n\n' +
      'Se cancelan las colas y se detienen los FFmpeg activos; una descarga multimedia de WhatsApp ya iniciada puede terminar de transferirse antes de descartarse. No se borra la sesión ni la memoria persistente.',
      message
    );
  }

  if (/^(menu|ayuda|help)$/i.test(text)) {
    return sendText(
      message.key.remoteJid,
      '🤖 *el mejor bot*\n\n📸 Imagen + *sticker*\n🎥 Video + *sticker*\n⬇️ Descarga videos de TikTok, Instagram, YouTube, X, Pinterest, Facebook, Reddit, Threads u otros sitios compatibles. También acepta enlaces directos de imagen o video; usa *descargar enlace* para sitios genéricos.\n🧹 *liberarcache* para limpiar colas pendientes y revisar procesos.\n↩️ También puedes responder una imagen o video con *sticker*.',
      message
    );
  }

  const downloadRequest = analizarSolicitudDescarga(text);
  if (downloadRequest) {
    const plataforma = downloadRequest.plataforma;
    const url = extraerUrl(downloadRequest.enlace, plataforma);

    if (!url) {
      const nombres = {
        tiktok: 'TikTok', instagram: 'Instagram', x: 'X', youtube: 'YouTube',
        pinterest: 'Pinterest', facebook: 'Facebook', reddit: 'Reddit', threads: 'Threads'
      };
      const nombre = nombres[plataforma] || plataforma;
      const ayuda = plataforma === 'auto'
        ? '⚠️ Usa: descargar https://enlace-publico-de-video'
        : '⚠️ Envíame un enlace público válido de ' + nombre +
          '. Ejemplo: ' + plataforma + ' https://...';
      return sendText(message.key.remoteJid, ayuda, message);
    }

    return comandoDescargaSocial(
      sock,
      message.key.remoteJid,
      message,
      url,
      detectarPlataforma(url) || plataforma
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
    clearTimeout(sessionRestoreRetryTimer);
    sessionRestoreRetryTimer = null;
    socketGeneration += 1;
    await Promise.allSettled([...pendingCredentialWrites]);
    if (sessionUploadDone) await sessionUploadDone;
    clearTimeout(uploadTimer);
    uploadAgain = false;
    await sessionIoTail.catch(() => {});
    restoredSessionSource = null;
    restoredSessionBranch = null;
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

    if (!quarantineLocalSessionDirectory('relink')) {
      throw new Error('No pude apartar la sesión local anterior sin borrarla; se canceló el nuevo intento de vinculación.');
    }

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
  } catch (error) {
    // Si la inicialización falla después de crear el socket, no dejar una
    // referencia obsoleta en estado "conectando": bloquearía todos los reintentos.
    if (startSocketPromise === started && connectionState === 'conectando') {
      const failedSocket = sock;
      sock = null;
      authState = null;
      connectionState = 'desconectado';
      try { failedSocket?.ev?.removeAllListeners(); } catch {}
      try { failedSocket?.ws?.close(); } catch {}
    }
    throw error;
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
    if (myGeneration !== socketGeneration || sock !== newSock) return;
    // 'append' suele ser historial o mensajes añadidos posteriormente; procesar
    // solo notificaciones nuevas evita ejecutar dos veces comandos/descargas.
    if (update?.type && update.type !== 'notify') return;
    for (const message of update?.messages || []) {
      try {
        // No bloquear la recepción de mensajes mientras FFmpeg/Sticker Formatter
        // procesa un sticker. Así el bot puede seguir contestando y recibiendo
        // mensajes aunque un video tarde en convertirse.
        handleMessage({ type: update?.type, messages: [message] }).catch(error => {
          console.error('❌ Error procesando mensaje (' +
            (String(message.key?.remoteJid || '').endsWith('@g.us') ? 'grupo' : 'privado') +
            ', jid=' + (message.key?.remoteJid || 'desconocido') + '):', error);
        });
      } catch (error) {
        console.error('Error iniciando procesamiento del mensaje:', error);
      }
    }
  });

  newSock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (myGeneration !== socketGeneration || sock !== newSock) return;

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

      // Aviso de prueba: al conectar, localizar el grupo por nombre y anunciar que el bot está en línea.
      // Solo se envía una vez por proceso para evitar mensajes repetidos durante reconexiones.
      if (!onlineAnnouncementSent) {
        try {
          const participatingGroups = await newSock.groupFetchAllParticipating();
          const normalizeGroupName = value => String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toLowerCase();
          const targetGroup = Object.entries(participatingGroups || {}).find(
            ([jid, metadata]) =>
              jid.endsWith('@g.us') &&
              normalizeGroupName(metadata?.subject) === 'bot de stickers'
          );

          if (!targetGroup) {
            console.warn('⚠️ No se encontró el grupo exacto "Bot de stickers"; no se pudo enviar el aviso.');
          } else if (myGeneration === socketGeneration && sock === newSock) {
            await newSock.sendMessage(targetGroup[0], {
              text: '🟢 ¡Ya estoy en línea! El bot de stickers está conectado y listo para recibir imágenes y videos. 🤖'
            });
            onlineAnnouncementSent = true;
            console.log('✅ Aviso de conexión enviado al grupo "Bot de stickers".');
          }
        } catch (announcementError) {
          console.error('❌ No se pudo enviar el aviso al grupo "Bot de stickers":', announcementError.message);
        }
      }

      // Si el socket abrió, la sesión está autenticada. Algunas vinculaciones
      // dejan registered=false en el archivo local hasta el siguiente creds.update;
      // normalizarlo aquí y persistirlo antes de subir el snapshot cifrado.
      if (socketAuthState?.state?.creds && socketAuthState.state.creds.registered !== true) {
        const persistConnectedCredentials = sessionIoTail.then(async () => {
          if (shuttingDown || myGeneration !== socketGeneration || sock !== newSock) return;
          socketAuthState.state.creds.registered = true;
          await socketAuthState.saveCreds();
          console.log('🔐 Credenciales marcadas como registradas tras conexión autenticada.');
        });
        pendingCredentialWrites.add(persistConnectedCredentials);
        sessionIoTail = persistConnectedCredentials.catch(error => {
          console.error('❌ No se pudieron normalizar las credenciales tras conectar:', error.message);
        });
        persistConnectedCredentials.then(
          () => pendingCredentialWrites.delete(persistConnectedCredentials),
          () => pendingCredentialWrites.delete(persistConnectedCredentials)
        );
      }

      clearTimeout(uploadTimer);
      clearTimeout(sessionRestoreRetryTimer);
      sessionRestoreRetryTimer = null;
      // No competir con FFmpeg justo al conectar; El respaldo de sesión sigue
      // haciéndose automáticamente, pero unos segundos después.
      scheduleSessionUpload(10000);
      return;
    }

    if (connection === 'close') {
      const statusCode = getDisconnectCode(lastDisconnect);
      const reason = getDisconnectReason(lastDisconnect);
      const rejectedSourceAtClose = restoredSessionSource;
      const rejectedSourceBranchAtClose = restoredSessionBranch || SESSION_BRANCH;
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
      try { newSock.ev.removeAllListeners(); } catch {}

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.badSession ||
        statusCode === 401
      ) {
        sessionRecoveryFailures += 1;
        const recoveryGeneration = ++socketGeneration;
        clearTimeout(uploadTimer);
        uploadAgain = false;
        console.error('🚪 WhatsApp rechazó la sesión (LOGGED OUT / BAD SESSION). Se comprobarán las copias cifradas.');
        qrDataUrl = null;
        pairingCode = null;
        pairingNumber = null;
        pairingRequested = false;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;

        await Promise.allSettled([...pendingCredentialWrites]);
        if (sessionUploadDone) await sessionUploadDone;
        clearTimeout(uploadTimer);
        uploadAgain = false;
        await sessionIoTail.catch(() => {});
        if (shuttingDown || recoveryGeneration !== socketGeneration) return;

        const rejectedSource = rejectedSourceAtClose;
        const rejectedSourceBranch = rejectedSourceBranchAtClose;
        if (rejectedSource) {
          rejectedRemoteSessionSources.add(rejectedSourceBranch + ':' + rejectedSource);
          console.warn('🛡️ WhatsApp rechazó una copia de sesión; se conserva en GitHub y no se volverá a probar en este proceso.');
        }
        restoredSessionSource = null;
        restoredSessionBranch = null;

        if (!quarantineLocalSessionDirectory('rejected')) {
          pairingError = 'WhatsApp rechazó la sesión; la copia local se conservó porque no fue posible apartarla. No se borraron copias remotas.';
          connectionState = 'desconectado';
          return;
        }

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

        // Si WhatsApp rechazó el respaldo, se conserva; intentamos la principal
        // en modo aislado sin volver a utilizar ese mismo archivo.
        if (rejectedSource === LAST_GOOD_SESSION_FILE) {
          // WhatsApp rechazó esta copia, pero no la borramos de GitHub.
          // Primero probamos la principal y, después, la rama heredada.
          if (recoveryGeneration !== socketGeneration) return;

          const primaryRestored = await downloadEncryptedSession({
            primaryOnly: true,
            expectedGeneration: recoveryGeneration
          });
          if (recoveryGeneration !== socketGeneration) return;

          if (primaryRestored) {
            sessionRecoveryFailures = 0;
            pairingError = null;
            console.warn('🛡️ El respaldo fue rechazado; se conserva la sesión principal y se volverá a probar.');
            scheduleReconnect(statusCode);
            return;
          }

          const legacyRestored = await downloadEncryptedSession({
            legacyOnly: true,
            expectedGeneration: recoveryGeneration
          });
          if (recoveryGeneration !== socketGeneration) return;
          if (legacyRestored) {
            sessionRecoveryFailures = 0;
            pairingError = null;
            console.warn('🛡️ Sesión recuperada desde la rama heredada; se intentará reconectar.');
            scheduleReconnect(statusCode);
            return;
          }

          connectionState = 'desconectado';
          scheduleSessionRestoreRetry('legacyOnly', 1);
          return;
        }

        // Si la principal fue rechazada, no se promueve a last-good ni se borra.
        const backupRestored = await downloadEncryptedSession({
          backupOnly: true,
          expectedGeneration: recoveryGeneration
        });
        if (recoveryGeneration !== socketGeneration) return;

        if (rejectedSource === ENCRYPTED_SESSION_FILE) {
          remotePrimarySessionRejected = true;
          console.warn('🛡️ Se conserva la copia cifrada rechazada en GitHub; no se borrará automáticamente.');
        }

        if (backupRestored) {
          sessionRecoveryFailures = 0;
          pairingError = null;
          console.warn('🛡️ Sesión alternativa restaurada; se intentará reconectar.');
          scheduleReconnect(statusCode);
          return;
        }

        const legacyRestored = await downloadEncryptedSession({
          legacyOnly: true,
          expectedGeneration: recoveryGeneration
        });
        if (recoveryGeneration !== socketGeneration) return;
        if (legacyRestored) {
          sessionRecoveryFailures = 0;
          pairingError = null;
          console.warn('🛡️ Sesión recuperada desde la rama heredada; se intentará reconectar.');
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

app.get('/', async (_req, res) => {
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

    const qrContainer = document.getElementById('qrContainer');

    if (data.estado === 'conectado') {
      qrContainer.innerHTML = '<p>WhatsApp ya está conectado.</p>';
    } else if (data.qrDataUrl) {
      let qrImage = qrContainer.querySelector('#qrImage');
      if (!qrImage) {
        qrContainer.innerHTML =
          '<img id="qrImage" alt="QR para vincular WhatsApp" style="width:280px;height:280px">';
        qrImage = qrContainer.querySelector('#qrImage');
      }
      if (qrImage.getAttribute('src') !== data.qrDataUrl) {
        qrImage.setAttribute('src', data.qrDataUrl);
      }
    } else if (data.pairingCode) {
      qrContainer.innerHTML = '<p>Usa el código de vinculación que aparece abajo.</p>';
    } else if (data.pairingError) {
      const qrError = document.createElement('p');
      qrError.textContent = data.pairingError;
      qrContainer.replaceChildren(qrError);
    } else {
      qrContainer.innerHTML = '<p id="qrEmpty">Esperando el QR de WhatsApp…</p>';
    }

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

app.get('/keepalive', (_req, res) => {
  // Este endpoint solo confirma que el servidor HTTP está vivo. No debe
  // devolver 503 por una reconexión de WhatsApp lenta o fallida: eso provoca
  // que el cron de Render acumule fallos y se deshabilite automáticamente.
  res.status(200).json({
    ok: true,
    estado: connectionState,
    whatsapp: connectionState === 'conectado'
  });

  // La restauración/reconexión va en segundo plano para que el ping responda
  // rápido incluso después de que Render despierte una instancia suspendida.
  void startSocketAfterWake().catch(error => {
    console.error('❌ Keepalive no pudo iniciar/revisar WhatsApp:', error.message);
  });
});

app.get('/health', (_req, res) => {
  // Render consulta este endpoint para saber si el proceso vive. No debe
  // depender de una petición de red a GitHub en cada comprobación.
  const githubSession = !sessionSecurityReady()
    ? 'sin configurar'
    : restoredSessionSource
      ? 'restaurada desde ' + restoredSessionBranch + '/' + restoredSessionSource
      : 'configurada; no verificada en esta consulta';
  const githubReadStatus = null;

  res.status(200).json({
    ok: true,
    estado: connectionState,
    ramaSesion: SESSION_BRANCH,
    whatsapp: connectionState === 'conectado',
    uptime: Math.round(process.uptime()),
    sessionLocal: fs.existsSync(path.join(SESSION_DIR, 'creds.json')),
    credencialesRegistradasMemoria: authState?.state?.creds?.registered === true,
    credencialesRegistradasDisco: (() => {
      try {
        const diskCreds = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'creds.json'), 'utf8'));
        return diskCreds?.registered === true;
      } catch {
        return false;
      }
    })(),
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
    ultimoMensajeRecibido: lastMessageReceivedAt,
    ultimoMensajeProcesado: lastMessageProcessedAt,
    ultimoChatTipo: lastMessageChatType,
    ultimoChatJid: lastMessageJid,
    ultimaDesconexion: lastDisconnectAt,
    ultimoCodigoDesconexion: lastDisconnectCode,
    ultimoMotivoDesconexion: lastDisconnectReason,
    intentosReconectar: reconnectAttempts,
    fallosSesionRestaurada: sessionRecoveryFailures,
    stickersPendientes: stickerQueue.length,
    memoriaProcesoMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapUsadoMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

app.get('/estado-vinculacion', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    conectado: connectionState === 'conectado',
    estado: connectionState,
    pairingCode,
    pairingError,
    qrDataUrl
  });
});

app.post('/iniciar', async (req, res) => {
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
  clearTimeout(sessionRestoreRetryTimer);
  sessionRestoreRetryTimer = null;
  remotePrimarySessionRejected = false;
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
    const deletionTasks = [
      deleteEncryptedSession(),
      deleteEncryptedSessionFile(LAST_GOOD_SESSION_FILE)
    ];

    // Un cierre de sesión solicitado por el usuario también elimina la copia
    // heredada, para que el fallback no vuelva a restaurar una sesión cerrada.
    if (LEGACY_SESSION_BRANCH !== SESSION_BRANCH) {
      deletionTasks.push(deleteEncryptedSessionFile(ENCRYPTED_SESSION_FILE, LEGACY_SESSION_BRANCH));
    }

    const deletionResults = await Promise.all(deletionTasks);
    remoteSessionClean = deletionResults.every(Boolean);
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
    restoredSessionBranch = null;
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

app.post('/cerrar-sesion', async (_req, res) => {
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
  clearTimeout(sessionRestoreRetryTimer);
  sessionRestoreRetryTimer = null;

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
          if (!quarantineLocalSessionDirectory('incomplete')) {
            pairingError = 'La sesión local está incompleta, pero no se pudo apartar sin borrarla. No se borró ningún respaldo remoto.';
            connectionState = 'desconectado';
            return;
          }
          // La copia incompleta se conserva aparte y el directorio activo queda
          // limpio. Inicializar el socket ahora para generar el QR sin esperar
          // a una visita al panel o a que llegue un mensaje.
          connectionState = 'desconectado';
          pairingError = 'La sesión anterior estaba incompleta. La copia local se conservó aparte; genera un nuevo código si necesitas vincular.';
          await startSocket(false);
        }
      } else {
        console.log('No hay sesión local: inicializando WhatsApp automáticamente.');
        await startSocket(false);
      }
    } catch (error) {
      console.error('❌ Error restaurando sesión inicial:', error.message);
      scheduleReconnect(null);
    }
  })().finally(() => {
    startupReady = true;
  });
});
