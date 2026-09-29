# el-mejor-bot

Bot de WhatsApp dedicado a crear stickers de imágenes y videos.

## Uso
- Envía una imagen con `sticker`, `s` o `st`.
- Envía un video con `sticker`, `s` o `st`.
- También puedes responder una imagen o video con uno de esos comandos.
- El pack y autor son **el mejor bot**.

## Login
Incluye QR y código de vinculación de 8 dígitos, con reconexión automática.

La sesión se guarda en `./session`. En Render Free el almacenamiento puede ser efímero al recrear la instancia.


## Sesión cifrada en GitHub

La sesión de WhatsApp se puede respaldar en `session.enc` cifrada con **AES-256-GCM**. El archivo cifrado no contiene la contraseña.

En Render configura estas variables privadas:
- `GITHUB_TOKEN`: token de GitHub con permiso para escribir en este repositorio.
- `GITHUB_REPO`: `alpizar269708-crypto/el-mejor-bot`
- `SESSION_PASSWORD`: contraseña larga y secreta para cifrar/descifrar la sesión.

**No subas la contraseña ni el token al repositorio.** Si alguien obtiene la contraseña y el archivo cifrado, podría descifrar la sesión de WhatsApp.