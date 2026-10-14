'use strict';

function validateSessionSnapshot(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('El archivo cifrado no contiene una colección de archivos válida.');
  }

  const entries = Object.entries(files);
  if (!entries.length) throw new Error('La sesión guardada está vacía.');

  for (const [relativePath, base64] of entries) {
    const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
    const segments = normalizedPath.split('/');
    if (
      !normalizedPath ||
      normalizedPath.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalizedPath) ||
      segments.some(part => !part || part === '.' || part === '..')
    ) {
      throw new Error('La sesión contiene una ruta de archivo inválida.');
    }
    if (typeof base64 !== 'string' || !base64 || /[^A-Za-z0-9+/=]/.test(base64)) {
      throw new Error('La sesión contiene un archivo Base64 inválido: ' + normalizedPath);
    }

    let content;
    try {
      content = Buffer.from(base64, 'base64');
      if (
        content.length === 0 ||
        content.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')
      ) {
        throw new Error('Base64 inválido');
      }
      if (normalizedPath.toLowerCase().endsWith('.json')) {
        JSON.parse(content.toString('utf8'));
      }
    } catch {
      throw new Error('El archivo de sesión está vacío o corrupto: ' + normalizedPath);
    }
  }

  if (typeof files['creds.json'] !== 'string') {
    throw new Error('La sesión no incluye creds.json.');
  }

  let creds;
  try {
    creds = JSON.parse(Buffer.from(files['creds.json'], 'base64').toString('utf8'));
  } catch {
    throw new Error('creds.json está corrupto o no es JSON válido.');
  }

  if (creds?.registered !== true) {
    throw new Error('WhatsApp no marcó las credenciales como registradas.');
  }

  return creds;
}

module.exports = { validateSessionSnapshot };
