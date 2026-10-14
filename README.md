# el-mejor-bot

Bot de WhatsApp dedicado a crear stickers de imágenes y videos.

## Uso
- Envía una imagen con `sticker`, `s` o `st`.
- Envía un video con `sticker`, `s` o `st`.
- También puedes responder una imagen o video con uno de esos comandos.
- Envía `tiktok https://...` para descargar un video público de TikTok.
- Envía `instagram https://...` para descargar un video público de Instagram/Reels.

Las descargas usan `yt-dlp`; la disponibilidad depende de que la publicación sea pública y de los cambios de cada plataforma. No se incluyen comandos ni textos de apoyo a creadores del bot de referencia.
- El pack y autor son **el mejor bot**.

## Login
Incluye QR y código de vinculación de 8 dígitos, con reconexión automática.

El panel de vinculación y las acciones que pueden cerrar o reemplazar la sesión requieren autenticación HTTP Basic:
- Usuario: `admin`
- Contraseña: `ADMIN_PASSWORD` en Render.
- Si `ADMIN_PASSWORD` no existe, el panel usa `SESSION_PASSWORD` como alternativa.

Configura `ADMIN_PASSWORD` en Render para que la contraseña del panel sea independiente de la usada para cifrar la sesión. No compartas esa contraseña: el panel muestra el QR/código con el que se puede vincular un dispositivo a tu WhatsApp.

La sesión se guarda en `./session`. En Render Free el almacenamiento puede ser efímero al recrear la instancia.


## Sesión cifrada en GitHub

La sesión de WhatsApp se puede respaldar en `session.enc` cifrada con **AES-256-GCM**. El archivo cifrado no contiene la contraseña.

En Render configura estas variables privadas:
- `GITHUB_TOKEN`: token de GitHub con permiso para escribir en este repositorio.
- `GITHUB_REPO`: `alpizar269708-crypto/el-mejor-bot`
- `SESSION_PASSWORD`: contraseña larga y secreta para cifrar/descifrar la sesión.

**No subas la contraseña ni el token al repositorio.** Si alguien obtiene la contraseña y el archivo cifrado, podría descifrar la sesión de WhatsApp.

## Despliegue en VPS con Docker

El repositorio incluye un `Dockerfile` y `docker-compose.yml` para ejecutar el bot en un VPS Linux con Docker Compose. El contenedor conserva la carpeta local de sesión en un volumen y el respaldo cifrado de GitHub sigue funcionando como mecanismo adicional de recuperación.

### Requisitos del VPS

- Un servidor Linux con Docker Engine y el complemento Docker Compose.
- Acceso SSH por clave pública.
- Un usuario de GitHub con acceso al repositorio para configurar los secretos de despliegue.
- Las variables privadas de `.env.example` configuradas en `~/el-mejor-bot/.env` en el servidor. No subas ese archivo a GitHub.

### Primer despliegue

1. Instala Docker en el VPS y agrega tu usuario al grupo `docker` si corresponde.
2. Clona este repositorio en `~/el-mejor-bot`.
3. Copia `.env.example` a `.env` y completa `GITHUB_TOKEN`, `SESSION_PASSWORD` y una contraseña independiente `ADMIN_PASSWORD`.
4. Protege el archivo: `chmod 600 ~/el-mejor-bot/.env`.
5. Ejecuta `docker compose up -d --build` desde esa carpeta.
6. Comprueba el estado con `docker compose ps` y los registros con `docker compose logs -f --tail=100`.

El puerto 3000 queda enlazado a `127.0.0.1`, no expuesto directamente a Internet. Si necesitas el panel web desde fuera del servidor, configura un proxy inverso con HTTPS y conserva la autenticación administrativa.

### Despliegues desde GitHub Actions

El workflow manual **Deploy to VPS** requiere estos secretos del repositorio: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` y `VPS_KNOWN_HOSTS`. La clave pública correspondiente debe estar autorizada en el VPS. Verifica la huella SSH del servidor por un canal confiable antes de guardar `VPS_KNOWN_HOSTS`.

Después del primer despliegue y de configurar esos secretos, ejecuta **Actions → Deploy to VPS → Run workflow**. El workflow actualiza `main` y reconstruye el contenedor. No configura ni revela los secretos de la aplicación.

### Alojamiento gratuito

Un VPS gratuito depende del proveedor, la región y la disponibilidad de recursos; no se garantiza que haya una instancia gratuita disponible. GitHub Actions no sustituye al VPS para mantener WhatsApp conectado permanentemente.
