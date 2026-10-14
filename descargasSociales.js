'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const youtubeDlExec = require('youtube-dl-exec');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const youtubedl = youtubeDlExec;
const GALLERY_DL_PATH = process.env.GALLERY_DL_PATH?.trim() || path.join(__dirname, '.venv-gallery-dl', 'bin', 'gallery-dl');
const GALLERY_DL_TIMEOUT_MS = 120000;
// WhatsApp documenta un límite de vídeo de 100 MB; usar MB decimales evita
// que un archivo de 100 MiB rebase el límite real del cliente.
const MAX_MEDIA_BYTES = 100_000_000;
// Entregar medios grandes como documentos evita límites variables de envío
// multimedia según el cliente/conexión y conserva el archivo original.
const MAX_INLINE_IMAGE_BYTES = 16_000_000;
const MAX_INLINE_VIDEO_BYTES = 64_000_000;
const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COLA_DESCARGAS = 100;
const MAX_MEDIA_FILES = 10;
const colaDescargas = [];
let descargaActiva = false;
let trabajoActivoDesde = null;

const IMAGE_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp'
};
const VIDEO_MIME_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/3gpp': '.3gp',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/x-flv': '.flv',
  'video/mp2t': '.ts'
};
const DIRECT_MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp',
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.3gp',
  '.mpeg', '.mpg', '.flv', '.ts'
]);
const YTDLP_MEDIA_EXTENSIONS = /\.(?:mp4|m4v|mov|webm|mkv|avi|3gp|mpeg|mpg|flv|ts|jpe?g|png|webp|avif|gif|bmp)$/i;

function encolarDescarga(trabajo) {
  if (colaDescargas.length >= MAX_COLA_DESCARGAS) {
    throw new Error('La cola está llena por ahora. Intenta de nuevo en unos minutos.');
  }
  return new Promise((resolve, reject) => {
    colaDescargas.push({ trabajo, resolve, reject });
    procesarColaDescargas().catch(error => console.error('Cola de descargas:', error.message));
  });
}

async function procesarColaDescargas() {
  if (descargaActiva) return;
  descargaActiva = true;
  try {
    while (colaDescargas.length) {
      const job = colaDescargas.shift();
      trabajoActivoDesde = Date.now();
      try {
        job.resolve(await job.trabajo());
      } catch (error) {
        job.reject(error);
      } finally {
        trabajoActivoDesde = null;
      }
    }
  } finally {
    descargaActiva = false;
    if (colaDescargas.length) procesarColaDescargas().catch(() => {});
  }
}

function liberarColaDescargas() {
  const pendientes = colaDescargas.splice(0);
  for (const job of pendientes) {
    job.reject(new Error('Solicitud cancelada por liberarcache.'));
  }
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch {}
  }
  return {
    pendientesCancelados: pendientes.length,
    descargaActiva,
    segundosActiva: trabajoActivoDesde
      ? Math.floor((Date.now() - trabajoActivoDesde) / 1000)
      : 0,
    recoleccionForzadaDisponible: typeof global.gc === 'function'
  };
}

function esIpPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') ||
      normalized.startsWith('::ffff:');
  }
  return false;
}

function normalizarUrl(valor) {
  let candidate = String(valor || '').trim().replace(/[),.;!?]+$/g, '');
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!host || url.username || url.password) return null;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host.endsWith('.onion') ||
      net.isIP(host) && esIpPrivada(host)
    ) return null;

    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function extraerCoincidencias(texto) {
  return String(texto || '').match(
    /https?:\/\/[^\s<>]+|(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>]*)?/gi
  ) || [];
}

function detectarPlataforma(urlInput) {
  const url = urlInput instanceof URL ? urlInput : normalizarUrl(urlInput);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (['x.com', 'twitter.com', 't.co'].includes(host) || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
  if (host === 'pinterest.com' || host.endsWith('.pinterest.com') || /^pinterest\.[a-z]{2,3}(?:\.[a-z]{2})?$/.test(host) || host === 'pin.it') return 'pinterest';
  if (['facebook.com', 'fb.watch', 'fb.com'].includes(host) || host.endsWith('.facebook.com')) return 'facebook';
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'reddit';
  if (host === 'threads.net' || host.endsWith('.threads.net')) return 'threads';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return 'youtube';
  return null;
}

function extraerUrl(texto, plataforma = 'auto') {
  if (/(?:^|\s)(?:ftp|file|data|javascript):\/\//i.test(String(texto || ''))) return null;
  const coincidencias = extraerCoincidencias(texto);
  for (const coincidencia of coincidencias) {
    const url = normalizarUrl(coincidencia);
    if (!url) continue;

    if (plataforma === 'auto') return url.toString();
    const detectada = detectarPlataforma(url);
    if (detectada === plataforma || (plataforma === 'x' && detectada === 'x')) {
      return url.toString();
    }
  }
  return null;
}


function analizarSolicitudDescarga(texto) {
  const trimmed = String(texto || '').trim();
  if (!trimmed) return null;

  const generic = trimmed.match(/^(?:descargar|descarga|download)(?:\s+([\s\S]+))?$/i);
  if (generic) {
    return {
      tipo: 'generic',
      plataforma: 'auto',
      enlace: String(generic[1] || '').trim()
    };
  }

  // Tratar la palabra como comando solo si después hay espacio o fin de texto.
  // Así "instagram.com/reel/..." y "youtube.com/watch?..." siguen siendo URLs.
  const command = trimmed.match(/^(tiktok|instagram|x|twitter|youtube|pinterest|facebook|reddit|threads)(?=\s|$)/i);
  if (command) {
    const rawPlatform = command[1].toLowerCase();
    return {
      tipo: 'platform',
      plataforma: rawPlatform === 'twitter' ? 'x' : rawPlatform,
      enlace: trimmed.slice(command[0].length).trim()
    };
  }

  // Un mensaje de una palabra ("hola", "gracias", etc.) no es una URL.
  // Exigir al menos un punto en el host evita que el detector active descargas
  // por texto normal, sin afectar dominios o enlaces de plataformas conocidos.
  const isBareUrl = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(trimmed);
  if (isBareUrl) {
    return { tipo: 'url', plataforma: 'auto', enlace: trimmed };
  }

  // Si el usuario acompaña el enlace con texto, descargar el primer URL válido
  // en vez de ignorar el mensaje completo.
  const embeddedUrl = extraerUrl(trimmed, 'auto');
  if (embeddedUrl) {
    return { tipo: 'url', plataforma: 'auto', enlace: embeddedUrl };
  }

  return null;
}

function limpiarDirectorio(ruta) {
  return fs.promises.rm(ruta, { recursive: true, force: true });
}

function extensionDesdeContentDisposition(header) {
  const text = String(header || '');
  const utf8Match = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const plainMatch = text.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  let filename = utf8Match?.[1] || plainMatch?.[1] || plainMatch?.[2] || '';
  filename = filename.trim();
  try { filename = decodeURIComponent(filename); } catch {}
  const extension = path.extname(
    filename.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() || ''
  ).toLowerCase();
  return DIRECT_MEDIA_EXTENSIONS.has(extension) ? extension : '';
}

function esImagenExtension(extension) {
  return /\.(?:jpe?g|png|webp|avif|gif|bmp)$/i.test(extension);
}

function tipoMimetype(extension, mime = '') {
  const normalizedExtension = String(extension || '').toLowerCase();
  const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase();

  if (
    esImagenExtension(normalizedExtension) ||
    Object.prototype.hasOwnProperty.call(IMAGE_MIME_EXT, normalizedMime)
  ) return 'image';

  // Estos formatos están admitidos como vídeos por WhatsApp. El transporte
  // MPEG-TS se conserva como documento porque no figura entre sus formatos de vídeo.
  const videoExtensions = new Set([
    '.mp4', '.m4v', '.mov', '.webm', '.3gp', '.mkv', '.avi', '.mpeg', '.mpg', '.flv'
  ]);
  const videoMimeTypes = new Set([
    'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
    'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'video/x-flv'
  ]);

  if (videoExtensions.has(normalizedExtension) || videoMimeTypes.has(normalizedMime)) {
    return 'video';
  }
  return 'document';
}

function mimetypeDesdeExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.3gp': 'video/3gpp', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
    '.flv': 'video/x-flv', '.ts': 'video/mp2t'
  };
  return map[ext] || 'application/octet-stream';
}

function createMediaSizeLimiter(maxBytes = MAX_MEDIA_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('El límite de descarga debe ser un entero positivo.');
  }

  const limitLabel = maxBytes === MAX_MEDIA_BYTES ? '100 MB' : maxBytes + ' bytes';
  let receivedBytes = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        callback(new Error('El archivo superó el límite de descarga de ' + limitLabel + '.'));
        return;
      }
      callback(null, chunk);
    }
  });
}

async function descargaDirecta(urlInicial, tempDir, index = 1, extraHeaders = {}) {
  let url = normalizarUrl(urlInicial);
  if (!url) throw new Error('El enlace debe ser una URL HTTP/HTTPS pública válida.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response = null;
  let destino = null;

  try {
    for (let redirect = 0; redirect <= 5; redirect++) {
      const current = normalizarUrl(url.toString());
      if (!current) throw new Error('El servidor intentó redirigir a una dirección no permitida.');
      await validarHostPublico(current);

      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          Accept: 'video/*,image/*,application/octet-stream;q=0.9,*/*;q=0.5',
          ...extraHeaders
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 5) throw new Error('Demasiadas redirecciones al descargar el archivo.');
        url = new URL(location, current);
        try { await response.body?.cancel(); } catch {}
        continue;
      }
      break;
    }

    if (!response?.ok) {
      throw new Error('El servidor del enlace respondió HTTP ' + (response?.status ?? 'sin respuesta') + '.');
    }

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const contentLength = Number(response.headers.get('content-length') || 0);
    const extensionUrl = path.extname(url.pathname).toLowerCase();
    const allowedByExtension = DIRECT_MEDIA_EXTENSIONS.has(extensionUrl);
    const extensionByMime = IMAGE_MIME_EXT[contentType] || VIDEO_MIME_EXT[contentType];
    const extensionByDisposition = extensionDesdeContentDisposition(response.headers.get('content-disposition'));
    const responseIsMedia = contentType.startsWith('image/') || contentType.startsWith('video/');
    const responseIsBinary = ['', 'application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(contentType);
    if (!responseIsMedia && !(allowedByExtension && responseIsBinary) && !(extensionByDisposition && responseIsBinary)) {
      throw new Error('El enlace directo no respondió una imagen o video reconocible (tipo ' + (contentType || 'desconocido') + ').');
    }
    if (contentLength > MAX_MEDIA_BYTES) {
      throw new Error('El archivo supera el límite de descarga de 100 MB.');
    }
    if (!response.body) throw new Error('El servidor no entregó contenido descargable.');

    const extension = allowedByExtension ? extensionUrl : (extensionByMime || extensionByDisposition);
    if (!extension) throw new Error('El servidor no indicó un formato de imagen o video compatible.');

    destino = path.join(tempDir, String(index).padStart(3, '0') + '-direct' + extension);
    let receivedBytes = 0;
    const sizeLimiter = createMediaSizeLimiter(MAX_MEDIA_BYTES);
    sizeLimiter.on('data', chunk => { receivedBytes += chunk.length; });

    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimiter,
      fs.createWriteStream(destino, { flags: 'wx' }),
      { signal: controller.signal }
    );

    if (receivedBytes === 0) throw new Error('El servidor devolvió un archivo vacío.');
    const stat = await fs.promises.stat(destino);
    if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw new Error('El archivo vacío o supera los 100 MB.');

    const responseMime = /^(?:image|video)\//.test(contentType) ? contentType : null;
    const mime = responseMime || mimetypeDesdeExtension(extension);
    return {
      path: destino,
      nombre: path.basename(destino),
      tipo: tipoMimetype(extension, mime),
      mimetype: mime,
      size: stat.size
    };
  } catch (error) {
    if (destino) await fs.promises.rm(destino, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw new Error('La descarga directa superó el límite de 30 minutos.');
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      if (response?.body && !response.bodyUsed) await response.body.cancel();
    } catch {}
  }
}

async function validarHostPublico(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (esIpPrivada(host)) throw new Error('No se permiten direcciones IP privadas en enlaces de descarga.');
    return;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(record => esIpPrivada(record.address))) {
    throw new Error('El dominio del enlace no resuelve exclusivamente a direcciones públicas.');
  }
}

async function listarArchivosMedia(tempDir) {
  const nombres = (await fs.promises.readdir(tempDir))
    .filter(nombre => YTDLP_MEDIA_EXTENSIONS.test(nombre))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const archivos = [];
  for (const nombre of nombres.slice(0, MAX_MEDIA_FILES)) {
    const ruta = path.join(tempDir, nombre);
    const stat = await fs.promises.stat(ruta);
    if (!stat.isFile() || !stat.size) continue;

    const extension = path.extname(nombre).toLowerCase();
    const isImage = esImagenExtension(extension);
    const mime = isImage
      ? (extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/' + extension.slice(1))
      : (extension === '.webm' ? 'video/webm' :
        extension === '.mov' ? 'video/quicktime' :
        extension === '.3gp' ? 'video/3gpp' :
        extension === '.mkv' ? 'video/x-matroska' :
        extension === '.avi' ? 'video/x-msvideo' :
        extension === '.mpeg' || extension === '.mpg' ? 'video/mpeg' :
        extension === '.flv' ? 'video/x-flv' : 'video/mp4');

    archivos.push({
      path: ruta,
      nombre,
      tipo: tipoMimetype(extension, mime),
      mimetype: mime,
      size: stat.size
    });
  }
  return archivos;
}

function esErrorSinVideoInstagram(error) {
  const detalle = String(error?.stderr || error?.message || error || '').toLowerCase();
  return /there is no video in this post|no video formats found|no video formats/.test(detalle);
}

function crearCaptionDescarga(archivo, mediaKey, indice, total) {
  if (total > 1) return '✅ Archivo ' + (indice + 1) + ' de ' + total + ' descargado.';
  if (archivo?.tipo === 'image') {
    return mediaKey === 'document'
      ? '✅ Imagen descargada; se envía como documento para conservar el archivo original.'
      : '✅ Imagen descargada.';
  }
  if (archivo?.tipo === 'video') {
    return mediaKey === 'document'
      ? '✅ Video descargado; se envía como documento para evitar límites de multimedia.'
      : '✅ Video listo para enviar.';
  }
  return '✅ Archivo descargado.';
}

const INSTAGRAM_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp']);

function decodificarValorJsonHtml(value) {
  let result = String(value || '');
  try {
    result = JSON.parse('"' + result.replace(/"/g, '\\"') + '"');
  } catch {
    result = result.replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=');
  }
  return result
    .replace(/&amp;/gi, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&#38;/g, '&')
    .trim();
}

function extraerUrlsImagenInstagram(html) {
  const source = String(html || '');
  const candidates = [];
  const seen = new Set();

  function add(rawValue) {
    const decoded = decodificarValorJsonHtml(rawValue);
    const url = normalizarUrl(decoded);
    if (!url) return;

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const trustedImageHost =
      host === 'instagram.com' || host.endsWith('.instagram.com') ||
      host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') ||
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net');
    if (!trustedImageHost) return;

    const extension = path.extname(url.pathname).toLowerCase();
    if (!INSTAGRAM_IMAGE_EXTENSIONS.has(extension)) return;

    const normalized = url.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  }

  // Priorizar las URLs de imagen completas presentes en el JSON del post,
  // incluidas las entradas individuales de un carrusel.
  const imageValuePattern = /"(?:display_url|display_src|thumbnail_src|image_url|imageUrl)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  for (const match of source.matchAll(imageValuePattern)) add(match[1]);

  // Las imágenes de Instagram también aparecen como image_versions2.candidates[].url.
  // Se limita la búsqueda a dominios oficiales y extensiones de imagen antes de aceptar.
  const candidateUrlPattern = /"url"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  for (const match of source.matchAll(candidateUrlPattern)) add(match[1]);

  // Como último recurso, utilizar las imágenes Open Graph de publicaciones públicas.
  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = tag.match(/\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const name = String(property?.[1] || property?.[2] || property?.[3] || '').toLowerCase();
    if (name !== 'og:image' && name !== 'twitter:image') continue;
    const content = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    add(content?.[1] || content?.[2] || content?.[3] || '');
  }

  return candidates.slice(0, MAX_MEDIA_FILES);
}

function extraerUrlsImagenGalleryDl(output) {
  const candidates = [];
  const seen = new Set();

  for (const line of String(output || '').split(/\r?\n/)) {
    const raw = line.trim().replace(/^["']|["']$/g, '');
    if (!/^https?:\/\//i.test(raw)) continue;
    const url = normalizarUrl(raw);
    if (!url) continue;

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const trustedImageHost =
      host === 'instagram.com' || host.endsWith('.instagram.com') ||
      host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') ||
      host === 'fbcdn.net' || host.endsWith('.fbcdn.net');
    const extension = path.extname(url.pathname).toLowerCase();
    if (!trustedImageHost || !INSTAGRAM_IMAGE_EXTENSIONS.has(extension)) continue;

    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
    if (candidates.length >= MAX_MEDIA_FILES) break;
  }

  return candidates;
}

async function descargarImagenesInstagramConGalleryDl(urlInicial, tempDir) {
  if (!fs.existsSync(GALLERY_DL_PATH)) {
    console.warn('⚠️ gallery-dl no está instalado; se probará el acceso público directo a Instagram.');
    return [];
  }

  let cookiesPath = null;
  const encodedCookies = process.env.INSTAGRAM_COOKIES_B64?.trim();
  if (encodedCookies) {
    const cookies = Buffer.from(encodedCookies, 'base64');
    const normalized = encodedCookies.replace(/=+$/, '');
    if (
      !cookies.length ||
      cookies.toString('base64').replace(/=+$/, '') !== normalized ||
      !cookies.toString('utf8').includes('\t')
    ) {
      throw new Error('INSTAGRAM_COOKIES_B64 no parece ser un archivo cookies.txt válido en Base64.');
    }
    cookiesPath = path.join(tempDir, '.instagram-cookies.txt');
    await fs.promises.writeFile(cookiesPath, cookies, { mode: 0o600, flag: 'wx' });
  }

  const argsBase = [
    '--no-input',
    '--range', '1-' + MAX_MEDIA_FILES,
    '--filesize-max', '100M',
    '--http-timeout', '25',
    '--retries', '2'
  ];
  if (cookiesPath) argsBase.push('--cookies', cookiesPath);

  try {
    // Pedir primero las URLs originales a gallery-dl y bajarlas con nuestro
    // cliente streaming. Así no dependemos de cómo versiona/nombra sus archivos.
    let galleryOutput = '';
    try {
      const result = await execFileAsync(
        GALLERY_DL_PATH,
        [...argsBase, '--get-urls', urlInicial],
        { timeout: GALLERY_DL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
      );
      galleryOutput = result?.stdout || '';
    } catch (error) {
      galleryOutput = error?.stdout || '';
      const detail = String(error?.stderr || error?.message || error || '')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
      console.warn('⚠️ gallery-dl no pudo resolver las imágenes de Instagram:', detail);
    }

    const imageUrls = extraerUrlsImagenGalleryDl(galleryOutput);
    const files = [];
    for (const imageUrl of imageUrls) {
      try {
        const file = await descargaDirecta(
          imageUrl,
          tempDir,
          files.length + 1,
          { Referer: 'https://www.instagram.com/' }
        );
        if (file.tipo === 'image') files.push(file);
        else await fs.promises.rm(file.path, { force: true }).catch(() => {});
      } catch (error) {
        console.warn('⚠️ No se pudo descargar una imagen de Instagram:', String(error?.message || error).slice(0, 180));
      }
      if (files.length >= MAX_MEDIA_FILES) break;
    }
    if (files.length) return files;

    // Segunda alternativa: dejar que gallery-dl gestione la descarga.
    // Se mantiene aunque la fase de resolución directa no haya devuelto URLs.
    try {
      await execFileAsync(
        GALLERY_DL_PATH,
        [...argsBase, '--directory', tempDir, urlInicial],
        { timeout: GALLERY_DL_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true }
      );
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error || '')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
      console.warn('⚠️ gallery-dl no pudo descargar la galería de Instagram:', detail);
    }

    const downloaded = await listarArchivosMedia(tempDir);
    const images = downloaded.filter(file => file.tipo === 'image').slice(0, MAX_MEDIA_FILES);
    const nonImages = downloaded.filter(file => file.tipo !== 'image');
    for (const file of nonImages) {
      await fs.promises.rm(file.path, { force: true }).catch(() => {});
    }
    return images;
  } finally {
    if (cookiesPath) await fs.promises.rm(cookiesPath, { force: true }).catch(() => {});
  }
}

async function descargarImagenesInstagram(urlInicial, tempDir) {
  let pageUrl = normalizarUrl(urlInicial);
  if (!pageUrl || detectarPlataforma(pageUrl) !== 'instagram') {
    throw new Error('El fallback de imágenes solo acepta enlaces de Instagram.');
  }

  // gallery-dl está orientado a galerías e imágenes (incluidos carruseles).
  // Probarlo primero evita depender del HTML anónimo, que Instagram cambia o bloquea.
  try {
    const galleryFiles = await descargarImagenesInstagramConGalleryDl(pageUrl.toString(), tempDir);
    if (galleryFiles.length) return galleryFiles;
  } catch (error) {
    console.warn('⚠️ No se pudo usar gallery-dl para Instagram:', String(error?.message || error).slice(0, 250));
  }

  // Limpiar cualquier descarga parcial del extractor antes del fallback HTTP.
  await limpiarDirectorio(tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  let response = null;

  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const current = normalizarUrl(pageUrl.toString());
      if (!current) throw new Error('Instagram redirigió a una URL no permitida.');
      await validarHostPublico(current);

      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('Instagram redirigió demasiadas veces.');
        pageUrl = new URL(location, current);
        try { await response.body?.cancel(); } catch {}
        response = null;
        continue;
      }
      break;
    }

    if (!response?.ok) {
      throw new Error('Instagram respondió HTTP ' + (response?.status ?? 'sin respuesta') + ' al consultar la publicación.');
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('Instagram no devolvió la página pública de la publicación.');
    }

    const html = (await response.text()).slice(0, 8_000_000);
    const candidates = extraerUrlsImagenInstagram(html);
    if (!candidates.length) {
      throw new Error('Instagram no expuso URLs públicas de imágenes en la página de la publicación.');
    }

    const files = [];
    const errors = [];
    for (const candidate of candidates) {
      try {
        const file = await descargaDirecta(
          candidate,
          tempDir,
          files.length + 1,
          { Referer: 'https://www.instagram.com/' }
        );
        if (file.tipo !== 'image') {
          await fs.promises.rm(file.path, { force: true }).catch(() => {});
          continue;
        }
        files.push(file);
        if (files.length >= MAX_MEDIA_FILES) break;
      } catch (error) {
        errors.push(error?.message || String(error));
      }
    }

    if (!files.length) {
      throw new Error(
        'Instagram mostró enlaces de imagen, pero no fue posible descargarlos' +
        (errors.length ? ': ' + errors[0].slice(0, 180) : '.')
      );
    }
    return files;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('La consulta de imágenes de Instagram superó los 25 segundos.');
    throw error;
  } finally {
    clearTimeout(timeout);
    try {
      if (response?.body && !response.bodyUsed) await response.body.cancel();
    } catch {}
  }
}

async function descargarArchivos(url, plataforma = 'auto') {
  const plataformaEfectiva = plataforma === 'auto' ? (detectarPlataforma(url) || 'auto') : plataforma;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-download-'));
  const output = path.join(tempDir, '%(autonumber)03d.%(ext)s');
  let completed = false;

  const opcionesBase = {
    output,
    noWarnings: true,
    ...(!['instagram', 'pinterest', 'tiktok'].includes(plataformaEfectiva) ? { noPlaylist: true } : {}),
    playlistEnd: MAX_MEDIA_FILES,
    maxDownloads: MAX_MEDIA_FILES,
    socketTimeout: 60,
    retries: 5,
    fragmentRetries: 5,
    extractorRetries: 3,
    noPart: true,
    restrictFilenames: true,
    maxFilesize: '100M',
    ffmpegLocation: ffmpegInstaller.path,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: ({
      instagram: 'https://www.instagram.com/',
      x: 'https://x.com/',
      twitter: 'https://x.com/',
      youtube: 'https://www.youtube.com/',
      pinterest: 'https://www.pinterest.com/',
      facebook: 'https://www.facebook.com/',
      reddit: 'https://www.reddit.com/',
      threads: 'https://www.threads.net/'
    })[plataformaEfectiva] || undefined
  };
  const opcionesVideo = {
    ...opcionesBase,
    format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
    mergeOutputFormat: 'mp4'
  };

  try {
    const parsed = normalizarUrl(url);
    if (!parsed) throw new Error('El enlace debe ser una URL HTTP/HTTPS pública válida.');
    await validarHostPublico(parsed);

    // Los enlaces directos a archivos multimedia no necesitan un extractor;
    // transmitirlos a disco mantiene baja la RAM aunque sean videos grandes.
    if (plataformaEfectiva === 'auto' || DIRECT_MEDIA_EXTENSIONS.has(path.extname(parsed.pathname).toLowerCase())) {
      try {
        const directFile = await descargaDirecta(parsed.toString(), tempDir, 1);
        completed = true;
        return {
          archivos: [directFile],
          cleanup: () => limpiarDirectorio(tempDir)
        };
      } catch (directError) {
        console.warn('⚠️ Descarga directa no disponible; se probará yt-dlp:', directError.message);
        await limpiarDirectorio(tempDir);
        await fs.promises.mkdir(tempDir, { recursive: true });
      }
    }

    let errorVideo = null;
    try {
      await youtubedl(parsed.toString(), opcionesVideo, { timeout: TIMEOUT_MS });
    } catch (error) {
      errorVideo = error;
      await limpiarDirectorio(tempDir);
      await fs.promises.mkdir(tempDir, { recursive: true });
    }

    let archivos = await listarArchivosMedia(tempDir);

    // Un extractor puede identificar el post pero no ofrecer la selección de
    // video deseada (o devolver un carrusel de imágenes); reintentar sin format.
    if (!archivos.length) {
      try {
        await youtubedl(parsed.toString(), opcionesBase, { timeout: TIMEOUT_MS });
      } catch (errorBase) {
        errorVideo = errorBase || errorVideo;
      }
      archivos = await listarArchivosMedia(tempDir);
    }

    // yt-dlp prioriza video/audio; para posts solo de fotos extraer URLs de
    // imágenes de la página pública de Instagram antes de probar miniaturas.
    if (
      !archivos.length &&
      plataformaEfectiva === 'instagram' &&
      esErrorSinVideoInstagram(errorVideo)
    ) {
      await limpiarDirectorio(tempDir);
      await fs.promises.mkdir(tempDir, { recursive: true });
      try {
        archivos = await descargarImagenesInstagram(parsed.toString(), tempDir);
      } catch (imageError) {
        console.warn('⚠️ Fallback de imágenes de Instagram:', String(imageError?.message || imageError).slice(0, 350));
      }

      // Conserva el fallback de miniatura como segunda alternativa para URLs
      // públicas cuyo HTML no expone las imágenes originales.
      if (!archivos.length) {
        await limpiarDirectorio(tempDir);
        await fs.promises.mkdir(tempDir, { recursive: true });
        try {
          await youtubedl(parsed.toString(), {
            ...opcionesBase,
            writeThumbnail: true,
            ignoreNoFormatsError: true,
            skipDownload: true
          }, { timeout: TIMEOUT_MS });
        } catch (thumbnailError) {
          const detail = String(thumbnailError?.stderr || thumbnailError?.message || thumbnailError || '')
            .replace(/\s+/g, ' ').trim().slice(0, 250);
          console.warn('⚠️ Instagram sin video; resultado del intento de miniaturas:', detail);
        }
        archivos = await listarArchivosMedia(tempDir);
      }

      if (!archivos.length) {
        throw new Error(
          'Instagram no entregó imágenes descargables para esta publicación. Comprueba que sea pública; ' +
          'en carruseles, el acceso anónimo de Instagram puede ocultar las imágenes.'
        );
      }
    }

    // Fallback de URL directa: permite enlaces genéricos que respondan image/*
    // o video/* aunque yt-dlp no tenga un extractor específico para ese host.
    if (!archivos.length) {
      await limpiarDirectorio(tempDir);
      await fs.promises.mkdir(tempDir, { recursive: true });
      try {
        const directFile = await descargaDirecta(parsed.toString(), tempDir, 1);
        archivos = [directFile];
      } catch (directError) {
        if (errorVideo) {
          const detail = String(errorVideo?.stderr || errorVideo?.message || errorVideo).replace(/\s+/g, ' ').trim();
          throw new Error(detail.slice(0, 500) + ' | Enlace directo: ' + directError.message.slice(0, 250));
        }
        throw directError;
      }
    }

    if (!archivos.length) {
      throw new Error('El enlace no produjo archivos de imagen o video compatibles.');
    }

    const accepted = [];
    const oversized = [];
    for (const archivo of archivos) {
      if (archivo.size > MAX_MEDIA_BYTES) oversized.push(archivo.nombre);
      else accepted.push(archivo);
    }
    if (!accepted.length) {
      throw new Error('Los archivos descargados superan el límite de 100 MB por archivo.');
    }

    completed = true;
    return {
      archivos: accepted,
      omittedOversized: oversized.length,
      cleanup: () => limpiarDirectorio(tempDir)
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim();
    throw new Error(detail.slice(0, 700) || 'Falló la descarga.');
  } finally {
    if (!completed) await limpiarDirectorio(tempDir).catch(() => {});
  }
}

function tipoEnvioWhatsApp(archivo) {
  const size = Number(archivo?.size || 0);

  if (archivo?.tipo === 'image') {
    const extension = path.extname(String(archivo.nombre || archivo.path || '')).toLowerCase();
    const inlineImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    if (extension && !inlineImageExtensions.has(extension)) return 'document';
    return size > MAX_INLINE_IMAGE_BYTES ? 'document' : 'image';
  }
  if (archivo?.tipo === 'video') {
    return size > MAX_INLINE_VIDEO_BYTES ? 'document' : 'video';
  }
  return 'document';
}

function nombrePlataforma(plataforma) {
  return {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    x: 'X',
    twitter: 'X',
    youtube: 'YouTube',
    pinterest: 'Pinterest',
    facebook: 'Facebook',
    reddit: 'Reddit',
    threads: 'Threads',
    auto: 'este enlace'
  }[plataforma] || plataforma;
}

function detectarTipoPorUrl(url) {
  return detectarPlataforma(url) || 'auto';
}

async function comandoDescargaSocial(sock, chatId, msg, texto, plataforma = 'auto') {
  const url = extraerUrl(Array.isArray(texto) ? texto.join(' ') : texto, plataforma);
  const nombre = nombrePlataforma(plataforma);
  if (!url) {
    await sock.sendMessage(chatId, {
      text: plataforma === 'auto'
        ? '⚠️ Envíame un enlace público HTTP/HTTPS de una imagen, video o publicación compatible.'
        : '⚠️ Envíame un enlace público válido de ' + nombre + '. Ejemplo: ' + plataforma + ' https://...'
    }, { quoted: msg });
    return;
  }

  const posicion = colaDescargas.length + (descargaActiva ? 1 : 0);
  await sock.sendMessage(chatId, {
    text: posicion > 1
      ? '🕒 Tu descarga quedó en cola. Posición aproximada: ' + posicion + '.'
      : '⏳ Descargando el mejor archivo disponible (hasta 100 MB por archivo). Los videos largos pueden tardar varios minutos...'
  }, { quoted: msg });

  try {
    await encolarDescarga(async () => {
      const result = await descargarArchivos(url, plataforma);
      try {
        for (let i = 0; i < result.archivos.length; i++) {
          const archivo = result.archivos[i];
          const mediaKey = tipoEnvioWhatsApp(archivo);
          const caption = crearCaptionDescarga(archivo, mediaKey, i, result.archivos.length);
          const media = { url: archivo.path };
          const payload = {
            [mediaKey]: media,
            mimetype: archivo.mimetype,
            caption
          };
          if (mediaKey === 'document') payload.fileName = archivo.nombre;
          await sock.sendMessage(chatId, payload, { quoted: msg });
        }

        if (result.omittedOversized > 0) {
          await sock.sendMessage(chatId, {
            text: 'ℹ️ Se omitieron ' + result.omittedOversized + ' archivo(s) que superaban el límite de 100 MB.'
          }, { quoted: msg });
        }
      } finally {
        await result.cleanup().catch(() => {});
      }
      return true;
    });
  } catch (error) {
    console.error('Error descargando ' + nombre + ':', error.message);
    const privateContent = /login|private|401|403|cookies|sign in|authentication|HTTP 401|HTTP 403/i.test(error.message);
    await sock.sendMessage(chatId, {
      text: '❌ No pude descargar ese enlace. ' +
        (privateContent
          ? 'Comprueba que la publicación sea pública; el bot no puede acceder a contenido privado que requiera iniciar sesión.'
          : 'Prueba con el enlace original de “Compartir → Copiar enlace” o con un enlace directo al archivo.') +
        '\n\nDetalle: ' + error.message.slice(0, 500)
    }, { quoted: msg });
  }
}

module.exports = {
  MAX_MEDIA_BYTES,
  TIMEOUT_MS,
  MAX_MEDIA_FILES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_VIDEO_BYTES,
  tipoEnvioWhatsApp,
  crearCaptionDescarga,
  esErrorSinVideoInstagram,
  extraerUrlsImagenInstagram,
  extraerUrlsImagenGalleryDl,
  descargarImagenesInstagram,
  descargarImagenesInstagramConGalleryDl,
  comandoDescargaSocial,
  descargarArchivos,
  extraerUrl,
  analizarSolicitudDescarga,
  tipoMimetype,
  descargaDirecta,
  createMediaSizeLimiter,
  validarHostPublico,
  esIpPrivada,
  detectarPlataforma,
  normalizarUrl,
  liberarColaDescargas,
  estadoColaDescargas: () => ({
    pendientes: colaDescargas.length,
    descargaActiva,
    segundosActiva: trabajoActivoDesde ? Math.floor((Date.now() - trabajoActivoDesde) / 1000) : 0
  })
};
