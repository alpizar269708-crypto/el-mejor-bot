const fs = require('fs');
const os = require('os');
const path = require('path');
const youtubeDlExec = require('youtube-dl-exec');

const youtubedl = youtubeDlExec;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120000;
const MAX_COLA_DESCARGAS = 100;
const colaDescargas = [];
let descargaActiva = false;
let trabajoActivoDesde = null;
function encolarDescarga(trabajo) {
  if (colaDescargas.length >= MAX_COLA_DESCARGAS) throw new Error('La cola está llena por ahora. Intenta de nuevo en unos minutos.');
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
      try { job.resolve(await job.trabajo()); } catch (error) { job.reject(error); }
      finally { trabajoActivoDesde = null; }
    }
  } finally {
    descargaActiva = false;
    if (colaDescargas.length) procesarColaDescargas().catch(() => {});
  }
}
function liberarColaDescargas() {
  const pendientes = colaDescargas.splice(0);
  for (const job of pendientes) job.reject(new Error('Solicitud cancelada por liberarcache.'));
  if (typeof global.gc === 'function') { try { global.gc(); } catch (_) {} }
  return { pendientesCancelados: pendientes.length, descargaActiva,
    segundosActiva: trabajoActivoDesde ? Math.floor((Date.now() - trabajoActivoDesde) / 1000) : 0,
    recoleccionForzadaDisponible: typeof global.gc === 'function' };
}

function extraerUrl(texto, plataforma) {
  const patrones = {
    tiktok: /(?:^|\.)(?:tiktok\.com)$/i,
    instagram: /(?:^|\.)instagram\.com$/i,
    x: /(?:^|\.)(?:x\.com|twitter\.com|t\.co)$/i,
    pinterest: /(?:^|\.)(?:pinterest\.[a-z.]+|pin\.it)$/i,
    facebook: /(?:^|\.)(?:facebook\.com|fb\.watch|fb\.com)$/i,
    reddit: /(?:^|\.)(?:reddit\.com|redd\.it)$/i,
    threads: /(?:^|\.)threads\.net$/i
  };
  const patron = patrones[plataforma];
  if (!patron) return null;
  const coincidencias = String(texto || '').match(/https?:\/\/[^\s<>]+|(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>]*)?/gi) || [];
  for (let valor of coincidencias) {
    valor = valor.replace(/[),.;!?]+$/g, '');
    if (!/^https?:\/\//i.test(valor)) valor = 'https://' + valor;
    try {
      const url = new URL(valor);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const valido = plataforma === 'tiktok'
        ? /(^|\.)tiktok\.com$/.test(host)
        : plataforma === 'instagram'
          ? /(^|\.)instagram\.com$/.test(host)
          : plataforma === 'x'
            ? /(^|\.)(?:x\.com|twitter\.com|t\.co)$/.test(host)
            : plataforma === 'pinterest'
              ? /(^|\.)(?:pinterest\.[a-z.]+|pin\.it)$/.test(host)
              : plataforma === 'facebook'
                ? /(^|\.)(?:facebook\.com|fb\.watch|fb\.com)$/.test(host)
                : plataforma === 'reddit'
                  ? /(^|\.)(?:reddit\.com|redd\.it)$/.test(host)
                  : plataforma === 'threads'
                    ? /(^|\.)threads\.net$/.test(host)
                    : patron.test(host);
      if (valido) return url.toString();
    } catch (_) {}
  }
  return null;
}
async function descargarArchivos(url, plataforma) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-download-'));
  const output = path.join(tempDir, '%(autonumber)03d.%(ext)s');
  const opcionesBase = {
    output,
    noWarnings: true,
    // youtube-dl-exec convierte `noPlaylist: false` en la opción inválida --no-no-playlist.
    // Para Instagram/TikTok/Pinterest omitimos la opción y permitimos carruseles.
    ...(!['instagram', 'pinterest', 'tiktok'].includes(plataforma) ? { noPlaylist: true } : {}),
    playlistEnd: 10,
    maxDownloads: 10,
    socketTimeout: 30,
    retries: 3,
    fragmentRetries: 3,
    extractorRetries: 2,
    noPart: true,
    restrictFilenames: true,
    maxFilesize: '64M',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: ({
      instagram: 'https://www.instagram.com/',
      x: 'https://x.com/',
      pinterest: 'https://www.pinterest.com/',
      facebook: 'https://www.facebook.com/',
      reddit: 'https://www.reddit.com/',
      threads: 'https://www.threads.net/'
    })[plataforma] || 'https://www.tiktok.com/'
  };
  const opcionesVideo = {
    ...opcionesBase,
    format: 'bestvideo[height<=1080][height>=720]+bestaudio/best[height<=1080][height>=720]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
    mergeOutputFormat: 'mp4'
  };

  try {
    // Primero intentamos la mejor calidad de video. Si el enlace es una publicación
    // de fotos/carrusel, reintentamos sin selector de video para recuperar imágenes.
    try {
      await youtubedl(url, opcionesVideo, { timeout: TIMEOUT_MS });
    } catch (errorVideo) {
      if (!['instagram', 'tiktok', 'pinterest', 'facebook', 'reddit', 'threads', 'x'].includes(plataforma)) throw errorVideo;
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      await fs.promises.mkdir(tempDir, { recursive: true });
      await youtubedl(url, opcionesBase, { timeout: TIMEOUT_MS });
    }

    let nombres = (await fs.promises.readdir(tempDir))
      .filter(nombre => /\.(?:mp4|m4v|mov|webm|jpe?g|png|webp|avif)$/i.test(nombre))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // Algunos extractores no fallan con el selector de video, pero tampoco
    // generan archivos (caso típico de publicaciones de solo fotos).
    if (!nombres.length && ['instagram', 'tiktok', 'pinterest', 'facebook', 'reddit', 'threads', 'x'].includes(plataforma)) {
      await youtubedl(url, opcionesBase, { timeout: TIMEOUT_MS });
      nombres = (await fs.promises.readdir(tempDir))
        .filter(nombre => /\.(?:mp4|m4v|mov|webm|jpe?g|png|webp|avif)$/i.test(nombre))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    if (!nombres.length) throw new Error(nombrePlataforma(plataforma) + ' no produjo archivos de imagen o video compatibles.');
    const archivos = [];
    for (const nombre of nombres.slice(0, 10)) {
      const ruta = path.join(tempDir, nombre);
      const stat = await fs.promises.stat(ruta);
      if (!stat.size || stat.size > MAX_VIDEO_BYTES) continue;
      const buffer = await fs.promises.readFile(ruta);
      if (buffer.length === 0) continue;
      const extension = path.extname(nombre).toLowerCase();
      const esImagen = /\.(?:jpe?g|png|webp|avif)$/i.test(extension);
      archivos.push({
        buffer,
        tipo: esImagen ? 'image' : 'video',
        mimetype: esImagen
          ? ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' }[extension] || 'image/jpeg')
          : (extension === '.webm' ? 'video/webm' : 'video/mp4')
      });
    }
    if (!archivos.length) throw new Error('Los archivos descargados están vacíos o superan el límite de 64 MB.');
    return archivos;
  } catch (error) {
    const detalle = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim();
    throw new Error(detalle.slice(0, 650) || 'Falló la descarga.');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function nombrePlataforma(plataforma) {
  return { tiktok: 'TikTok', instagram: 'Instagram', x: 'X', pinterest: 'Pinterest', facebook: 'Facebook', reddit: 'Reddit', threads: 'Threads' }[plataforma] || plataforma;
}

async function comandoDescargaSocial(sock, chatId, msg, texto, plataforma) {
  const url = extraerUrl(texto, plataforma);
  const nombre = nombrePlataforma(plataforma);
  if (!url) {
    await sock.sendMessage(chatId, {
      text: '⚠️ Envíame un enlace público válido de ' + nombre + '. Ejemplo: ' + plataforma + ' https://...'
    }, { quoted: msg });
    return;
  }

  const posicion = colaDescargas.length + (descargaActiva ? 1 : 0);
  await sock.sendMessage(chatId, {
    text: posicion > 1 ? '🕒 Tu descarga de ' + nombre + ' quedó en cola. Posición aproximada: ' + posicion + '.' : '⏳ Preparando descarga de ' + nombre + ' en HD (hasta 1080p si está disponible)...'
  }, { quoted: msg });

  try {
    await encolarDescarga(async () => {
      const archivos = await descargarArchivos(url, plataforma);
      for (let i = 0; i < archivos.length; i++) {
        const archivo = archivos[i];
        const caption = archivos.length > 1
          ? '✅ Archivo ' + (i + 1) + ' de ' + archivos.length + ' descargado.'
          : (archivo.tipo === 'image'
            ? '✅ Foto descargada de ' + nombre + '.'
            : '✅ Video listo en la mejor calidad disponible.');
        await sock.sendMessage(chatId, {
          [archivo.tipo]: archivo.buffer,
          mimetype: archivo.mimetype,
          caption
        }, { quoted: msg });
      }
      return true;
    });
  } catch (error) {
    console.error('Error descargando ' + nombre + ':', error.message);
    const privado = /login|private|401|403|cookies|sign in|authentication/i.test(error.message);
    await sock.sendMessage(chatId, {
      text: '❌ No pude descargar ese enlace de ' + nombre + '. ' +
        (privado
          ? 'Comprueba que la publicación sea pública; el bot no puede acceder a contenido privado que requiera iniciar sesión.'
          : 'Prueba con el enlace original de “Compartir → Copiar enlace”.') +
        '\n\nDetalle: ' + error.message.slice(0, 500)
    }, { quoted: msg });
  }
}

module.exports = {
  comandoDescargaSocial,
  extraerUrl,
  liberarColaDescargas,
  estadoColaDescargas: () => ({ pendientes: colaDescargas.length, descargaActiva,
    segundosActiva: trabajoActivoDesde ? Math.floor((Date.now() - trabajoActivoDesde) / 1000) : 0 })
};
