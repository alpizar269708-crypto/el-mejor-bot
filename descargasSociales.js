const fs = require('fs');
const os = require('os');
const path = require('path');
const youtubeDlExec = require('youtube-dl-exec');

const youtubedl = youtubeDlExec;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120000;

function extraerUrl(texto, plataforma) {
  const host = plataforma === 'tiktok'
    ? /(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i
    : /(?:www\.)?instagram\.com/i;
  const coincidencias = String(texto || '').match(/https?:\/\/[^\s<>]+|(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|instagram\.com)\/[^\s<>]+/gi) || [];
  for (let valor of coincidencias) {
    valor = valor.replace(/[),.;!?]+$/g, '');
    if (!/^https?:\/\//i.test(valor)) valor = 'https://' + valor;
    try {
      const url = new URL(valor);
      if (!host.test(url.hostname)) continue;
      if (plataforma === 'tiktok' && !/(^|\.)tiktok\.com$/i.test(url.hostname)) continue;
      if (plataforma === 'instagram' && !/(^|\.)instagram\.com$/i.test(url.hostname)) continue;
      return url.toString();
    } catch (_) {}
  }
  return null;
}

async function descargarVideo(url, plataforma) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-download-'));
  const output = path.join(tempDir, 'video.%(ext)s');
  try {
    const opciones = {
      output,
      // Prioriza 1080p y 720p, combinando video y audio cuando están separados.
      // Si la publicación no ofrece HD, baja a la mejor calidad disponible.
      format: 'bestvideo[height<=1080][height>=720]+bestaudio/best[height<=1080][height>=720]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
      mergeOutputFormat: 'mp4',
      noWarnings: true,
      noPlaylist: true,
      noCheckCertificates: false,
      socketTimeout: 30,
      retries: 3,
      fragmentRetries: 3,
      extractorRetries: 2,
      noPart: true,
      restrictFilenames: true,
      maxFilesize: '64M',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: plataforma === 'instagram' ? 'https://www.instagram.com/' : 'https://www.tiktok.com/'
    };
    await youtubedl(url, opciones, { timeout: TIMEOUT_MS });
    const archivos = await fs.promises.readdir(tempDir);
    const video = archivos.map(nombre => path.join(tempDir, nombre))
      .filter(ruta => /\.(?:mp4|m4v|mov|webm)$/i.test(ruta))
      .sort((a, b) => path.extname(a).toLowerCase() === '.mp4' ? -1 : 1)[0];
    if (!video) throw new Error('El extractor no generó un archivo de video compatible.');
    const stat = await fs.promises.stat(video);
    if (!stat.size || stat.size > MAX_VIDEO_BYTES) {
      throw new Error(!stat.size ? 'El video descargado está vacío.' : 'El video supera el límite de 64 MB para enviarlo por WhatsApp.');
    }
    const buffer = await fs.promises.readFile(video);
    if (buffer.length < 10000) throw new Error('El archivo descargado no parece ser un video válido.');
    return buffer;
  } catch (error) {
    const detalle = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').trim();
    throw new Error(detalle.slice(0, 650) || 'Falló la descarga.');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function comandoDescargaSocial(sock, chatId, msg, texto, plataforma) {
  const url = extraerUrl(texto, plataforma);
  const nombre = plataforma === 'tiktok' ? 'TikTok' : 'Instagram';
  if (!url) {
    await sock.sendMessage(chatId, {
      text: '⚠️ Envíame un enlace público válido de ' + nombre + '. Ejemplo: ' + plataforma + ' https://...'
    }, { quoted: msg });
    return;
  }

  await sock.sendMessage(chatId, {
    text: '⏳ Descargando video de ' + nombre + ' en HD (hasta 1080p si está disponible)...'
  }, { quoted: msg });

  try {
    const video = await descargarVideo(url, plataforma);
    await sock.sendMessage(chatId, {
      video,
      mimetype: 'video/mp4',
      caption: '✅ Video listo en la mejor calidad disponible.'
    }, { quoted: msg });
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

module.exports = { comandoDescargaSocial };
