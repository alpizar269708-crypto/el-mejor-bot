'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extraerUrl, analizarSolicitudDescarga, detectarPlataforma, tipoMimetype, tipoEnvioWhatsApp, MAX_MEDIA_BYTES, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_VIDEO_BYTES, TIMEOUT_MS, MAX_MEDIA_FILES } = require('../descargasSociales');
const { inspectWebpAnimation, parseMediaSizeBytes } = require('../stickerUtils');
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
