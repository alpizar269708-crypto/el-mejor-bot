'use strict';

function inspectWebpAnimation(input) {
  if (!Buffer.isBuffer(input) || input.length < 12) {
    return { valid: false, animated: false, frameCount: 0, reason: 'cabecera incompleta' };
  }
  if (input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WEBP') {
    return { valid: false, animated: false, frameCount: 0, reason: 'no es un contenedor RIFF/WebP' };
  }

  const riffEnd = input.readUInt32LE(4) + 8;
  if (riffEnd < 12 || riffEnd > input.length) {
    return { valid: false, animated: false, frameCount: 0, reason: 'longitud RIFF inválida' };
  }

  let offset = 12;
  let hasAnimationHeader = false;
  let frameCount = 0;

  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) {
      return { valid: false, animated: false, frameCount, reason: 'cabecera de fragmento truncada' };
    }

    const chunkType = input.toString('ascii', offset, offset + 4);
    const chunkSize = input.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkSize;
    const paddedEnd = chunkEnd + (chunkSize % 2);

    if (chunkEnd > riffEnd || paddedEnd > riffEnd) {
      return { valid: false, animated: false, frameCount, reason: 'fragmento WebP truncado' };
    }

    if (chunkType === 'ANIM') hasAnimationHeader = true;
    if (chunkType === 'ANMF') frameCount += 1;
    offset = paddedEnd;
  }

  if (offset !== riffEnd) {
    return { valid: false, animated: false, frameCount, reason: 'estructura RIFF incoherente' };
  }

  const animated = hasAnimationHeader && frameCount >= 2;
  return {
    valid: true,
    animated,
    frameCount,
    reason: animated ? null : 'faltan ANIM y al menos dos fotogramas ANMF'
  };
}


function parseMediaSizeBytes(value) {
  if (value == null) return null;

  try {
    if (typeof value === 'object' && typeof value.toNumber === 'function') {
      value = value.toNumber();
    } else if (
      typeof value === 'object' &&
      Number.isFinite(value.low) &&
      Number.isFinite(value.high)
    ) {
      value = (value.high >>> 0) * 0x100000000 + (value.low >>> 0);
    }

    const numeric = typeof value === 'bigint'
      ? Number(value)
      : (typeof value === 'string' && value.trim() === '' ? NaN : Number(value));
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  } catch {
    return null;
  }
}

module.exports = { inspectWebpAnimation, parseMediaSizeBytes };
