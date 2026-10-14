'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extraerUrl, analizarSolicitudDescarga, detectarPlataforma, tipoMimetype, tipoEnvioWhatsApp, crearCaptionDescarga, esErrorSinVideoInstagram, extraerUrlsImagenInstagram, extraerUrlsImagenGalleryDl, extraerUrlsImagenApiInstagramPublica, extraerShortcodeInstagram, crearUrlsEmbedInstagram, extraerUrlsImagenInstagramDesdeJson, descargaDirecta, createMediaSizeLimiter, MAX_MEDIA_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_VIDEO_BYTES, TIMEOUT_MS, MAX_MEDIA_FILES } = require('../descargasSociales');
const { inspectWebpAnimation, parseMediaSizeBytes, parseFfmpegDurationSeconds, resolveStickerDurationSeconds, buildVideoStickerAttempts, MAX_ANIMATED_STICKER_BYTES } = require('../stickerUtils');
const { validateSessionSnapshot } = require('../sessionUtils');

function chunk(type, payload) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  const padding = payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, payload, padding]);
}

function webp(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 4, 'ascii');
  return Buffer.concat([header, body]);
}

test('reconoce enlaces de las plataformas admitidas', () => {
  const cases = [
    ['tiktok', 'https://www.tiktok.com/@demo/video/123'],
    ['instagram', 'https://www.instagram.com/reel/ABC123/'],
    ['x', 'https://x.com/demo/status/123'],
    ['pinterest', 'https://pin.it/abc123'],
    ['facebook', 'https://www.facebook.com/watch/?v=123'],
    ['reddit', 'https://redd.it/abc123'],
    ['threads', 'https://www.threads.net/@demo/post/ABC123']
  ];
  for (const [platform, url] of cases) {
    assert.equal(extraerUrl(url, platform), new URL(url).toString(), platform);
  }
});

test('no interpreta mensajes normales de una palabra como comandos de descarga', () => {
  for (const word of ['hola', 'gracias', 'buenas', 'ok', 'listo', '12345']) {
    assert.equal(analizarSolicitudDescarga(word), null, word);
  }
  assert.deepEqual(analizarSolicitudDescarga('instagram'), {
    tipo: 'platform', plataforma: 'instagram', enlace: ''
  });
  assert.deepEqual(analizarSolicitudDescarga('descargar'), {
    tipo: 'generic', plataforma: 'auto', enlace: ''
  });
});

test('no confunde URLs desnudas con comandos de plataforma', () => {
  assert.deepEqual(analizarSolicitudDescarga('instagram.com/reel/ABC'), {
    tipo: 'url', plataforma: 'auto', enlace: 'instagram.com/reel/ABC'
  });
  assert.deepEqual(analizarSolicitudDescarga('youtube.com/watch?v=abc'), {
    tipo: 'url', plataforma: 'auto', enlace: 'youtube.com/watch?v=abc'
  });
  assert.deepEqual(analizarSolicitudDescarga('youtu.be/abc123'), {
    tipo: 'url', plataforma: 'auto', enlace: 'youtu.be/abc123'
  });
  assert.deepEqual(analizarSolicitudDescarga('instagram https://www.instagram.com/reel/ABC'), {
    tipo: 'platform', plataforma: 'instagram', enlace: 'https://www.instagram.com/reel/ABC'
  });
  assert.deepEqual(analizarSolicitudDescarga('twitter https://x.com/demo/status/1'), {
    tipo: 'platform', plataforma: 'x', enlace: 'https://x.com/demo/status/1'
  });
  assert.deepEqual(analizarSolicitudDescarga('descargar https://cdn.example.org/video.mp4'), {
    tipo: 'generic', plataforma: 'auto', enlace: 'https://cdn.example.org/video.mp4'
  });
  assert.deepEqual(analizarSolicitudDescarga('descargar'), {
    tipo: 'generic', plataforma: 'auto', enlace: ''
  });
  assert.deepEqual(analizarSolicitudDescarga('Mira este video: https://cdn.example.org/video.mp4'), {
    tipo: 'url', plataforma: 'auto', enlace: 'https://cdn.example.org/video.mp4'
  });
});

test('extrae imágenes públicas de Instagram desde el JSON del post y Open Graph', () => {
  const html =
    '<html><meta property="og:image" content="https://scontent.cdninstagram.com/thumb.jpg?stp=abc&amp;token=xyz">' +
    '<script type="application/json">' +
    '{"display_url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/real1.jpg?x=1\\u0026token=abc",' +
    '"image_versions2":{"candidates":[{"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/real2.jpg?x=2"}]},' +
    '"image_url":"https:\\/\\/evil.example\\/not-a-real-instagram-image.jpg"}' +
    '</script></html>';

  const urls = extraerUrlsImagenInstagram(html);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /real1[.]jpg/);
  assert.match(urls[1], /real2[.]jpg/);
  assert.match(urls[2], /thumb[.]jpg/);
  assert.ok(urls.every(value => new URL(value).hostname.endsWith('cdninstagram.com')));
  assert.ok(!urls.some(value => value.includes('evil.example')));
});

test('extrae el shortcode de publicaciones, reels y videos de Instagram', () => {
  assert.equal(extraerShortcodeInstagram('https://www.instagram.com/p/AbC_123/'), 'AbC_123');
  assert.equal(extraerShortcodeInstagram('https://instagram.com/reel/DeF456/?igsh=abc'), 'DeF456');
  assert.equal(extraerShortcodeInstagram('https://www.instagram.com/tv/GhI789/'), 'GhI789');
  assert.equal(extraerShortcodeInstagram('https://example.com/p/AbC_123/'), null);
  assert.equal(extraerShortcodeInstagram('https://www.instagram.com/username/'), null);
});

test('construye URLs de inserción pública para posts, reels y enlaces sin autenticación', () => {
  assert.deepEqual(
    crearUrlsEmbedInstagram('https://www.instagram.com/p/AbC_123/'),
    [
      'https://www.instagram.com/p/AbC_123/embed/captioned/',
      'https://www.instagram.com/reel/AbC_123/embed/captioned/'
    ]
  );
  assert.deepEqual(
    crearUrlsEmbedInstagram('https://www.instagram.com/reels/DeF456/?igsh=abc'),
    [
      'https://www.instagram.com/reel/DeF456/embed/captioned/',
      'https://www.instagram.com/p/DeF456/embed/captioned/'
    ]
  );
  assert.deepEqual(crearUrlsEmbedInstagram('https://example.com/p/AbC_123/'), []);
  assert.deepEqual(crearUrlsEmbedInstagram('https://www.instagram.com/username/'), []);
});

test('extrae solo fotos originales del JSON GraphQL público y omite miniaturas de video', () => {
  const payload = {
    data: {
      xdt_api__v1__media__shortcode__web_info: {
        items: [{
          media_type: 8,
          carousel_media: [
            {
              media_type: 1,
              image_versions2: { candidates: [
                { url: 'https://scontent.cdninstagram.com/v/photo-small.jpg?token=a', width: 300, height: 300 },
                { url: 'https://scontent.cdninstagram.com/v/photo-large.jpg?token=b', width: 1080, height: 1350 }
              ]}
            },
            {
              media_type: 2,
              image_versions2: { candidates: [
                { url: 'https://scontent.cdninstagram.com/v/video-thumbnail.jpg?token=c', width: 1080, height: 1920 }
              ]}
            },
            {
              media_type: 1,
              image_versions2: { candidates: [
                { url: 'https://scontent-lax3-2.xx.fbcdn.net/v/photo2.webp?token=d', width: 1080, height: 1080 }
              ]}
            }
          ]
        }]
      }
    }
  };
  const urls = extraerUrlsImagenInstagramDesdeJson(payload);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /photo-large[.]jpg/);
  assert.match(urls[1], /photo2[.]webp/);
  assert.ok(!urls.some(url => /video-thumbnail/.test(url)));
});

test('filtra las imágenes devueltas por el extractor externo de Instagram y descarta hosts falsos', () => {
  const payload = [
    {
      status: true,
      url: 'https://scontent.cdninstagram.com/v/external-photo.jpg?token=abc',
      thumbnail: 'https://scontent.cdninstagram.com/v/thumbnail.jpg?token=abc'
    },
    {
      status: true,
      url: 'https://scontent-lax3-2.xx.fbcdn.net/v/external-photo2.webp?token=xyz'
    },
    {
      status: true,
      url: 'https://evil.example/exfiltrate.jpg'
    },
    {
      status: true,
      url: 'https://scontent.cdninstagram.com/v/external-video.mp4?token=abc'
    }
  ];
  const urls = extraerUrlsImagenApiInstagramPublica(payload);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /external-photo[.]jpg/);
  assert.match(urls[1], /external-photo2[.]webp/);
  assert.ok(!urls.some(url => /evil[.]example|thumbnail|external-video/.test(url)));
});

test('filtra URLs de imágenes desde la salida de gallery-dl', () => {
  const output = [
    'https://scontent.cdninstagram.com/v/real1.jpg?token=abc',
    'https://scontent-lax3-2.xx.fbcdn.net/v/real2.webp?token=xyz',
    'warning: Instagram requested login',
    'https://evil.example/not-instagram.jpg'
  ].join('\n');

  const urls = extraerUrlsImagenGalleryDl(output);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /real1[.]jpg/);
  assert.match(urls[1], /real2[.]webp/);
  assert.ok(urls.every(value => {
    const host = new URL(value).hostname;
    return host.endsWith('cdninstagram.com') || host.endsWith('fbcdn.net');
  }));
});

test('maneja publicaciones de Instagram sin video y genera captions sin referencia temporal inválida', () => {
  assert.equal(esErrorSinVideoInstagram(new Error('[Instagram] Dec8zlJo30Z: There is no video in this post')), true);
  assert.equal(esErrorSinVideoInstagram(new Error('No video formats found!')), true);
  assert.equal(esErrorSinVideoInstagram(new Error('HTTP 403 login required')), false);

  assert.equal(
    crearCaptionDescarga({ tipo: 'video' }, 'document', 0, 1),
    '✅ Video descargado; se envía como documento para evitar límites de multimedia.'
  );
  assert.equal(
    crearCaptionDescarga({ tipo: 'image' }, 'document', 0, 1),
    '✅ Imagen descargada; se envía como documento para conservar el archivo original.'
  );
  assert.equal(
    crearCaptionDescarga({ tipo: 'video' }, 'video', 1, 3),
    '✅ Archivo 2 de 3 descargado.'
  );
});

test('asigna MIME de vídeo a los formatos soportados y documento a MPEG-TS', () => {
  assert.equal(tipoMimetype('.mp4', 'video/mp4'), 'video');
  assert.equal(tipoMimetype('.mkv', 'video/x-matroska'), 'video');
  assert.equal(tipoMimetype('.avi', 'video/x-msvideo'), 'video');
  assert.equal(tipoMimetype('.flv', 'video/x-flv'), 'video');
  assert.equal(tipoMimetype('.mpeg', 'video/mpeg'), 'video');
  assert.equal(tipoMimetype('.ts', 'video/mp2t'), 'document');
});

test('envía los medios que rebasan límites comunes como documento y no los comprime como stickers', () => {
  assert.equal(MAX_INLINE_IMAGE_BYTES, 16_000_000);
  assert.equal(MAX_INLINE_VIDEO_BYTES, 64_000_000);
  assert.equal(tipoEnvioWhatsApp({ tipo: 'image', size: 1_000_000 }), 'image');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'image', size: MAX_INLINE_IMAGE_BYTES + 1 }), 'document');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'video', size: 64_000_000 }), 'video');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'video', size: MAX_INLINE_VIDEO_BYTES + 1 }), 'document');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'other', size: 1 }), 'document');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'image', size: 1_000_000, nombre: 'photo.avif' }), 'document');
  assert.equal(tipoEnvioWhatsApp({ tipo: 'image', size: 1_000_000, nombre: 'photo.gif' }), 'document');
});

test('acepta enlaces públicos genéricos y dominios sin protocolo', () => {
  assert.equal(
    extraerUrl('https://cdn.example.org/files/video.mov?token=abc', 'auto'),
    'https://cdn.example.org/files/video.mov?token=abc'
  );
  assert.equal(
    extraerUrl('images.example.org/picture.webp', 'auto'),
    'https://images.example.org/picture.webp'
  );
  assert.equal(
    extraerUrl('https://youtu.be/abc123', 'youtube'),
    'https://youtu.be/abc123'
  );
});

test('rechaza esquemas y hosts locales no admitidos', () => {
  assert.equal(extraerUrl('ftp://cdn.example.org/video.mp4', 'auto'), null);
  assert.equal(extraerUrl('http://localhost/secret.mp4', 'auto'), null);
  assert.equal(extraerUrl('http://127.0.0.1/private.mp4', 'auto'), null);
  assert.equal(extraerUrl('http://[::1]/private.mp4', 'auto'), null);
});

test('acepta enlaces de YouTube y detecta la plataforma correcta', () => {
  assert.equal(
    extraerUrl('https://youtu.be/abc123', 'youtube'),
    'https://youtu.be/abc123'
  );
  assert.equal(detectarPlataforma('https://www.youtube.com/watch?v=abc123'), 'youtube');
  assert.equal(detectarPlataforma('https://cdn.example.org/video.mp4'), null);
});

test('mantiene el límite de 100 MB y el timeout ampliado para videos largos', () => {
  assert.equal(MAX_MEDIA_BYTES, 100_000_000);
  assert.equal(TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(MAX_MEDIA_FILES, 10);
});

test('descarga un enlace directo en streaming sin cargar toda la respuesta en un buffer de aplicación', async t => {
  const dns = require('node:dns/promises');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const payload = Buffer.from('example tiny video payload');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-direct-download-test-'));

  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(payload, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(payload.length) }
  }));

  try {
    const result = await descargaDirecta('https://cdn.example.org/video.mp4', tempDir, 1);
    assert.equal(result.tipo, 'video');
    assert.equal(result.mimetype, 'video/mp4');
    assert.equal(result.size, payload.length);
    assert.deepEqual(await fs.readFile(result.path), payload);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('la limitación por streaming rechaza bytes por encima del máximo aunque no exista Content-Length', async () => {
  const { Readable, Writable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  const limiter = createMediaSizeLimiter(5);
  const sink = new Writable({
    write(_chunk, _encoding, callback) { callback(); }
  });
  await assert.rejects(
    pipeline(Readable.from([Buffer.from('1234'), Buffer.from('5678')]), limiter, sink),
    /superó el límite de descarga de 5 bytes/
  );
});

test('la descarga directa infiere el formato por MIME si la URL no tiene extensión', async t => {
  const dns = require('node:dns/promises');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const payload = Buffer.from('a tiny png payload');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-mime-download-test-'));

  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(payload, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(payload.length) }
  }));

  try {
    const result = await descargaDirecta('https://cdn.example.org/get?id=123', tempDir, 1);
    assert.equal(result.tipo, 'image');
    assert.equal(result.mimetype, 'image/png');
    assert.equal(path.extname(result.path), '.png');
    assert.deepEqual(await fs.readFile(result.path), payload);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('la descarga directa infiere el formato por Content-Disposition si no hay extensión ni MIME específico', async t => {
  const dns = require('node:dns/promises');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const payload = Buffer.from('a tiny movie payload');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-disposition-test-'));

  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(payload, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="holiday.mkv"',
      'content-length': String(payload.length)
    }
  }));

  try {
    const result = await descargaDirecta('https://cdn.example.org/download?id=abc', tempDir, 1);
    assert.equal(result.tipo, 'video');
    assert.equal(path.extname(result.path), '.mkv');
    assert.equal(result.mimetype, 'video/x-matroska');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('corta redirecciones de descargas hacia IP privada antes de hacer otra petición', async t => {
  const dns = require('node:dns/promises');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  let calls = 0;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-redirect-test-'));

  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/internal.mp4' }
    });
  });

  try {
    await assert.rejects(
      descargaDirecta('https://cdn.example.org/redirect', tempDir, 1),
      /dirección no permitida/
    );
    assert.equal(calls, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rechaza archivos directos demasiado grandes según Content-Length', async t => {
  const dns = require('node:dns/promises');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-oversize-test-'));

  t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('x'), {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(MAX_MEDIA_BYTES + 1)
    }
  }));

  try {
    await assert.rejects(
      descargaDirecta('https://cdn.example.org/large.mp4', tempDir, 1),
      /supera el límite de descarga de 100 MB/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('convierte tamaños de metadatos multimedia a bytes sin perder valores Long', () => {
  assert.equal(parseMediaSizeBytes(123), 123);
  assert.equal(parseMediaSizeBytes('456'), 456);
  assert.equal(parseMediaSizeBytes({ toNumber: () => 789 }), 789);
  assert.equal(parseMediaSizeBytes({ low: 10, high: 0 }), 10);
  assert.equal(parseMediaSizeBytes(undefined), null);
  assert.equal(parseMediaSizeBytes('not-a-number'), null);
});

test('rechaza dominios parecidos pero no auténticos', () => {
  assert.equal(extraerUrl('https://instagram.com.evil.example/p/abc', 'instagram'), null);
  assert.equal(extraerUrl('https://not-tiktok.com/@demo/video/1', 'tiktok'), null);
  assert.equal(extraerUrl('https://x.com.example.org/demo/status/1', 'x'), null);
  assert.equal(extraerUrl('https://example.com/p/abc', 'instagram'), null);
});

test('detecta la duración real de FFmpeg y no convierte videos cortos en stickers de 10 segundos', () => {
  assert.equal(parseFfmpegDurationSeconds(
    'Input #0, mov,mp4,m4a, Duration: 00:00:03.04, start: 0.000000, bitrate: 840 kb/s'
  ), 3.04);
  assert.equal(parseFfmpegDurationSeconds('Duration: N/A, start: 0.000000'), null);
  assert.equal(resolveStickerDurationSeconds('Duration: 00:00:03.04, start: 0', 10), 3.04);
  assert.equal(resolveStickerDurationSeconds('', 3), 3);
  assert.equal(resolveStickerDurationSeconds('', 0), 3);
  assert.equal(resolveStickerDurationSeconds('Duration: 00:00:19.75, start: 0', 8), 10);
});

test('prioriza fotogramas fluidos en stickers animados y mantiene la duración de clips cortos', () => {
  const attempts = buildVideoStickerAttempts(3.04);
  assert.ok(attempts.length >= 8);
  assert.ok(attempts.every(attempt => attempt.fps >= 8), 'no debe degradar a 3–5 FPS');
  assert.ok(attempts.every(attempt => attempt.duration === 3.04), 'un clip de 3 s no se alarga ni recorta');
  assert.ok(attempts[0].fps >= 12, 'la primera opción debe priorizar fluidez');
  assert.equal(MAX_ANIMATED_STICKER_BYTES, 480 * 1024);
  assert.ok(MAX_ANIMATED_STICKER_BYTES < 500 * 1024);
  assert.equal(buildVideoStickerAttempts(10).at(-1).duration, 4);
});

test('valida WebP animado cuando contiene ANIM y al menos dos ANMF', () => {
  const file = webp([
    chunk('VP8X', Buffer.alloc(10)),
    chunk('ANIM', Buffer.alloc(6)),
    chunk('ANMF', Buffer.alloc(16)),
    chunk('ANMF', Buffer.alloc(16))
  ]);
  const result = inspectWebpAnimation(file);
  assert.equal(result.valid, true);
  assert.equal(result.animated, true);
  assert.equal(result.frameCount, 2);
});

test('no confunde un WebP estático con uno animado', () => {
  const file = webp([chunk('VP8 ', Buffer.from([1, 2, 3, 4]))]);
  const result = inspectWebpAnimation(file);
  assert.equal(result.valid, true);
  assert.equal(result.animated, false);
  assert.equal(result.frameCount, 0);
});

test('rechaza archivos WebP truncados y cabeceras ajenas', () => {
  assert.equal(inspectWebpAnimation(Buffer.from('GIF89a')).valid, false);
  const bad = webp([chunk('ANIM', Buffer.alloc(6))]).subarray(0, 15);
  assert.equal(inspectWebpAnimation(bad).valid, false);
});

function b64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

test('acepta una sesión completa y registrada', () => {
  const files = {
    'creds.json': b64({ registered: true, noiseKey: { public: 'test' } }),
    'app-state-sync-key-1.json': b64({ keyData: 'test' })
  };
  assert.equal(validateSessionSnapshot(files).registered, true);
});

test('rechaza credenciales no registradas y credenciales JSON corruptas', () => {
  assert.throws(
    () => validateSessionSnapshot({ 'creds.json': b64({ registered: false }) }),
    /no marcó las credenciales como registradas/
  );
  assert.throws(
    () => validateSessionSnapshot({ 'creds.json': Buffer.from('{invalid').toString('base64') }),
    /corrupto/
  );
});

test('rechaza rutas de restauración que intentan salir de la carpeta de sesión', () => {
  const files = {
    '../outside.json': b64({ data: true }),
    'creds.json': b64({ registered: true })
  };
  assert.throws(() => validateSessionSnapshot(files), /ruta de archivo inválida/);
});

test('yt-dlp se instala y su binario puede ejecutarse', () => {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const youtubedl = require('youtube-dl-exec');
  const binaryPath = youtubedl.constants?.YOUTUBE_DL_PATH;

  assert.ok(binaryPath, 'youtube-dl-exec no expone la ruta del binario');
  assert.ok(fs.existsSync(binaryPath), 'no se instaló yt-dlp en ' + binaryPath);
  const version = execFileSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  assert.ok(version.length > 0, 'yt-dlp no devolvió la versión instalada');
});
test('FFmpeg genera un WebP verdaderamente animado con el binario instalado', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const installer = require('@ffmpeg-installer/ffmpeg');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-ffmpeg-test-'));
  const output = path.join(tempDir, 'animated.webp');
  try {
    execFileSync(installer.path, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=96x96:rate=8',
      '-t', '1', '-vf', 'fps=8',
      '-an', '-c:v', 'libwebp_anim', '-lossless', '0',
      '-q:v', '50', '-compression_level', '4', '-loop', '0',
      '-preset', 'picture', '-threads', '1', '-y', output
    ], { timeout: 30000, stdio: 'pipe' });

    const generated = await fs.readFile(output);
    const result = inspectWebpAnimation(generated);
    assert.equal(result.valid, true, result.reason || 'WebP inválido');
    assert.equal(result.animated, true, result.reason || 'WebP estático');
    assert.ok(generated.length <= 450 * 1024, 'el sticker supera el límite interno de 450 KB');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});


test('wa-sticker-formatter crea un WebP estático válido y menor a 95 KB', async () => {
  const sharp = require('sharp');
  const { Sticker, StickerTypes } = require('wa-sticker-formatter');
  const source = await sharp({
    create: {
      width: 512,
      height: 512,
      channels: 4,
      background: { r: 52, g: 128, b: 220, alpha: 1 }
    }
  }).png().toBuffer();

  const MAX_STATIC_BYTES = 95 * 1024;
  let accepted = null;
  let lastSize = 0;

  for (const quality of [85, 75, 65, 55, 45, 35, 25, 18, 12, 8]) {
    const candidate = await new Sticker(source, {
      pack: 'el mejor bot',
      author: 'el mejor bot',
      type: StickerTypes.DEFAULT,
      quality
    }).toBuffer();
    const inspection = inspectWebpAnimation(candidate);
    assert.equal(inspection.valid, true, inspection.reason || 'WebP estático inválido');
    assert.equal(inspection.animated, false, 'una imagen estática no debe convertirse en sticker animado');
    lastSize = candidate.length;
    if (lastSize <= MAX_STATIC_BYTES) {
      accepted = candidate;
      break;
    }
  }

  assert.ok(accepted, 'el sticker estático excede el límite tras 10 niveles de compresión; último tamaño: ' + lastSize);
  assert.ok(accepted.length <= MAX_STATIC_BYTES);
});
