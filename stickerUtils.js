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


const MAX_ANIMATED_STICKER_BYTES = 480 * 1024;
const MAX_STICKER_DURATION_SECONDS = 10;

function parseFfmpegDurationSeconds(output) {
  const match = String(output || '').match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function resolveStickerDurationSeconds(ffmpegOutput, declaredSeconds, fallbackSeconds = 3) {
  const probed = parseFfmpegDurationSeconds(ffmpegOutput);
  const declared = Number(declaredSeconds);
  const fallback = Number(fallbackSeconds);
  const chosen = probed ??
    (Number.isFinite(declared) && declared > 0 ? declared :
      (Number.isFinite(fallback) && fallback > 0 ? fallback : 3));
  return Math.round(Math.min(Math.max(chosen, 0.1), MAX_STICKER_DURATION_SECONDS) * 1000) / 1000;
}

function buildVideoStickerAttempts(duration) {
  const numeric = Number(duration);
  const actualDuration = Math.min(
    Math.max(Number.isFinite(numeric) && numeric > 0 ? numeric : 3, 0.1),
    MAX_STICKER_DURATION_SECONDS
  );
  // Priorizar movimiento fluido y reducir calidad antes que caer a 3–5 FPS.
  // Si el original es corto (p. ej. 3 s), nunca se alarga ni se recorta.
  return [
    { fps: 15, quality: 60, size: 512, duration: actualDuration },
    { fps: 15, quality: 50, size: 512, duration: actualDuration },
    { fps: 12, quality: 50, size: 512, duration: actualDuration },
    { fps: 12, quality: 40, size: 512, duration: actualDuration },
    { fps: 10, quality: 35, size: 512, duration: actualDuration },
    { fps: 10, quality: 28, size: 512, duration: actualDuration },
    // Al reducir el detalle espacial, preservar FPS antes de degradar el movimiento.
    { fps: 10, quality: 24, size: 448, duration: actualDuration },
    { fps: 10, quality: 20, size: 416, duration: actualDuration },
    { fps: 8, quality: 20, size: 416, duration: actualDuration },
    { fps: 8, quality: 20, size: 384, duration: Math.min(actualDuration, 6) },
    { fps: 8, quality: 18, size: 352, duration: Math.min(actualDuration, 4) }
  ];
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

module.exports = { inspectWebpAnimation, parseMediaSizeBytes, parseFfmpegDurationSeconds, resolveStickerDurationSeconds, buildVideoStickerAttempts, MAX_ANIMATED_STICKER_BYTES, MAX_STICKER_DURATION_SECONDS };
