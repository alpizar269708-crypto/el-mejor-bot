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
} = require('@whiskeysockets/baileys');

const { validateSessionSnapshot } = require('./sessionUtils');
const utilidades = require('./comandos/utilidades');

const crypto = require('crypto');

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

// Protege las operaciones administrativas con autenticación HTTP Basic.
// Si no hay contraseña configurada, se deniega el acceso en vez de dejar la ruta abierta.
function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, mensaje: 'Acceso administrativo no configurado.' });
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="el-mejor-bot-admin", charset="UTF-8"');
    return res.status(401).send('Autenticación administrativa requerida.');
  }

  let suppliedPassword = '';
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) throw new Error('Formato Basic inválido');
    suppliedPassword = decoded.slice(separator + 1);
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="el-mejor-bot-admin", charset="UTF-8"');
    return res.status(401).send('Credenciales inválidas.');
  }

  const expected = Buffer.from(ADMIN_PASSWORD, 'utf8');
  const supplied = Buffer.from(suppliedPassword, 'utf8');
  const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  if (!valid) {
    res.set('WWW-Authenticate', 'Basic realm="el-mejor-bot-admin", charset="UTF-8"');
    return res.status(401).send('Credenciales inválidas.');
  }

  return next();
}
const ENCRYPTED_SESSION_FILE = 'session.enc';
const LAST_GOOD_SESSION_FILE = 'session.last-good.enc';
let restoredSessionSource = null;
let restoredSessionBranch = null;
// Copias remotas rechazadas por WhatsApp se conservan, pero no se reintentan
// una y otra vez dentro del mismo proceso hasta que se guarde una sesión nueva.
const rejectedRemoteSessionSources = new Set();

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
    // Limpiar el bloqueo antes de iniciar el único socket de reconexión.
    reconnectTimer = null;
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

  // No iniciar un segundo socket mientras ya hay una reconexión programada.
  // /keepalive puede ejecutarse justo tras una caída 440; ignorar el temporizador
  // abría otro socket y podía generar conflictos de sesión en el mismo proceso.
  if (reconnectTimer) return;
  if (startSocketPromise) return;

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
  // Revalidar después de cualquier espera: una desconexión puede haber
  // programado la reconexión mientras este keepalive esperaba.
  if (reconnectTimer || connectionState === 'conectado' ||
      connectionState === 'conectando' || startSocketPromise) return;

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
let onlineAnnouncementInProgress = false;
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
let lastUpsertAt = null;
let lastUpsertType = null;
let lastUpsertMessageCount = 0;
let lastUpsertGroupCount = 0;
let lastMessageProcessingError = null;
let lastSendError = null;

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

function normalizarTextoComando(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizarComando(texto) {
  return normalizarTextoComando(texto)
    .split(/\s+/)[0]
    .replace(/^[!/.#]+/, '');
}

function distanciaEdicion(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++) {
      actual[j] = Math.min(
        actual[j - 1] + 1,
        anterior[j] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    anterior = actual;
  }
  return anterior[b.length];
}

const ALIAS_UTILIDADES = new Map([
  ['menu', 'menu'], ['ayuda', 'menu'], ['help', 'menu'],
  ['ping', 'ping'],
  ['s', 'sticker'], ['st', 'sticker'], ['sticker', 'sticker'],
  ['stiker', 'sticker'], ['stikers', 'sticker'], ['stickers', 'sticker'],
  ['recup1vez', 'recup1vez'],
  ['tiktok', 'tiktok'], ['instagram', 'instagram'],
  ['pinterest', 'pinterest'], ['x', 'x'], ['twitter', 'x'],
  ['youtube', 'youtube'], ['facebook', 'facebook'],
  ['reddit', 'reddit'], ['threads', 'threads'],
  ['descargar', 'descargar'], ['descarga', 'descargar'], ['download', 'descargar'],
  ['traduce', 'traduce']
]);

function resolverComandoUtilidad(texto) {
  const palabra = normalizarComando(texto);
  if (!palabra) return null;
  if (ALIAS_UTILIDADES.has(palabra)) return ALIAS_UTILIDADES.get(palabra);

  let mejor = null;
  let mejorDistancia = Infinity;
  let empate = false;
  for (const [alias, comando] of ALIAS_UTILIDADES) {
    if (alias.length < 4) continue;
    const limite = alias.length >= 4 ? 2 : 0;
    const distancia = distanciaEdicion(palabra, alias);
    if (distancia > limite) continue;
    if (distancia < mejorDistancia) {
      mejor = comando;
      mejorDistancia = distancia;
      empate = false;
    } else if (distancia === mejorDistancia && mejor !== comando) {
      empate = true;
    }
  }
  return empate ? null : mejor;
}

function obtenerUrlSola(texto) {
  let valor = String(texto || '').trim();
  valor = valor.replace(/^\[|\]$/g, '');
  const coincide = valor.match(/^(?:https?:\/\/)?(?:www\.)?[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/i);
  if (!coincide) return null;
  if (!/^https?:\/\//i.test(valor)) valor = 'https://' + valor;
  try {
    const url = new URL(valor);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function detectarComandoPorUrl(urlTexto) {
  if (!urlTexto) return null;
  try {
    const host = new URL(urlTexto).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)pinterest\./.test(host) || host === 'pin.it') return 'pinterest';
    if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
    if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') return 'facebook';
    if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'reddit';
    if (host === 'threads.net' || host.endsWith('.threads.net')) return 'threads';
    return 'descargar';
  } catch {
    return null;
  }
}

async function handleMessage(update) {
  const message = update?.messages?.[0];
  if (!message) return;
  if (update?.type && update.type !== 'notify' && update.type !== 'append') return;

  const texto = getText(message);
  const comando = resolverComandoUtilidad(texto);
  const urlSola = obtenerUrlSola(texto);
  const comandoDetectado = comando || (urlSola ? detectarComandoPorUrl(urlSola) : null);

  if (message.key?.fromMe && !comandoDetectado) return;

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

  const jid = message.key?.remoteJid;
  const tipoChat = String(jid || '').endsWith('@g.us') ? 'grupo' : 'privado';
  lastMessageReceivedAt = new Date().toISOString();
  lastMessageChatType = tipoChat;
  lastMessageJid = jid || null;
  lastMessageProcessedAt = new Date().toISOString();

  console.log('📩 Mensaje recibido (' + tipoChat + '):', {
    jid,
    fromMe: message.key?.fromMe === true,
    tipo: Object.keys(unwrapMessage(message) || {}).join(',') || 'sin tipo',
    comando: comandoDetectado || '(mensaje no comando)'
  });

  if (!comandoDetectado) return;
  if (!sock || connectionState !== 'conectado') {
    console.warn('⚠️ Se reconoció un comando, pero WhatsApp no está conectado.');
    return;
  }

  const contenido = unwrapMessage(message) || message.message || {};
  const mensajeUtilidad = { ...message, message: contenido };
  const partes = texto.trim().split(/\s+/);
  const argumentos = urlSola ? [urlSola] : partes;
  const argumentosSinComando = urlSola ? [urlSola] : partes.slice(1);
  const enviarTexto = async textoRespuesta =>
    sock.sendMessage(jid, { text: textoRespuesta }, { quoted: mensajeUtilidad });

  try {
    switch (comandoDetectado) {
      case 'menu':
        return await enviarTexto(
          '🧰 *UTILIDADES DEL BOT*\n\n' +
          '🎨 *sticker* o *S*: crea un sticker de una imagen o video adjunto/citado.\n' +
          '♻️ *recup1vez*: recupera una foto de ver una vez al responder a ella.\n' +
          '🎵 *tiktok enlace*\n' +
          '📸 *instagram enlace*\n' +
          '📌 *pinterest enlace*\n' +
          '🐦 *x enlace*\n' +
          '⬇️ *descargar enlace*: descarga desde otros sitios compatibles.\n' +
          '🌐 *traduce idioma texto*\n' +
          '💓 *ping*\n\n' +
          'Los comandos aceptan mayúsculas y minúsculas.'
        );
      case 'ping':
        return await enviarTexto('🏓 Pong. El bot está conectado y respondiendo.');
      case 'sticker':
        return await utilidades.comandoSticker(sock, mensajeUtilidad);
      case 'recup1vez':
        return await utilidades.comandoRecup1Vez(sock, jid, mensajeUtilidad);
      case 'tiktok':
        return await utilidades.comandoTiktok(sock, jid, mensajeUtilidad, argumentos);
      case 'instagram':
        return await utilidades.comandoInstagram(sock, jid, mensajeUtilidad, argumentos);
      case 'pinterest':
        return await utilidades.comandoPinterest(sock, jid, mensajeUtilidad, argumentos);
      case 'x':
        return await utilidades.comandoX(sock, jid, mensajeUtilidad, argumentos);
      case 'youtube':
      case 'facebook':
      case 'reddit':
      case 'threads':
      case 'descargar':
        return await utilidades.comandoDescargaSocial(
          sock, jid, mensajeUtilidad, argumentosSinComando.length ? argumentosSinComando : argumentos,
          comandoDetectado === 'descargar' ? 'sitio web' : comandoDetectado
        );
      case 'traduce':
        return await utilidades.comandoTraduce(sock, jid, mensajeUtilidad, argumentosSinComando);
      default:
        return;
    }
  } catch (error) {
    lastMessageProcessingError = {
      at: new Date().toISOString(),
      chatType: tipoChat,
      message: String(error?.message || error).slice(0, 300)
    };
    console.error('❌ Error procesando utilidad (' + tipoChat + '):', lastMessageProcessingError.message);
    try {
      await enviarTexto('❌ Ocurrió un error al ejecutar esa utilidad. Revisa los registros del bot.');
    } catch (sendError) {
      lastSendError = {
        at: new Date().toISOString(),
        chatType: tipoChat,
        message: String(sendError?.message || sendError).slice(0, 300)
      };
      console.error('❌ Error enviando respuesta de error:', lastSendError.message);
    }
  }
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

async function anunciarConexionEnGrupoStickers(socket, generation) {
  if (onlineAnnouncementSent || onlineAnnouncementInProgress || shuttingDown) return;
  onlineAnnouncementInProgress = true;

  const normalizarNombreGrupo = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  try {
    // Esperar a que la sesión se estabilice. Antes se enviaba casi inmediatamente
    // al abrir, justo antes de la desconexión 440 que aparece en los registros.
    await new Promise(resolve => setTimeout(resolve, 8000));
    if (shuttingDown || generation !== socketGeneration || sock !== socket ||
        connectionState !== 'conectado' || reconnectTimer) {
      console.warn('⏭️ Se omite el aviso: la conexión no permaneció estable durante 8 segundos.');
      return;
    }

    let objetivo = null;
    try {
      const grupos = await socket.groupFetchAllParticipating();
      const entradas = Object.entries(grupos || {}).filter(([jid]) => jid.endsWith('@g.us'));
      objetivo = entradas.find(([, metadata]) =>
        normalizarNombreGrupo(metadata?.subject) === 'bot de stickers'
      );
      if (!objetivo) {
        console.error('❌ No aparece el grupo "Bot de stickers". Grupos visibles: ' +
          (entradas.map(([, metadata]) => String(metadata?.subject || '(sin nombre)')).slice(0, 30).join(' | ') || '(ninguno)'));
        return;
      }
    } catch (error) {
      console.error('❌ No se pudo consultar la lista de grupos para el aviso:', error?.message || error);
      return;
    }

    if (shuttingDown || generation !== socketGeneration || sock !== socket ||
        connectionState !== 'conectado' || reconnectTimer) return;

    let sentMessageId = null;
    let resolveAck;
    const ackPromise = new Promise(resolve => { resolveAck = resolve; });
    const onMessageUpdate = updates => {
      for (const item of updates || []) {
        if (item?.key?.remoteJid === objetivo[0] &&
            item?.key?.id === sentMessageId &&
            Number(item?.update?.status) >= 2) {
          resolveAck({ status: Number(item.update.status), participant: item.update.participant || null });
        }
      }
    };

    // Registrar el listener antes del envío para no perder un acuse rápido.
    socket.ev.on('messages.update', onMessageUpdate);
    try {
      const sent = await socket.sendMessage(objetivo[0], {
        text: '🟢 ¡Ya estoy en línea! El bot de stickers está conectado y listo para recibir imágenes y videos. 🤖'
      });
      sentMessageId = sent?.key?.id || null;
      if (!sentMessageId) {
        console.error('⚠️ WhatsApp no devolvió ID para el aviso; no se puede confirmar el resultado.');
        return;
      }

      // sendMessage resolvió correctamente: WhatsApp aceptó el envío. La recepción
      // de un evento messages.update no es requisito para considerar estable el socket
      // y no debe provocar reenvíos que dupliquen el aviso.
      onlineAnnouncementSent = true;
      console.log('📤 WhatsApp aceptó el aviso para "Bot de stickers". ID: ' + sentMessageId);

      const ack = await Promise.race([
        ackPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 15000))
      ]);

      if (ack) {
        console.log('✅ Acuse de entrega recibido para "Bot de stickers". Estado: ' +
          ack.status + (ack.participant ? ', participante: ' + ack.participant : '') +
          ', ID: ' + sentMessageId);
      } else {
        console.warn('ℹ️ WhatsApp aceptó el aviso (ID: ' + sentMessageId +
          '), pero no emitió un acuse de entrega detectable en 15 segundos. Se conserva el estado de aviso enviado para evitar duplicados.');
      }
    } catch (error) {
      console.error('❌ Falló el envío del aviso a "Bot de stickers":', error?.message || error);
    } finally {
      socket.ev.off('messages.update', onMessageUpdate);
    }
  } finally {
    onlineAnnouncementInProgress = false;
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

    // Registrar el evento antes de filtrar historial para saber si WhatsApp
    // está entregando mensajes de grupo a este proceso.
    const upsertMessages = Array.isArray(update?.messages) ? update.messages : [];
    const groupMessages = upsertMessages.filter(message =>
      String(message?.key?.remoteJid || '').endsWith('@g.us')
    ).length;
    lastUpsertAt = new Date().toISOString();
    lastUpsertType = update?.type || null;
    lastUpsertMessageCount = upsertMessages.length;
    lastUpsertGroupCount = groupMessages;
    if (groupMessages > 0) {
      console.log('📨 Evento messages.upsert con mensajes de grupo:', {
        type: lastUpsertType,
        count: upsertMessages.length,
        groups: groupMessages
      });
    }

    // Aceptar notify y append: en esta conexión también llegan mensajes válidos
    // como append. Para no ejecutar comandos viejos del historial al reconectar,
    // en append solo se procesan mensajes con marca de tiempo de los últimos 2 minutos.
    if (update?.type && update.type !== 'notify' && update.type !== 'append') return;
    for (const message of update?.messages || []) {
      if (update?.type === 'append') {
        const timestamp = Number(message?.messageTimestamp);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(timestamp) || timestamp <= 0 || Math.abs(nowSeconds - timestamp) > 120) {
          continue;
        }
      }
      try {
        // No bloquear la recepción de mensajes mientras FFmpeg/Sticker Formatter
        // procesa un sticker. Así el bot puede seguir contestando y recibiendo
        // mensajes aunque un video tarde en convertirse.
        handleMessage({ type: update?.type, messages: [message] }).catch(error => {
          lastMessageProcessingError = {
            at: new Date().toISOString(),
            chatType: String(message.key?.remoteJid || '').endsWith('@g.us') ? 'grupo' : 'privado',
            message: String(error?.message || error).slice(0, 300)
          };
          console.error('❌ Error procesando mensaje (' +
            lastMessageProcessingError.chatType + '):', lastMessageProcessingError.message);
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

      // Reintentar la búsqueda/envío porque la lista de grupos puede tardar en estar disponible
      // justo después de que Baileys marque la conexión como abierta.
      void anunciarConexionEnGrupoStickers(newSock, myGeneration);

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
    if (startupReady && !reconnectTimer && !startSocketPromise &&
        !authState?.state?.creds?.registered && connectionState === 'desconectado') {
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
    ultimaSubidaSesion: lastSessionUploadAt,
    ultimaSubidaExitosa: lastSessionUploadOk,
    ultimoErrorSubidaSesion: lastSessionUploadError,
    fallosConsecutivosSubida: sessionUploadFailures,
    ultimaConexion: lastConnectedAt,
    ultimoMensajeRecibido: lastMessageReceivedAt,
    ultimoMensajeProcesado: lastMessageProcessedAt,
    ultimoChatTipo: lastMessageChatType,
    ultimoEventoUpsert: lastUpsertAt,
    ultimoTipoUpsert: lastUpsertType,
    mensajesUltimoUpsert: lastUpsertMessageCount,
    gruposUltimoUpsert: lastUpsertGroupCount,
    ultimoErrorProcesamientoMensaje: lastMessageProcessingError,
    ultimoErrorEnvioRespuesta: lastSendError,
    ultimaDesconexion: lastDisconnectAt,
    ultimoCodigoDesconexion: lastDisconnectCode,
    ultimoMotivoDesconexion: lastDisconnectReason,
    intentosReconectar: reconnectAttempts,
    fallosSesionRestaurada: sessionRecoveryFailures,
    stickersPendientes: 0,
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
