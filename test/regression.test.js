'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extraerUrl } = require('../descargasSociales');
const { inspectWebpAnimation } = require('../stickerUtils');

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
