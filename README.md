# El mejor bot

Bot de WhatsApp con las utilidades tomadas de [bot-completobeto](https://github.com/alpizar269708-crypto/bot-completobeto):

- Stickers de imagen/video y recuperación de foto de ver una vez.
- Descargas de TikTok, Instagram, Pinterest, X y otros sitios compatibles con yt-dlp.
- Traducción de texto.
- Búsqueda de skins y estadísticas de Fortnite.
- Menú, ping y contacto.

## Sesión y despliegue

La vinculación por QR/código y el guardado/restauración cifrados de la sesión en GitHub se conservan en este repositorio. Render usa `render.yaml`.

Variables necesarias en Render:
- `GITHUB_TOKEN`: token con permisos de contenido para este repositorio.
- `SESSION_PASSWORD`: contraseña fuerte para cifrar la sesión.
- `SESSION_BRANCH=session-data`: rama de la sesión cifrada.
- `MEMORY_BRANCH=memory-data`: rama de memoria persistente.
- `ADMIN_PASSWORD`: contraseña del panel administrativo, si se desea distinta de SESSION_PASSWORD.

No subas `.env`, credenciales ni sesiones sin cifrar al repositorio.
