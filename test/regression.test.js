'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extraerUrl } = require('../descargasSociales');
const { inspectWebpAnimation } = require('../stickerUtils');
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
