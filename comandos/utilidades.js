const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const youtubeDlExec = require('youtube-dl-exec');
const ytDlpPersonalizado = path.join(process.cwd(), '.venv', 'bin', 'yt-dlp');
const youtubedl = fs.existsSync(ytDlpPersonalizado)
    ? youtubeDlExec.create(ytDlpPersonalizado)
    : youtubeDlExec;

console.log('✅ Módulo TikTok: parser de enlaces + SnapTik activo');

function obtenerEjecutableChrome() {
    const candidatos = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/opt/render/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome',
        path.join(os.homedir(), '.cache', 'puppeteer', 'chrome', 'linux-153.0.8010.36', 'chrome-linux64', 'chrome')
    ].filter(Boolean);
    for (const candidato of candidatos) {
        try { if (fs.existsSync(candidato)) return candidato; } catch (_) {}
    }
    try {
        const raiz = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
        const base = path.join(raiz, 'chrome');
        if (fs.existsSync(base)) {
            const versiones = fs.readdirSync(base).filter(x => /^linux-/.test(x)).sort().reverse();
            for (const version of versiones) {
                const candidato = path.join(base, version, 'chrome-linux64', 'chrome');
                if (fs.existsSync(candidato)) return candidato;
            }
        }
    } catch (_) {}
    return null;
}

function opcionesPuppeteer() {
    const executablePath = obtenerEjecutableChrome();
    return {
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    };
}
const { downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

const STICKER_PACK = 'JASC13';
const STICKER_AUTHOR = 'JASC13 - BOT';

// 🚀 Caché para no repetir conversiones idénticas y deduplicar trabajos simultáneos.
const stickerCache = new Map();
const stickerEnProceso = new Map();
const STICKER_CACHE_TTL_MS = 10 * 60 * 1000;
const STICKER_CACHE_MAX = 12;

// 🎨 1. Sticker (conversión híbrida: Cloudinary + fallback local)
function limpiarCacheStickers() {
    const ahora = Date.now();
    for (const [clave, dato] of stickerCache) {
        if (dato.expira <= ahora) stickerCache.delete(clave);
    }
    while (stickerCache.size > STICKER_CACHE_MAX) {
        const primeraClave = stickerCache.keys().next().value;
        if (primeraClave === undefined) break;
        stickerCache.delete(primeraClave);
    }
}

function obtenerConfiguracionCloudinary() {
    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
    const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
    const uploadPreset = String(process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();
    if (!cloudName) return null;
    if (apiKey && apiSecret) return { cloudName, apiKey, apiSecret };
    if (uploadPreset) return { cloudName, uploadPreset };
    return null;
}

function crearFirmaCloudinary(params, apiSecret) {
    const cadena = Object.keys(params)
        .filter(clave => params[clave] !== undefined && params[clave] !== null && params[clave] !== '')
        .sort()
        .map(clave => clave + '=' + params[clave])
        .join('&');
    return crypto.createHash('sha1').update(cadena + apiSecret).digest('hex');
}

async function subirVideoCloudinary(buffer, hash) {
    const config = obtenerConfiguracionCloudinary();
    if (!config) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = 'wa_sticker_jasc13_v2_' + hash;
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'video/mp4' }), 'sticker.mp4');

    if (config.apiKey && config.apiSecret) {
        form.append('api_key', config.apiKey);
        form.append('timestamp', String(timestamp));
        form.append('public_id', publicId);
        form.append('signature', crearFirmaCloudinary({ public_id: publicId, timestamp }, config.apiSecret));
    } else {
        form.append('upload_preset', config.uploadPreset);
    }

    const respuesta = await fetch(
        'https://api.cloudinary.com/v1_1/' + encodeURIComponent(config.cloudName) + '/video/upload',
        { method: 'POST', body: form, signal: AbortSignal.timeout(20000) }
    );
    if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        throw new Error('Cloudinary upload ' + respuesta.status + ': ' + detalle.slice(0, 300));
    }
    const datos = await respuesta.json();
    return { cloudName: config.cloudName, publicId: datos.public_id || publicId };
}

async function descargarStickerCloudinary(buffer, hash) {
    const config = obtenerConfiguracionCloudinary();
    if (!config) return null;

    const publicId = 'wa_sticker_jasc13_v2_' + hash;
    const transformacion = 'c_pad,w_512,h_512,b_transparent,fl_animated.fl_awebp,vs_10,q_auto:good';
    const urlBase = 'https://res.cloudinary.com/' + encodeURIComponent(config.cloudName) +
        '/video/upload/' + transformacion + '/';

    let url = urlBase + encodeURIComponent(publicId) + '.webp';
    let respuesta = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (respuesta.ok) {
        const resultadoExistente = Buffer.from(await respuesta.arrayBuffer());
        if (resultadoExistente.length) return resultadoExistente;
    }

    const asset = await subirVideoCloudinary(buffer, hash);
    if (!asset) return null;

    url = urlBase + encodeURIComponent(asset.publicId || publicId) + '.webp';
    respuesta = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!respuesta.ok) throw new Error('Cloudinary transform ' + respuesta.status);

    const resultado = Buffer.from(await respuesta.arrayBuffer());
    if (!resultado.length) throw new Error('Cloudinary devolvió un sticker vacío.');
    return resultado;
}

async function agregarMetadatosSticker(buffer, esVideo) {
    const sticker = new Sticker(buffer, {
        pack: STICKER_PACK,
        author: STICKER_AUTHOR,
        type: StickerTypes.FULL,
        quality: esVideo ? 10 : 50
    });
    return sticker.toBuffer();
}

async function prepararImagenSinRecorte(buffer) {
    return sharp(buffer, { animated: false })
        .resize(480, 480, {
            fit: 'contain',
            position: 'center',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();
}

async function convertirStickerLocal(buffer, esVideo) {
    const entrada = esVideo ? buffer : await prepararImagenSinRecorte(buffer);
    const sticker = new Sticker(entrada, {
        pack: STICKER_PACK,
        author: STICKER_AUTHOR,
        type: StickerTypes.FULL,
        quality: esVideo ? 10 : 90,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
    return sticker.toBuffer();
}

async function convertirVideoASticker(buffer, hash) {
    limpiarCacheStickers();
    const cacheado = stickerCache.get('vid:' + hash);
    if (cacheado && cacheado.expira > Date.now()) return cacheado.buffer;
    if (cacheado) stickerCache.delete('vid:' + hash);
    if (stickerEnProceso.has(hash)) return stickerEnProceso.get(hash);

    const trabajo = (async () => {
        let resultado = null;
        if (obtenerConfiguracionCloudinary()) {
            try {
                resultado = await descargarStickerCloudinary(buffer, hash);
                if (resultado) resultado = await agregarMetadatosSticker(resultado, true);
            } catch (error) {
                console.warn('⚠️ Cloudinary no pudo convertir el sticker marcado; usando fallback local:', error.message);
            }
        }
        if (!resultado) resultado = await convertirStickerLocal(buffer, true);
        stickerCache.set('vid:' + hash, { buffer: resultado, expira: Date.now() + STICKER_CACHE_TTL_MS });
        limpiarCacheStickers();
        return resultado;
    })();
    stickerEnProceso.set(hash, trabajo);
    try {
        return await trabajo;
    } finally {
        stickerEnProceso.delete(hash);
    }
}

async function comandoSticker(sock, msg) {
    const chatJid = msg.key.remoteJid;
    try {
        const msgTipo = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage;
        const msjCitado = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const citadoTipo = msjCitado?.imageMessage || msjCitado?.videoMessage || msjCitado?.documentMessage;
        if (!msgTipo && !citadoTipo) {
            return await sock.sendMessage(chatJid, { text: '⚠️ Por favor, responde a una imagen o video, o envíalo adjunto a la imagen.' }, { quoted: msg });
        }

        const tipoDocumento = msg.message?.documentMessage || msjCitado?.documentMessage;
        const mimeDocumento = String(tipoDocumento?.mimetype || msg.message?.imageMessage?.mimetype || msjCitado?.imageMessage?.mimetype || '').toLowerCase();
        const esGif = mimeDocumento === 'image/gif' || mimeDocumento === 'image/webp';
        const videoAdjunto = !!(msg.message?.videoMessage || msjCitado?.videoMessage);

        const msjMultimedia = citadoTipo ? { message: msjCitado } : msg;
        const buffer = await downloadMediaMessage(msjMultimedia, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
        // Trata GIF y WebP como entrada del pipeline animado aunque el lector de metadatos
        // no detecte sus fotogramas. Así no se pierde el movimiento por una falsa detección estática.
        let duracionAnimacion = 0;
        if (esGif && !videoAdjunto) {
            try {
                const metadataAnimada = await sharp(buffer, { animated: true }).metadata();
                if (Array.isArray(metadataAnimada.delay)) {
                    duracionAnimacion = metadataAnimada.delay.reduce((suma, ms) => suma + Number(ms || 0), 0) / 1000;
                }
            } catch (error) {
                console.warn('⚠️ No se pudo leer la duración del GIF/WebP:', error.message);
            }
        }
        const esVideo = videoAdjunto || esGif;
        if (esVideo) {
            const duracion = msg.message?.videoMessage?.seconds || msjCitado?.videoMessage?.seconds || duracionAnimacion || 0;
            if (duracion > 10) {
                return await sock.sendMessage(chatJid, { text: '⚠️ El video o GIF animado es muy largo. Envía contenido de máximo 10 segundos para no saturar el sistema.' }, { quoted: msg });
            }
        }
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        let stickerBuffer;

        if (esVideo) {
            // Los GIF/WebP animados deben pasar por el mismo pipeline animado que los videos.
            // Antes entraban al pipeline de imagen y se enviaba únicamente el primer fotograma.
            stickerBuffer = await convertirVideoASticker(buffer, hash);
        } else {
            const clave = 'img:' + hash;
            limpiarCacheStickers();
            const cacheado = stickerCache.get(clave);
            if (cacheado && cacheado.expira > Date.now()) {
                stickerBuffer = cacheado.buffer;
            } else {
                stickerBuffer = await convertirStickerLocal(buffer, false);
                stickerCache.set(clave, { buffer: stickerBuffer, expira: Date.now() + STICKER_CACHE_TTL_MS });
                limpiarCacheStickers();
            }
        }

        await sock.sendMessage(chatJid, { sticker: stickerBuffer }, { quoted: msg });
    } catch (e) {
        console.error('Error al crear el sticker:', e);
        await sock.sendMessage(chatJid, { text: '❌ Error al crear el sticker. Asegúrate de que el formato sea soportado.' }, { quoted: msg });
    }
}

// ♻️ Recuperar foto de una sola visualización como foto normal
async function comandoRecup1Vez(sock, chatId, msg) {
    const responder = async (text) => {
        return await sock.sendMessage(chatId, { text }, { quoted: msg });
    };

    try {
        const contexto = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.conversation?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.buttonsResponseMessage?.contextInfo
            || msg.message?.listResponseMessage?.contextInfo;

        const citado = contexto?.quotedMessage;
        if (!citado) {
            return await responder('⚠️ Responde directamente a la foto de *ver una vez* y manda *recup1vez*.');
        }

        // WhatsApp/Baileys puede entregar una foto de una vez con varias capas:
        // viewOnceMessage, viewOnceMessageV2, viewOnceMessageV2Extension,
        // ephemeralMessage y combinaciones entre ellas.
        const extraerImagen = (mensaje, ruta = []) => {
            if (!mensaje || typeof mensaje !== 'object') return null;

            if (mensaje.imageMessage) {
                return {
                    image: mensaje.imageMessage,
                    ruta: [...ruta, 'imageMessage']
                };
            }

            const envolturas = [
                'viewOnceMessage',
                'viewOnceMessageV2',
                'viewOnceMessageV2Extension',
                'ephemeralMessage',
                'documentWithCaptionMessage'
            ];

            for (const clave of envolturas) {
                const interno = mensaje[clave]?.message;
                if (interno) {
                    const encontrada = extraerImagen(interno, [...ruta, clave]);
                    if (encontrada) return encontrada;
                }
            }

            return null;
        };

        const encontrada = extraerImagen(citado);
        if (!encontrada?.image) {
            console.warn('⚠️ recup1vez: estructura recibida sin imageMessage:', JSON.stringify(Object.keys(citado || {})));
            return await responder(
                '❌ No encontré una foto recuperable en ese mensaje. Asegúrate de responder *directamente* a la foto de ver una vez.'
            );
        }

        const imagen = encontrada.image;
        let buffer = null;

        // Método principal: descargar directamente el imageMessage.
        // Esto evita que downloadMediaMessage pierda la capa viewOnce.
        try {
            const stream = await downloadContentFromMessage(imagen, 'image');
            const partes = [];
            for await (const parte of stream) partes.push(Buffer.from(parte));
            buffer = Buffer.concat(partes);
        } catch (error) {
            console.warn('⚠️ recup1vez: descarga directa falló, probando downloadMediaMessage:', error.message);
        }

        // Fallback para versiones de Baileys que requieren el mensaje completo.
        if (!buffer?.length) {
            try {
                const mensajeNormalizado = {
                    key: msg.key,
                    message: { imageMessage: imagen }
                };
                buffer = await downloadMediaMessage(
                    mensajeNormalizado,
                    'buffer',
                    {},
                    { reuploadRequest: sock.updateMediaMessage }
                );
            } catch (error) {
                console.warn('⚠️ recup1vez: fallback de downloadMediaMessage falló:', error.message);
            }
        }

        if (!buffer?.length) {
            throw new Error('No se pudo descargar el contenido multimedia.');
        }

        const mimetype = String(imagen.mimetype || 'image/jpeg').toLowerCase();

        await sock.sendMessage(chatId, {
            image: buffer,
            mimetype,
            caption: '♻️ Foto recuperada'
        }, { quoted: msg });

        console.log('✅ recup1vez: foto recuperada correctamente. Capas:', encontrada.ruta.join(' > '));
    } catch (e) {
        console.error('❌ Error al recuperar foto de una vez:', e?.stack || e);
        await responder(
            '❌ No pude recuperar esa foto de ver una vez. Prueba respondiendo directamente a la foto (sin reenviarla) y manda *recup1vez*.'
        );
    }
}

// 🎬 2. TikTok (Descarga sin marca de agua)
function extraerUrlTikTok(texto) {
    const fuente = String(texto || '').trim();
    if (!fuente) return null;

    // WhatsApp/web puede entregar el enlace con formato Markdown:
    // [https://vt.tiktok.com/...](https://vt.tiktok.com/...)
    const markdown = [...fuente.matchAll(/\]\((https?:\/\/(?:www\.)?(?:(?:tiktok\.com|m\.tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com))\/[^)\s]+)\)/gi)]
        .map(m => m[1]);

    const urls = [
        ...markdown,
        ...(fuente.match(/https?:\/\/(?:www\.)?(?:(?:tiktok\.com|m\.tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com))\/[^\s<>\]\)]+/gi) || [])
    ];

    for (let url of urls) {
        url = url.replace(/[),.;!?]+$/g, '');
        try {
            const u = new URL(url);
            if (/(^|\.)tiktok\.com$/i.test(u.hostname)) return u.toString();
        } catch (_) {}
    }

    // También aceptamos un enlace sin https://.
    const sinEsquema = fuente.match(/(?:www\.)?(?:(?:tiktok\.com|m\.tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com))\/[^\s<>\]\)]+/i);
    if (sinEsquema?.[0]) {
        try {
            const u = new URL('https://' + sinEsquema[0].replace(/[),.;!?]+$/g, ''));
            if (/(^|\.)tiktok\.com$/i.test(u.hostname)) return u.toString();
        } catch (_) {}
    }

    return null;
}

async function resolverEnlaceTikTok(url) {
    let original;
    try { original = new URL(url); } catch { return url; }

    const esCanonico = /\/(?:@[^/]+\/video\/|video\/|photo\/)/i.test(original.pathname);
    if (esCanonico) return url;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
    };

    try {
        const respuesta = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers,
            signal: AbortSignal.timeout(15000)
        });
        if (respuesta.url && /tiktok\.com/i.test(respuesta.url)) {
            const finalUrl = new URL(respuesta.url);
            if (/\/(?:@[^/]+\/video\/|video\/|photo\/)/i.test(finalUrl.pathname)) {
                return finalUrl.toString();
            }
        }
    } catch (error) {
        console.warn('⚠️ No se pudo resolver TikTok por HTTP:', error.message);
    }

    // Algunos enlaces vt/vm son enviados por TikTok a una URL intermedia
    // (por ejemplo /?_r=1). Chromium sigue la navegación real y nos da la URL final.
    if (/^(?:vt|vm)\.tiktok\.com$/i.test(original.hostname) || /\/t\//i.test(original.pathname)) {
        let browser;
        try {
            browser = await puppeteer.launch(opcionesPuppeteer());
            const page = await browser.newPage();
            await page.setUserAgent(headers['User-Agent']);
            await page.setExtraHTTPHeaders({ 'Accept-Language': headers['Accept-Language'] });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
            const finalUrl = page.url();
            if (finalUrl && /tiktok\.com/i.test(finalUrl)) {
                const u = new URL(finalUrl);
                if (/\/(?:@[^/]+\/video\/|video\/|photo\/)/i.test(u.pathname)) return u.toString();
            }
        } catch (error) {
            console.warn('⚠️ No se pudo resolver TikTok con navegador:', error.message);
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    return url;
}

function extraerDatosTikTokDePagina(pagina, cookies = '') {
    let data = null;
    const extraerJsonScript = (id) => {
        const inicio = pagina.indexOf('<script id="' + id + '"');
        if (inicio < 0) return null;
        const contenido = pagina.indexOf('>', inicio);
        const fin = pagina.indexOf('</script>', contenido);
        if (contenido < 0 || fin < 0) return null;
        try { return JSON.parse(pagina.slice(contenido + 1, fin)); } catch { return null; }
    };
    data = extraerJsonScript('__UNIVERSAL_DATA_FOR_REHYDRATION__') || extraerJsonScript('SIGI_STATE');
    let item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || null;
    if (!item && data?.ItemModule) item = Object.values(data.ItemModule).find(x => x?.video?.playAddr || x?.video?.downloadAddr) || null;
    const video = item?.video;
    if (!video) throw new Error('TikTok no entregó los datos del video en la página');
    const candidatos = [];
    if (Array.isArray(video.bitrateInfo)) for (const calidad of video.bitrateInfo) {
        for (const videoUrl of (calidad?.PlayAddr?.UrlList || [])) if (videoUrl) candidatos.push({
            url: String(videoUrl).replace(/\\u0026/g, '&').replace(/\\u002F/g, '/'),
            bitrate: Number(calidad?.Bitrate || 0), codec: String(calidad?.CodecType || '')
        });
    }
    for (const videoUrl of [video.downloadAddr, video.playAddr]) if (videoUrl) candidatos.push({
        url: String(videoUrl).replace(/\\u0026/g, '&').replace(/\\u002F/g, '/'),
        bitrate: Number(video.bitrate || 0), codec: String(video.codecType || 'h264')
    });
    const validos = candidatos.filter(x => typeof x.url === 'string' && (x.url.startsWith('https://') || x.url.startsWith('http://')));
    if (!validos.length) throw new Error('TikTok no devolvió una URL MP4');
    const h264 = validos.filter(x => /h264/i.test(x.codec));
    const lista = h264.length ? h264 : validos;
    lista.sort((a,b) => b.bitrate - a.bitrate);
    return { videoUrl: lista[0].url, cookie: cookies, titulo: item?.desc || 'TikTok' };
}
async function obtenerTikTokDirecto(url) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const headersBase = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
    };

    let respuesta = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: headersBase,
        signal: AbortSignal.timeout(30000)
    });

    if (!respuesta.ok) {
        throw new Error('TikTok página respondió HTTP ' + respuesta.status);
    }

    const cookies = typeof respuesta.headers.getSetCookie === 'function'
        ? respuesta.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
        : '';

    const pagina = await respuesta.text();
    let data = null;

    const extraerJsonScript = (id) => {
        const inicio = pagina.indexOf('<script id="' + id + '"');
        if (inicio < 0) return null;
        const inicioContenido = pagina.indexOf('>', inicio);
        if (inicioContenido < 0) return null;
        const fin = pagina.indexOf('</script>', inicioContenido);
        if (fin < 0) return null;
        try {
            return JSON.parse(pagina.slice(inicioContenido + 1, fin));
        } catch {
            return null;
        }
    };

    data = extraerJsonScript('__UNIVERSAL_DATA_FOR_REHYDRATION__');

    // TikTok también ha usado SIGI_STATE como fuente de datos.
    if (!data) {
        data = extraerJsonScript('SIGI_STATE');
    }

    let item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct || null;

    if (!item && data?.ItemModule) {
        const valores = Object.values(data.ItemModule);
        item = valores.find(x => x?.video?.playAddr || x?.video?.downloadAddr) || null;
    }

    const video = item?.video;
    if (!video) {
        throw new Error('TikTok no entregó los datos del video en la página');
    }

    const candidatos = [];

    if (Array.isArray(video.bitrateInfo)) {
        for (const calidad of video.bitrateInfo) {
            const urls = calidad?.PlayAddr?.UrlList || [];
            for (const videoUrl of urls) {
                if (videoUrl) {
                    candidatos.push({
                        url: videoUrl.replace(/\\u0026/g, '&').replace(/\\u002F/g, '/'),
                        bitrate: Number(calidad?.Bitrate || 0),
                        codec: String(calidad?.CodecType || '')
                    });
                }
            }
        }
    }

    for (const videoUrl of [video.downloadAddr, video.playAddr]) {
        if (videoUrl) {
            candidatos.push({
                url: String(videoUrl).replace(/\\u0026/g, '&').replace(/\\u002F/g, '/'),
                bitrate: Number(video.bitrate || 0),
                codec: String(video.codecType || 'h264')
            });
        }
    }

    const validos = candidatos.filter(x =>
        typeof x.url === 'string' &&
        (x.url.startsWith('https://') || x.url.startsWith('http://'))
    );
    if (!validos.length) {
        throw new Error('TikTok no devolvió una URL MP4');
    }

    // Preferimos H.264 porque WhatsApp maneja mejor ese MP4 que HEVC/ByteVC1.
    const h264 = validos.filter(x => /h264/i.test(x.codec));
    const lista = h264.length ? h264 : validos;
    lista.sort((a, b) => b.bitrate - a.bitrate);

    return {
        videoUrl: lista[0].url,
        cookie: cookies,
        titulo: item?.desc || 'TikTok'
    };
}

async function obtenerTikTokConNavegador(url) {
    let browser;
    try {
        browser = await puppeteer.launch(opcionesPuppeteer());
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });
        await page.setViewport({ width: 1365, height: 900 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(resolve => setTimeout(resolve, 2500));
        const pagina = await page.content();
        const cookies = (await page.cookies()).map(c => c.name + '=' + c.value).join('; ');
        return extraerDatosTikTokDePagina(pagina, cookies);
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

async function descargarVideoTikTokConNavegador(videoUrl, cookie = '') {
    let browser;
    try {
        browser = await puppeteer.launch(opcionesPuppeteer());
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1365, height: 900 });
        if (cookie) {
            const cookies = cookie.split(';').map(x => x.trim()).filter(Boolean).map(x => {
                const i = x.indexOf('=');
                return i > 0 ? { name:x.slice(0,i), value:x.slice(i+1), domain:'.tiktok.com', path:'/' } : null;
            }).filter(Boolean);
            if (cookies.length) await page.setCookie(...cookies);
        }
        await page.setExtraHTTPHeaders({
            'Referer':'https://www.tiktok.com/',
            'Accept-Language':'es-MX,es;q=0.9,en;q=0.8'
        });

        let videoResponse = null;
        page.on('response', response => {
            try {
                if (videoResponse || !response.ok()) return;
                const h = response.headers();
                const type = String(h['content-type'] || '').toLowerCase();
                const u = response.url();
                const len = Number(h['content-length'] || 0);
                const media = type.includes('video/') ||
                    /\.(mp4|m4v|mov)(?:$|[?#])/i.test(u) ||
                    /tiktokcdn\.com/i.test(u) && len > 10000;
                if (media) videoResponse = response;
            } catch (_) {}
        });

        await page.goto('about:blank', {waitUntil:'domcontentloaded', timeout:15000});
        await page.evaluate(url => {
            const v=document.createElement('video');
            v.muted=true; v.preload='auto'; v.src=url; v.load();
            document.body.appendChild(v);
        }, videoUrl);

        const inicio=Date.now();
        while (!videoResponse && Date.now()-inicio<30000)
            await new Promise(r=>setTimeout(r,200));

        if (videoResponse) {
            try {
                const b=await videoResponse.buffer();
                if (b?.length>10000) return b;
            } catch (_) {}
        }

        // Segunda vía: fetch dentro de Chromium.
        try {
            const b64=await page.evaluate(async url => {
                const r=await fetch(url,{credentials:'include'});
                if(!r.ok) throw new Error('HTTP '+r.status);
                const a=new Uint8Array(await r.arrayBuffer());
                let s='';
                for(let i=0;i<a.length;i+=0x8000) s+=String.fromCharCode(...a.subarray(i,i+0x8000));
                return btoa(s);
            },videoUrl);
            const b=Buffer.from(b64,'base64');
            if(b.length>10000) return b;
        } catch (_) {}

        // Tercera vía: navegación directa al recurso.
        try {
            let rmp4=null;
            const handler=r=>{
                try {
                    const type=String(r.headers()['content-type']||'');
                    if(!rmp4 && r.ok() && (/video\//i.test(type)||/\.(mp4|m4v|mov)(?:$|[?#])/i.test(r.url())||/tiktokcdn\.com/i.test(r.url()))) rmp4=r;
                } catch(_){}
            };
            page.on('response',handler);
            await page.goto(videoUrl,{waitUntil:'domcontentloaded',timeout:90000}).catch(()=>{});
            if(rmp4){
                const b=await rmp4.buffer();
                if(b?.length>10000) return b;
            }
        } catch (_) {}

        throw new Error('Chromium no pudo obtener el cuerpo del MP4 del CDN');
    } finally {
        if(browser) await browser.close().catch(()=>{});
    }
}

async function obtenerCookiesTikTokParaYtDlp(url) {
    let browser;
    try {
        browser = await puppeteer.launch(opcionesPuppeteer());
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language':'es-MX,es;q=0.9,en;q=0.8',
            'Upgrade-Insecure-Requests':'1'
        });
        await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 }).catch(()=>{});
        await new Promise(resolve => setTimeout(resolve, 4000));
        const cookies = await page.cookies();
        if (!cookies.length) return null;

        const lineas = ['# Netscape HTTP Cookie File', '# Generated automatically for yt-dlp'];
        for (const c of cookies) {
            lineas.push([
                c.domain || '.tiktok.com',
                c.domain?.startsWith('.') ? 'TRUE' : 'FALSE',
                c.path || '/',
                c.secure ? 'TRUE' : 'FALSE',
                Math.round(c.expires > 0 ? c.expires : 0),
                c.name,
                c.value || ''
            ].join('\t'));
        }

        const archivo = path.join(os.tmpdir(), 'tiktok-cookies-' + crypto.randomBytes(8).toString('hex') + '.txt');
        fs.writeFileSync(archivo, lineas.join('\n') + '\n', 'utf8');
        return archivo;
    } catch (e) {
        console.warn('⚠️ No se pudieron obtener cookies de TikTok para yt-dlp:', e?.message || e);
        return null;
    } finally {
        if (browser) await browser.close().catch(()=>{});
    }
}

async function ejecutarYtDlpDescarga(url, cookieFile = null) {
    const salida = path.join(os.tmpdir(), 'tiktok-' + crypto.randomBytes(8).toString('hex') + '.mp4');
    try {
        const opciones = {
            output: salida,
            format: 'best[ext=mp4]/best',
            noWarnings: true,
            noPlaylist: true,
            noCheckCertificates: true,
            jsRuntimes: 'node',
            remoteComponents: 'ejs:github',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            referer: 'https://www.tiktok.com/',
            socketTimeout: 30,
            retries: 5,
            fragmentRetries: 5,
            extractorRetries: 3,
            noPart: true,
            geoBypass: true
        };
        if (cookieFile) opciones.cookies = cookieFile;

        await youtubedl(url, opciones, { timeout: 120000 });

        if (!fs.existsSync(salida)) throw new Error('yt-dlp terminó pero no creó el archivo MP4');
        const buffer = fs.readFileSync(salida);
        if (!buffer.length || buffer.length < 10000) throw new Error('yt-dlp creó un archivo de video vacío o inválido');
        return buffer;
    } catch (e) {
        throw new Error(String(e?.message || e).replace(/\s+/g, ' ').slice(0, 700));
    } finally {
        try { if (fs.existsSync(salida)) fs.unlinkSync(salida); } catch (_) {}
    }
}

async function descargarTikTokConYtDlp(url) {
    let ultimo = null;

    // Deja que yt-dlp haga la descarga completa. Esto evita perder cookies,
    // headers, redirects y lógica específica del extractor al pasar la URL a fetch.
    try {
        return await ejecutarYtDlpDescarga(url);
    } catch (e) {
        ultimo = e;
        console.warn('⚠️ yt-dlp directo falló:', e.message);
    }

    // Se omite la extracción de cookies desde el perfil de Chrome en Render.
    // SnapTik y los extractores con navegador cubren esta vía.

    // Último intento: extracción JSON + descarga manual de la URL devuelta.
    try {
        const datos = await youtubedl(url,{
            dumpSingleJson:true,
            noWarnings:true,
            noPlaylist:true,
            noCheckCertificates:true,
            format:'best[ext=mp4]/best',
            impersonate:'chrome',
            jsRuntimes:'node',
            remoteComponents:'ejs:github',
            userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            referer:'https://www.tiktok.com/',
            socketTimeout:30,
            retries:3
        },{timeout:90000});

        const formatos=Array.isArray(datos?.formats)?datos.formats:[];
        const candidatos=[
            datos?.requested_downloads?.[0]?.url,
            datos?.url,
            ...formatos.filter(f=>f?.url&&(!f.ext||f.ext==='mp4'))
                .sort((a,b)=>Number(b.tbr||0)-Number(a.tbr||0)).map(f=>f.url)
        ].filter(x=>typeof x==='string'&&/^https?:\/\/.*/i.test(x));

        for(const u of candidatos.slice(0,3)){
            try {
                const b=await descargarVideoTikTok(u);
                if(b?.length>10000) return b;
            } catch(e){ ultimo=e; }
        }
    } catch(e) {
        ultimo = e;
    }

    throw new Error('yt-dlp no pudo descargar el TikTok' + (ultimo?.message ? ': ' + ultimo.message : ''));
}

function extraerVideoTikWM(data) {
    const datos = data?.data;

    // TikWM ha usado distintos nombres según la respuesta/versión.
    const videoUrl =
        datos?.hdplay ||
        datos?.play ||
        datos?.wmplay ||
        datos?.video?.hdplay ||
        datos?.video?.play ||
        data?.hdplay ||
        data?.play;

    if (data?.code !== undefined && Number(data.code) !== 0) {
        throw new Error(data?.msg || data?.message || 'TikWM rechazó el enlace');
    }

    if (!videoUrl) {
        throw new Error(data?.msg || data?.message || 'TikWM no devolvió una URL de video');
    }

    return {
        videoUrl,
        titulo: datos?.title || data?.title || 'TikTok'
    };
}

async function obtenerTikTokTikWM(url, metodo = 'POST') {
    const opciones = {
        method: metodo,
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': 'https://www.tikwm.com/'
        },
        signal: AbortSignal.timeout(30000)
    };

    if (metodo === 'POST') {
        opciones.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        opciones.headers['Cookie'] = 'current_language=en';
        opciones.body = new URLSearchParams({
            url,
            hd: '1',
            web: '1',
            count: '12',
            cursor: '0'
        });
    } else {
        opciones.headers['Cookie'] = 'current_language=en';
        opciones.body = undefined;
    }

    const endpoint = metodo === 'GET'
        ? 'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1'
        : 'https://www.tikwm.com/api/';

    const respuesta = await fetch(endpoint, opciones);

    if (!respuesta.ok) {
        throw new Error('TikWM ' + metodo + ' respondió HTTP ' + respuesta.status);
    }

    const texto = await respuesta.text();
    let data;

    try {
        data = JSON.parse(texto);
    } catch {
        throw new Error('TikWM ' + metodo + ' devolvió una respuesta no válida');
    }

    return extraerVideoTikWM(data);
}

async function obtenerTikTokTDown(url) {
    const endpoint = 'https://tdownv4.sl-bjs.workers.dev/?down=' + encodeURIComponent(url);
    const respuesta = await fetch(endpoint, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(30000)
    });

    if (!respuesta.ok) {
        throw new Error('TDown respondió HTTP ' + respuesta.status);
    }

    const texto = await respuesta.text();
    let data;

    try {
        data = JSON.parse(texto);
    } catch {
        throw new Error('TDown devolvió una respuesta no válida');
    }

    const videoUrl =
        data?.download_url ||
        data?.downloadUrl ||
        data?.url ||
        data?.video_url ||
        data?.videoUrl ||
        data?.data?.download_url ||
        data?.data?.downloadUrl ||
        data?.data?.url;

    if (!videoUrl) {
        throw new Error(data?.message || data?.msg || 'TDown no devolvió un video descargable');
    }

    return {
        videoUrl,
        titulo: data?.title || data?.data?.title || 'TikTok'
    };
}

async function descargarVideoTikTok(videoUrl, cookie = '') {
    const respuesta = await fetch(videoUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
            'Referer': 'https://www.tiktok.com/',
            ...(cookie ? { 'Cookie': cookie } : {})
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(90000)
    });

    if (!respuesta.ok) {
        throw new Error('No se pudo descargar el MP4: HTTP ' + respuesta.status);
    }

    const videoBuffer = Buffer.from(await respuesta.arrayBuffer());
    if (!videoBuffer.length) {
        throw new Error('El servidor devolvió un video vacío');
    }

    return videoBuffer;
}

async function descargarTikTokConSnapTik(url) {
    let browser;
    try {
        browser = await puppeteer.launch(opcionesPuppeteer());
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' });
        await page.goto('https://snaptik.fi/es', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 1200));
        const input = await page.$('input[type="url"], input[name="url"], input[placeholder*="URL" i], input');
        if (!input) throw new Error('SnapTik no mostró el campo de enlace');
        await input.click({ clickCount: 3 });
        await input.type(url, { delay: 3 });
        const botones = await page.$('button, input[type="submit"], input[type="button"], a');
        let downloadButton = null;
        for (const button of botones) {
            const text = await button.evaluate(el => (el.innerText || el.textContent || el.value || '').trim());
            if (/descargar|download/i.test(text)) { downloadButton = button; break; }
        }
        if (!downloadButton) {
            console.warn('⚠️ SnapTik: no encontré botón Descargar. Intentando Enter en el campo.');
            await input.press('Enter').catch(() => {});
        } else {
            await downloadButton.click().catch(async () => {
                await input.press('Enter').catch(() => {});
            });
        }
        let mediaResponse = null;
        page.on('response', response => {
            try {
                const type = String(response.headers()['content-type'] || '').toLowerCase();
                const u = response.url();
                if (response.ok() && (type.includes('video/') || /\.mp4(?:$|[?#])/i.test(u))) mediaResponse = response;
            } catch (_) {}
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll('a[href]')).some(a => /\.mp4|download|tiktokcdn/i.test(a.href)), { timeout: 45000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3500));
        if (mediaResponse) {
            const buffer = await mediaResponse.buffer().catch(() => null);
            if (buffer?.length > 10000) return buffer;
        }
        const links = await page.$eval('a[href]', as => as.map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').trim() })).filter(x => /^https?:/i.test(x.href)));
        console.log('🎵 SnapTik: enlaces encontrados:', links.length);
        links.sort((a,b) => {
            const score = x => (/\.mp4/i.test(x.href) ? 100 : 0) + (/hd|1080|720/i.test(x.text + x.href) ? 30 : 0) + (/download/i.test(x.href) ? 10 : 0);
            return score(b) - score(a);
        });
        for (const link of links.slice(0, 10)) {
            try {
                const result = await page.evaluate(async href => {
                    const r = await fetch(href, { credentials: 'include', redirect: 'follow' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    const type = String(r.headers.get('content-type') || '').toLowerCase();
                    if (type.includes('text/html')) throw new Error('HTML');
                    const data = new Uint8Array(await r.arrayBuffer());
                    let binary = '';
                    for (let i=0; i<data.length; i+=0x8000) binary += String.fromCharCode(...data.subarray(i,i+0x8000));
                    return btoa(binary);
                }, link.href);
                const buffer = Buffer.from(result, 'base64');
                if (buffer.length > 10000) return buffer;
            } catch (_) {}
        }
        throw new Error('SnapTik no devolvió un MP4 descargable');
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}


function extraerUrlInstagram(texto) {
    const fuente = String(texto || '').trim();
    if (!fuente) return null;

    const patron = /https?:\/\/(?:www\.)?instagram\.com\/[^\s<>\]\)]+/gi;
    const urls = fuente.match(patron) || [];

    for (let url of urls) {
        url = url.replace(/[),.;!?]+$/g, '');
        try {
            const u = new URL(url);
            if (/(^|\.)instagram\.com$/i.test(u.hostname)) return u.toString();
        } catch (_) {}
    }

    const sinEsquema = fuente.match(/(?:www\.)?instagram\.com\/[^\s<>\]\)]+/i);
    if (sinEsquema?.[0]) {
        try {
            return new URL('https://' + sinEsquema[0].replace(/[),.;!?]+$/g, '')).toString();
        } catch (_) {}
    }

    return null;
}

async function resolverEnlaceInstagram(url) {
    try {
        const u = new URL(url);
        if (/(?:\/reel\/|\/reels\/|\/p\/|\/tv\/)/i.test(u.pathname)) return url;
    } catch (_) {
        return url;
    }

    try {
        const respuesta = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
            },
            signal: AbortSignal.timeout(20000)
        });
        if (respuesta.url) {
            const final = new URL(respuesta.url);
            if (/(^|\.)instagram\.com$/i.test(final.hostname)) return final.toString();
        }
    } catch (error) {
        console.warn('⚠️ No se pudo resolver Instagram:', error.message);
    }

    return url;
}

async function descargarInstagramConYtDlp(url) {
    const prefijo = 'instagram-' + crypto.randomBytes(8).toString('hex');
    const salida = path.join(os.tmpdir(), prefijo + '.%(ext)s');

    try {
        const opciones = {
            output: salida,
            format: 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
            mergeOutputFormat: 'mp4',
            noWarnings: true,
            noPlaylist: true,
            noCheckCertificates: true,
            jsRuntimes: 'node',
            remoteComponents: 'ejs:github',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            referer: 'https://www.instagram.com/',
            socketTimeout: 30,
            retries: 4,
            fragmentRetries: 4,
            extractorRetries: 3,
            noPart: true,
            geoBypass: true
        };

        await youtubedl(url, opciones, { timeout: 120000 });

        const archivos = fs.readdirSync(os.tmpdir())
            .filter(nombre => nombre.startsWith(prefijo))
            .map(nombre => path.join(os.tmpdir(), nombre))
            .filter(ruta => fs.existsSync(ruta));

        const mp4 = archivos.find(ruta => /\.mp4$/i.test(ruta));
        if (!mp4) throw new Error('yt-dlp no creó el MP4 de Instagram');

        const buffer = fs.readFileSync(mp4);
        if (!buffer.length || buffer.length < 10000) {
            throw new Error('Instagram devolvió un video vacío o inválido');
        }
        return buffer;
    } catch (e) {
        throw new Error(String(e?.message || e).replace(/\s+/g, ' ').slice(0, 700));
    } finally {
        try {
            for (const nombre of fs.readdirSync(os.tmpdir())) {
                if (nombre.startsWith(prefijo)) {
                    try { fs.unlinkSync(path.join(os.tmpdir(), nombre)); } catch (_) {}
                }
            }
        } catch (_) {}
    }
}

async function descargarInstagramConNavegador(url) {
    let browser;
    try {
        browser = await puppeteer.launch(opcionesPuppeteer());
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1365, height: 900 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
            'Upgrade-Insecure-Requests': '1'
        });

        let videoResponse = null;

        page.on('response', response => {
            try {
                if (videoResponse || !response.ok()) return;

                const headers = response.headers();
                const type = String(headers['content-type'] || '').toLowerCase();
                const responseUrl = response.url();

                if (
                    type.includes('video/mp4') ||
                    type.includes('video/quicktime') ||
                    /(?:cdninstagram|fbcdn).*\.(?:mp4|m4v|mov)/i.test(responseUrl) ||
                    /\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(responseUrl)
                ) {
                    videoResponse = response;
                }
            } catch (_) {}
        });

        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
        }).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 7000));

        if (videoResponse) {
            try {
                const buffer = await videoResponse.buffer();
                if (buffer?.length > 10000) return buffer;
            } catch (_) {}
        }

        const datos = await page.evaluate(() => {
            const candidatos = [];
            const agregar = valor => {
                if (typeof valor !== 'string') return;

                let u = valor
                    .replace(/\\u0026/g, '&')
                    .replace(/\\u003D/g, '=')
                    .replace(/\\u002F/gi, '/')
                    .replace(/\\\//g, '/')
                    .replace(/&amp;/g, '&')
                    .trim();

                // Algunas respuestas vienen entre comillas o con caracteres escapados.
                u = u.replace(/^["']|["']$/g, '');

                if (/^https?:\/\//i.test(u)) candidatos.push(u);
            };

            document.querySelectorAll('meta[property="og:video"], meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]')
                .forEach(el => agregar(el.getAttribute('content')));

            document.querySelectorAll('video[src], video source[src]')
                .forEach(el => agregar(el.getAttribute('src')));

            const scripts = Array.from(document.scripts || []).map(s => s.textContent || '').join('\n');
            const html = document.documentElement?.outerHTML || '';

            // Busca URLs de CDN aunque Instagram haya cambiado la estructura JSON.
            const todo = html + '\n' + scripts;
            const urls = todo.match(/https?:\\?\\?\/?\\?\\?[^"'<>\\s]+/g) || [];

            for (const raw of urls) {
                const limpia = raw
                    .replace(/\\\//g, '/')
                    .replace(/\\u0026/g, '&')
                    .replace(/\\u003D/g, '=')
                    .replace(/&amp;/g, '&');

                if (/cdninstagram|fbcdn/i.test(limpia) && /(?:mp4|m4v|mov|video)/i.test(limpia)) {
                    agregar(limpia);
                }
            }

            const patrones = [
                /"video_url"\s*:\s*"([^"]+)/ig,
                /"playback_url"\s*:\s*"([^"]+)/ig,
                /"url"\s*:\s*"(https?:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]*)"/ig,
                /"src"\s*:\s*"(https?:\/\/[^"]*(?:cdninstagram|fbcdn)[^"]*)"/ig
            ];

            for (const patron of patrones) {
                let match;
                while ((match = patron.exec(todo)) !== null) {
                    agregar(match[1]);
                }
            }

            const ordenados = [...new Set(candidatos)];

            return {
                titulo: document.title || '',
                urlActual: location.href,
                cantidad: ordenados.length,
                candidatos: ordenados.slice(0, 20)
            };
        });

        console.log('📸 INSTAGRAM Chromium:', JSON.stringify(datos));

        const videoUrl = datos.candidatos.find(u =>
            /(?:cdninstagram|fbcdn)/i.test(u) &&
            /(?:mp4|m4v|mov|video)/i.test(u)
        ) || datos.candidatos.find(u => /\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(u));

        if (!videoUrl) {
            throw new Error(
                'Instagram no expuso video en Chromium. Título: ' +
                String(datos.titulo || 'sin título').slice(0, 180) +
                ' | URL actual: ' +
                String(datos.urlActual || '').slice(0, 250) +
                ' | URLs candidatas: ' +
                datos.cantidad
            );
        }

        console.log('📸 INSTAGRAM: URL de video encontrada por navegador:', videoUrl.slice(0, 300));

        // Intento 1: obtener la respuesta dentro del mismo contexto.
        let recurso = null;
        const handler = response => {
            try {
                if (recurso || !response.ok()) return;
                if (response.url() === videoUrl) recurso = response;
            } catch (_) {}
        };
        page.on('response', handler);

        await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        }).catch(() => {});

        if (recurso) {
            const buffer = await recurso.buffer().catch(() => null);
            if (buffer?.length > 10000) return buffer;
        }

        // Intento 2: fetch con las cookies/sesión del navegador.
        try {
            const base64 = await page.evaluate(async recursoUrl => {
                const respuesta = await fetch(recursoUrl, {
                    credentials: 'include',
                    redirect: 'follow'
                });

                if (!respuesta.ok) throw new Error('HTTP ' + respuesta.status);

                const bytes = new Uint8Array(await respuesta.arrayBuffer());
                let binario = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return btoa(binario);
            }, videoUrl);

            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length > 10000) return buffer;
        } catch (error) {
            console.warn('⚠️ Instagram Chromium fetch falló:', error.message);
        }

        throw new Error('Chromium encontró una URL de video pero no pudo descargar el MP4');
    } catch (e) {
        throw new Error(String(e?.message || e).replace(/\\s+/g, ' ').slice(0, 900));
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}


async function comandoInstagram(sock, chatId, msg, args) {
    const textoArgumentos = Array.isArray(args) ? args.join(' ') : String(args || '');
    const urlOriginal = extraerUrlInstagram(textoArgumentos);

    if (urlOriginal && /\/(?:p|tv)\//i.test(new URL(urlOriginal).pathname)) {
        return comandoDescargaSocial(sock, chatId, msg, [urlOriginal], 'Instagram');
    }

    const diagnosticos = [];
    const registrarDiagnostico = (etapa, error) => {
        const detalle = String(error?.message || error || 'Sin detalle').replace(/\s+/g, ' ').trim().slice(0, 700);
        diagnosticos.push(etapa + ': ' + detalle);
        console.warn('📸 INSTAGRAM DIAGNÓSTICO FINAL:', etapa, detalle);
    };

    console.log('📸 INSTAGRAM: comando recibido. Texto:', textoArgumentos);
    console.log('📸 INSTAGRAM: URL extraída:', urlOriginal || 'NO ENCONTRADA');

    if (!urlOriginal) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Proporciona un enlace válido de Instagram. Ejemplo: *instagram https://www.instagram.com/reel/...*'
        }, { quoted: msg });
        return;
    }

    try {
        const url = await resolverEnlaceInstagram(urlOriginal);
        console.log('📸 INSTAGRAM: URL a procesar:', url);

        let videoBuffer = null;
        let ultimoError = null;

        try {
            videoBuffer = await descargarInstagramConYtDlp(url);
        } catch (error) {
            ultimoError = error;
            registrarDiagnostico('yt-dlp', error);
        }

        if (!videoBuffer && url !== urlOriginal) {
            try {
                videoBuffer = await descargarInstagramConYtDlp(urlOriginal);
            } catch (error) {
                ultimoError = error;
                registrarDiagnostico('yt-dlp enlace original', error);
            }
        }

        if (!videoBuffer?.length) {
            try {
                videoBuffer = await descargarInstagramConNavegador(url);
            } catch (error) {
                ultimoError = error;
                registrarDiagnostico('Chromium', error);
            }
        }

        if (!videoBuffer?.length && url !== urlOriginal) {
            try {
                videoBuffer = await descargarInstagramConNavegador(urlOriginal);
            } catch (error) {
                ultimoError = error;
                registrarDiagnostico('Chromium enlace original', error);
            }
        }

        if (!videoBuffer?.length) {
            const resumen = diagnosticos.length
                ? diagnosticos.join('\n')
                : 'No se obtuvo un diagnóstico detallado.';
            throw new Error(resumen || ultimoError?.message || 'Instagram no devolvió un video descargable');
        }

        await sock.sendMessage(chatId, {
            video: videoBuffer,
            mimetype: 'video/mp4'
        }, { quoted: msg });

        console.log('✅ INSTAGRAM: video enviado correctamente.');
    } catch (e) {
        console.error('Error al descargar Instagram:', e?.stack || e);
        await sock.sendMessage(chatId, {
            text: '❌ *DIAGNÓSTICO INSTAGRAM*\n\n' +
                String(e?.message || e).slice(0, 1800)
        }, { quoted: msg });
    }
}

async function comandoTiktok(sock, chatId, msg, args) {
    const textoArgumentos = Array.isArray(args) ? args.join(' ') : String(args || '');
    const urlOriginal = extraerUrlTikTok(textoArgumentos);
    if (urlOriginal && /\/photo\//i.test(new URL(urlOriginal).pathname)) {
        return comandoDescargaSocial(sock, chatId, msg, [urlOriginal], 'TikTok');
    }
    console.log('🎵 TIKTOK: comando recibido. Texto:', textoArgumentos);
    console.log('🎵 TIKTOK: URL extraída:', urlOriginal || 'NO ENCONTRADA');

    if (!urlOriginal) {
        await sock.sendMessage(chatId, {
            text: '⚠️ Proporciona un enlace válido de TikTok. Ejemplo: `tiktok [link]`'
        }, { quoted: msg });
        return;
    }

    try {

        let url = urlOriginal;
        let datos;
        const errores = [];
        let videoBuffer = null;

        // Resolvemos enlaces vt/vm/t para entregar a cada proveedor el URL
        // canónico siempre que TikTok permita obtenerlo.
        url = await resolverEnlaceTikTok(url);
        console.log('🎵 TIKTOK: URL a procesar:', url);

        // SnapTik es el método principal: acepta los enlaces copiados desde
        // Compartir y ofrece descarga HD 1080p/720p sin marca de agua.
        try {
            console.log('🎵 TIKTOK: intentando SnapTik...');
            videoBuffer = await descargarTikTokConSnapTik(url);
            if (!videoBuffer?.length && url !== urlOriginal) {
                videoBuffer = await descargarTikTokConSnapTik(urlOriginal);
            }
            console.log('🎵 TIKTOK: SnapTik respondió con', videoBuffer?.length || 0, 'bytes');
        } catch (errorSnapTik) {
            console.warn('⚠️ SnapTik falló:', errorSnapTik.message);
            errores.push('SnapTik: ' + errorSnapTik.message);
        }

        // Si SnapTik no pudo, pasamos al extractor directo de TikTok.
        if (!videoBuffer) {
            try {
                datos = await obtenerTikTokDirecto(url);
            } catch (errorDirecto) {
                errores.push('TikTok directo: ' + errorDirecto.message);
            }
        }

        if (!datos && !videoBuffer) {
            try {
                datos = await obtenerTikTokConNavegador(url);
            } catch (errorNavegador) {
                errores.push('TikTok navegador: ' + errorNavegador.message);
            }
        }

        // Respaldo independiente: yt-dlp usa su propio extractor de TikTok.
        if (!datos) {
            try {
                const videoYtDlp = await descargarTikTokConYtDlp(url);
                videoBuffer = videoYtDlp;
            } catch (errorYtDlp) {
                errores.push(errorYtDlp.message);
            }
        }

        // Si TikTok no entregó el MP4 directamente, usamos los proveedores externos.
        if (!datos && !videoBuffer) {
                    for (const metodo of ['POST', 'GET']) {
                        try {
                            datos = await obtenerTikTokTikWM(url, metodo);
                            if (datos?.videoUrl) break;
                        } catch (errorTikWM) {
                            errores.push('TikWM ' + metodo + ': ' + errorTikWM.message);
                        }
                    }
            
                    // Si era un enlace corto y la resolución falló, damos una segunda
                    // oportunidad al enlace original después de unos segundos.
                    if (!datos && url !== urlOriginal) {
                        await new Promise(resolve => setTimeout(resolve, 4000));
            
                        for (const metodo of ['POST', 'GET']) {
                            try {
                                datos = await obtenerTikTokTikWM(urlOriginal, metodo);
                                if (datos?.videoUrl) break;
                            } catch (errorTikWM) {
                                errores.push('TikWM corto ' + metodo + ': ' + errorTikWM.message);
                            }
                        }
                    }
            
                    // Segundo servicio independiente.
                    if (!datos) {
                        try {
                            datos = await obtenerTikTokTDown(url);
                        } catch (errorTDown) {
                            errores.push('TDown: ' + errorTDown.message);
                        }
                    }
            
            
        }

        if (!datos?.videoUrl && !videoBuffer) {
            throw new Error(errores.join(' | ') || 'Ningún servicio devolvió el video');
        }

        if (!videoBuffer) try {
            videoBuffer = await descargarVideoTikTok(datos.videoUrl, datos.cookie || '');
        } catch (errorDescarga) {
            errores.push('CDN directo: ' + errorDescarga.message);
            try {
                videoBuffer = await descargarVideoTikTokConNavegador(datos.videoUrl, datos.cookie || '');
            } catch (errorNavegador) {
                errores.push('CDN navegador: ' + errorNavegador.message);
            }

            // Si el parser encontró una URL pero el CDN la rechaza, no nos
            // quedamos atrapados con esa URL: volvemos a un extractor distinto.
            if (!videoBuffer) {
                try {
                    videoBuffer = await descargarTikTokConYtDlp(url);
                } catch (errorYtDlp) {
                    errores.push(errorYtDlp.message);
                }
            }
        }
        if (!videoBuffer?.length) throw new Error(errores.join(' | ') || 'No se pudo descargar el video');

        await sock.sendMessage(chatId, {
            video: videoBuffer,
            mimetype: 'video/mp4'
        }, { quoted: msg });

    } catch (e) {
        console.error('Error al descargar TikTok:', e?.stack || e);
        await sock.sendMessage(chatId, {
            text: '❌ No pude descargar ese TikTok. Intenta nuevamente con el enlace de *Compartir → Copiar enlace*.'
        }, { quoted: msg });
    }
}


// Descargador común para publicaciones con fotos, carruseles o videos.
function extraerUrlSocial(texto) {
    const fuente = String(texto || '').trim();
    const encontrados = fuente.match(/(?:https?:\/\/)?(?:www\.|m\.|mobile\.)?(?:x\.com|twitter\.com|t\.co|instagram\.com|tiktok\.com|pinterest\.[a-z.]+|pin\.it|facebook\.com|fb\.watch|reddit\.com|redd\.it|threads\.net)\/[^\s<>\]\)]+/gi) || [];
    for (let valor of encontrados) {
        valor = valor.replace(/[),.;!?]+$/g, '');
        if (!/^https?:\/\//i.test(valor)) valor = 'https://' + valor;
        try {
            const u = new URL(valor);
            if (/(^|\.)(x\.com|twitter\.com|t\.co|instagram\.com|tiktok\.com|pinterest\.[a-z.]+|pin\.it|facebook\.com|fb\.watch|reddit\.com|redd\.it|threads\.net)$/i.test(u.hostname)) return u.toString();
        } catch (_) {}
    }
    return null;
}

async function comandoDescargaSocial(sock, chatId, msg, args, plataforma = 'red social') {
    const texto = Array.isArray(args) ? args.join(' ') : String(args || '');
    const url = extraerUrlSocial(texto);
    if (!url) {
        await sock.sendMessage(chatId, { text: '⚠️ Envíame un enlace público válido de la publicación.' }, { quoted: msg });
        return;
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'social-media-'));
    try {
        const salida = path.join(tempDir, '%(autonumber)02d.%(ext)s');
        await youtubedl(url, {
            output: salida,
            format: 'bestvideo*+bestaudio/best',
            mergeOutputFormat: 'mp4',
            noWarnings: true,
            noPlaylist: false,
            maxDownloads: 10,
            maxFilesize: '64M',
            socketTimeout: 30,
            retries: 3,
            fragmentRetries: 3,
            extractorRetries: 2,
            noPart: true,
            restrictFilenames: true,
            jsRuntimes: 'node',
            remoteComponents: 'ejs:github',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
            ...(new URL(url).hostname.match(/(^|\.)x\.com$|(^|\.)twitter\.com$/i) ? { referer: 'https://x.com/' } : {})
        }, { timeout: 150000 });

        const extensiones = /\.(?:jpe?g|png|webp|gif|mp4|m4v|mov|webm|mkv)$/i;
        const archivos = (await fs.promises.readdir(tempDir))
            .filter(nombre => extensiones.test(nombre))
            .map(nombre => path.join(tempDir, nombre))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (!archivos.length) throw new Error('La plataforma no entregó fotos o videos descargables. La publicación puede ser privada o estar restringida.');
        let enviados = 0;
        for (const archivo of archivos.slice(0, 10)) {
            const stat = await fs.promises.stat(archivo);
            if (!stat.size || stat.size > 64 * 1024 * 1024) continue;
            const buffer = await fs.promises.readFile(archivo);
            const ext = path.extname(archivo).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                await sock.sendMessage(chatId, { image: buffer }, { quoted: msg });
            } else if (ext === '.gif') {
                await sock.sendMessage(chatId, { video: buffer, gifPlayback: true, mimetype: 'video/mp4' }, { quoted: msg });
            } else {
                await sock.sendMessage(chatId, { video: buffer, mimetype: ext === '.webm' ? 'video/webm' : 'video/mp4' }, { quoted: msg });
            }
            enviados++;
        }
        if (!enviados) throw new Error('Los archivos superan el límite de 64 MB o tienen un formato no compatible con WhatsApp.');
    } catch (error) {
        console.error('Error descargando ' + plataforma + ':', error?.stack || error);
        await sock.sendMessage(chatId, { text: '❌ No pude descargar esa publicación de ' + plataforma + '. Verifica que sea pública.\n\nDetalle: ' + String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500) }, { quoted: msg });
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function comandoX(sock, chatId, msg, args) {
    return comandoDescargaSocial(sock, chatId, msg, args, 'X');
}

// 📌 Pinterest (video en la mejor calidad disponible)
function extraerUrlPinterest(texto) {
    const fuente = String(texto || '').trim();
    const coincidencias = fuente.match(/https?:\/\/[^\s<>\]\)]+|(?:www\.)?(?:pinterest\.[a-z.]+|pin\.it)\/[^\s<>\]\)]+/gi) || [];
    for (let valor of coincidencias) {
        valor = valor.replace(/[),.;!?]+$/g, '');
        if (!/^https?:\/\//i.test(valor)) valor = 'https://' + valor;
        try {
            const url = new URL(valor);
            if (/(^|\.)pinterest\.(?:com(?:\.(?:mx|au|co\.uk|co\.in))?|mx|es|co\.uk|ca|fr|de|it|jp|au|nz|pt|in|co)$/i.test(url.hostname) || /^pin\.it$/i.test(url.hostname)) {
                return url.toString();
            }
        } catch (_) {}
    }
    return null;
}

async function comandoPinterest(sock, chatId, msg, args) {
    const textoArgumentos = Array.isArray(args) ? args.join(' ') : String(args || '');
    const url = extraerUrlPinterest(textoArgumentos);
    if (!url) {
        await sock.sendMessage(chatId, { text: '⚠️ Envíame un enlace público de Pinterest. Ejemplo: pinterest.com/pin/...' }, { quoted: msg });
        return;
    return comandoDescargaSocial(sock, chatId, msg, [url], 'Pinterest');
    }

    let tempDir;
    try {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pinterest-download-'));
        const salida = path.join(tempDir, 'pinterest.%(ext)s');
        await youtubedl(url, {
            output: salida,
            format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best',
            mergeOutputFormat: 'mp4',
            noWarnings: true,
            noPlaylist: true,
            socketTimeout: 30,
            retries: 3,
            fragmentRetries: 3,
            extractorRetries: 2,
            noPart: true,
            maxFilesize: '64M',
            restrictFilenames: true,
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            referer: 'https://www.pinterest.com/'
        }, { timeout: 120000 });

        const archivos = await fs.promises.readdir(tempDir);
        const ruta = archivos.map(nombre => path.join(tempDir, nombre))
            .find(nombre => /\.(?:mp4|m4v|mov|webm)$/i.test(nombre));
        if (!ruta) throw new Error('Pinterest no devolvió un archivo de video compatible; el pin puede ser una imagen o no ser público.');
        const stat = await fs.promises.stat(ruta);
        if (!stat.size || stat.size > 64 * 1024 * 1024) {
            throw new Error(!stat.size ? 'El archivo descargado está vacío.' : 'El video supera el límite de 64 MB de WhatsApp.');
        }
        const video = await fs.promises.readFile(ruta);
        if (video.length < 10000) throw new Error('El archivo recibido no parece un video válido.');
        await sock.sendMessage(chatId, {
            video,
            mimetype: 'video/mp4'
        }, { quoted: msg });
    } catch (error) {
        console.error('Error descargando Pinterest:', error?.stack || error);
        const detalle = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 500);
        await sock.sendMessage(chatId, {
            text: '❌ No pude descargar ese enlace de Pinterest. Comprueba que el pin sea público y contenga un video.\n\nDetalle: ' + detalle
        }, { quoted: msg });
    } finally {
        if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

// 🌐 4. Traduce (Traductor instantáneo)
async function comandoTraduce(sock, chatId, msg, args) {
    const idioma = args[0];
    const texto = args.slice(1).join(' ');
    if (!idioma || !texto) {
        await sock.sendMessage(chatId, { text: '⚠️ Uso correcto: `traduce [idioma] [texto]`\nEjemplo: `traduce en Hola mundo`' }, { quoted: msg });
        return;
    }
    try {
        const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${idioma}&dt=t&q=${encodeURIComponent(texto)}`);
        const data = await res.json();
        const traducido = data[0][0][0];
        await sock.sendMessage(chatId, { text: `🌐 *Traducción (${idioma.toUpperCase()})*:\n\n${traducido}` }, { quoted: msg });
    } catch (e) {
        await sock.sendMessage(chatId, { text: '❌ Error al traducir el texto.' }, { quoted: msg });
    }
}

module.exports = {
    comandoSticker,
    comandoRecup1Vez,
    comandoTiktok,
    comandoInstagram,
    comandoPinterest,
    comandoX,
    comandoDescargaSocial,
    comandoTraduce
};
