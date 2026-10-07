# wa-ingest-grok

Lee los mensajes nuevos de **un** grupo de WhatsApp (vía WAHA) y los manda tal cual a un webhook. El texto sale con autor, fecha ISO y `reply_to` si es una respuesta. Los audios y los vídeos se transcriben (del vídeo solo se saca el audio; no se miran los fotogramas). Las imágenes, los PDF y el resto de archivos se suben a un bucket S3/R2 y en el webhook va solo la URL; de los PDF también se extrae el texto. Si el texto contiene un alias de `REPO_ALIASES` (por ejemplo `#plataforma`), el lote lleva el campo `repo`. No clasifica ni interpreta el contenido. Si no hay mensajes nuevos, no llama al webhook.

El primer ciclo solo guarda la hora actual y no reenvía el historial del grupo. A partir de ahí manda lo que llegue después. El cursor está en `/data/cursor.json`.

## Requisitos

- Coolify, en un servidor que pueda construir imágenes Docker.
- Clave de OpenAI (`OPENAI_API_KEY`) para transcribir audio y vídeo.
- Bucket S3 o R2 (endpoint, bucket y access key) para imágenes, PDF y otros archivos.
- Un teléfono con WhatsApp para escanear el QR.
- URL y clave del webhook que va a recibir los lotes.

Sin la clave de OpenAI los audios y vídeos se envían igual, con `transcript` vacío. Sin el bucket, las imágenes y los archivos se envían sin URL.

## Despliegue en Coolify

1. En el proyecto: **+ New** → repositorio Git (público, deploy key o Git App).
2. **General → Build pipeline**: estrategia **Compose**.
3. **Base Directory**: `/`. **Docker Compose Location**: `docker-compose.yml`. Guarda.
4. Revisa **Docker Compose Content**. No lo edites en Coolify: el archivo del repo es el que vale. Si cambias el compose, hazlo en Git y vuelve a cargar la configuración.
5. **Environment Variables**. Coolify crea las variables que el compose referencia con `${...}`. Rellena los valores de la tabla de abajo. `WAHA_GROUP_ID` puede quedar vacío en este primer deploy.
6. **Deploy**. Espera a que el build del `worker` y el arranque de `waha` terminen en los logs de deployment.

No hace falta nada más en Coolify además del compose y las variables:

- **Volúmenes.** No los crees en Persistent Storage. El compose ya declara `waha-sessions` (sesión de WhatsApp), `waha-media` y `worker-data` (cursor). Coolify los crea, les pone un prefijo para que no choquen con otros recursos y los enseña ahí en solo lectura. Sobreviven a un restart y a un redeploy. Borrar ese volumen de sesión obliga a escanear el QR otra vez.
- **Puertos y dominio.** No añadas dominio ni publiques el puerto 3000. El compose no tiene `ports:`. WAHA solo escucha dentro de la red del stack (`http://waha:3000`). El worker no tiene puerto. Publicar WAHA lo dejaría accesible fuera del servidor.
- **Build.** No pongas Custom Build Command ni Custom Start Command, y no actives Raw Compose. El `worker` se construye con el `Dockerfile` de la raíz porque el servicio tiene `build: .`. Las claves son de runtime: después de cambiar una variable basta con **Restart**. Haz **Redeploy** solo si cambia el código, el Dockerfile o el compose.
- **Red.** Los dos servicios se ven por el nombre (`waha`). No hace falta Connect to predefined network: el webhook sale por HTTPS normal.

`shm_size: 2gb` ya está en el compose. Hace falta porque la imagen `devlikeapro/waha:latest` usa Chromium. No lo quites.

Los comandos de abajo se ejecutan **dentro** del contenedor `worker`. En Coolify abre el terminal de ese contenedor (el servicio se llama `worker`, sin el sufijo que Coolify añade al nombre del contenedor). No escribas `docker compose exec`: ya estás dentro.

## Variables

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `WAHA_URL` | URL de WAHA vista desde el worker. En Compose déjala así. | `http://waha:3000` |
| `WAHA_API_KEY` | Clave que el worker manda en `X-Api-Key`. La misma va al contenedor de WAHA. Vacía solo si `WAHA_NO_API_KEY=true`. | `openssl rand -hex 32` |
| `WAHA_NO_API_KEY` | `true` apaga la clave de WAHA. En un servidor expuesto pon `false` y rellena `WAHA_API_KEY`. | `false` |
| `WAHA_SESSION` | Nombre de la sesión de WhatsApp. | `default` |
| `WAHA_GROUP_ID` | Id del grupo (`…@g.us`), el de `npm run groups`. | `120363012345678901@g.us` |
| `INTERVAL_MINUTES` | Cada cuánto mira mensajes nuevos. | `5` |
| `OPENAI_API_KEY` | Clave de OpenAI. Whisper (`whisper-1`). | `sk-…` |
| `GROKBOT_WEBHOOK_URL` | A dónde hace POST el lote. | `https://ejemplo.com/webhook` |
| `GROKBOT_WEBHOOK_KEY` | Secreto del webhook. | `un-secreto-largo` |
| `GROKBOT_WEBHOOK_HEADER` | Cabecera. Vacío = `Authorization: Bearer <GROKBOT_WEBHOOK_KEY>`. Si no lleva `:`, se usa como nombre de cabecera y el valor es la clave. | vacío, o `X-Webhook-Token: ${GROKBOT_WEBHOOK_KEY}` |
| `STORAGE_ENDPOINT` | Endpoint S3. En AWS puedes dejarlo vacío. En R2 es obligatorio. | `https://ACCOUNT.r2.cloudflarestorage.com` |
| `STORAGE_REGION` | Región. En R2, `auto`. | `auto` |
| `STORAGE_BUCKET` | Nombre del bucket. | `wa-ingest` |
| `STORAGE_ACCESS_KEY_ID` | Access key del bucket. | `…` |
| `STORAGE_SECRET_ACCESS_KEY` | Secret key del bucket. | `…` |
| `STORAGE_FORCE_PATH_STYLE` | `true` en R2 y MinIO. Si omites el endpoint, el default es `false` (AWS). | `true` |
| `STORAGE_PREFIX` | Prefijo de las claves dentro del bucket. | `wa-ingest/` |
| `STORAGE_URL_EXPIRES_SECONDS` | Caducidad de la URL firmada, en segundos. R2 admite como máximo 7 días. | `604800` |
| `REPO_ALIASES` | `alias=owner/repo`, separados por comas. El primer alias que aparezca en el **texto** fija `repo`. No mira la transcripción. | `#plataforma=jreyessn/plataforma_tm` |
| `DATA_DIR` | Carpeta del cursor. El compose ya la monta en el volumen. | `/data` |
| `WHATSAPP_DEFAULT_ENGINE` | Motor de WAHA. La imagen `latest` usa `WEBJS`. | `WEBJS` |

Si cambias una variable en Coolify, guarda y reinicia el recurso. El proceso solo lee el entorno al arrancar.

El POST lleva `Authorization: Bearer <clave>` (salvo que cambies la cabecera) y `Idempotency-Key` igual a `batch_id`. Un lote se ve así:

```json
{
  "source": "whatsapp",
  "group": "120363012345678901@g.us",
  "repo": "jreyessn/plataforma_tm",
  "batch_id": "…",
  "messages": [
    {
      "id": "false_120363012345678901@g.us_AAAA",
      "author": "5491111111111@c.us",
      "timestamp": "2026-10-07T15:00:00.000Z",
      "type": "text",
      "text": "hola #plataforma",
      "transcript": null,
      "file_url": null,
      "file_name": null,
      "reply_to": null
    }
  ]
}
```

`type` es `text`, `audio`, `video`, `image` o `document`. `repo` no viene si ningún alias coincide.

## Primer QR

1. Con el stack en marcha, abre el terminal del contenedor **worker**.
2. `npm run login`
3. En el teléfono: WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo. Escanea el QR de la terminal.
4. El comando termina solo cuando la sesión pasa a `WORKING`.

El QR caduca enseguida. Si deja de valer, el comando imprime otro. También sale en los logs del worker mientras el estado sea `SCAN_QR_CODE` (`npm run login` es el que hay que usar para escanear a tiempo).

Un restart normal no pide QR otra vez: la sesión está en el volumen `waha-sessions`.

## El grupo

En el mismo terminal del worker:

```bash
npm run groups
```

Cada línea es `id` y nombre, separados por un tabulador. Copia el id (`…@g.us`) a `WAHA_GROUP_ID`, guarda las variables y reinicia.

Hasta que `WAHA_GROUP_ID` y `GROKBOT_WEBHOOK_URL` tengan valor, el worker sigue vivo y escribe `worker.waiting_for_config`. No manda nada.

## Probar con `npm run once`

En el terminal del worker:

```bash
npm run once
```

La primera vez, con el cursor vacío, solo anota la hora y sale sin llamar al webhook. Es el comportamiento normal.

Para ver un envío de verdad: escribe un mensaje en el grupo **después** de ese primer `once`, y vuelve a ejecutar `npm run once`. En los logs tiene que aparecer `webhook.sent` con un `batch_id`. Si no hubo nada nuevo, verás `cycle.no_new_messages` y no hay POST.

El bucle normal hace lo mismo solo, cada `INTERVAL_MINUTES`.

## Día a día

Los logs del worker son una línea JSON. Los mensajes útiles son `webhook.sent`, `cycle.no_new_messages`, `webhook.retry`, `webhook.failed`, `waha.needs_login` y `worker.waiting_for_config`.

**WhatsApp desvinculó el dispositivo (hay que escanear otra vez).** En los logs la sesión no está en `WORKING`: suele ser `SCAN_QR_CODE` o `FAILED`. Entra al terminal del worker y ejecuta `npm run login`. No borres el volumen salvo que quieras empezar de cero. Si se queda en `FAILED`, reinicia el servicio `waha` en Coolify y vuelve a lanzar `npm run login`.

**No llega nada al webhook.**

- `worker.waiting_for_config`: falta `WAHA_GROUP_ID` o `GROKBOT_WEBHOOK_URL`. Rellénalos y reinicia.
- `waha.needs_login` o estado distinto de `WORKING`: la sesión no está vinculada. QR de nuevo.
- `cycle.no_new_messages`: no hay nada posterior al cursor. El historial anterior al primer arranque no se reenvía. Manda un mensaje nuevo y prueba `npm run once`.
- `WAHA_GROUP_ID` de otro grupo. `npm run groups` y corrige la variable.
- `webhook.failed` o `webhook.retry`: el POST falló y el cursor **no** avanza, así que el mismo lote se reintenta. Lee el status en esa línea.
- Si cambiaste de grupo y quieres ignorar lo ya guardado, en el worker borra `/data/cursor.json` y reinicia. El siguiente ciclo vuelve a marcar "ahora" y no envía el historial.

**El webhook responde 401 o 403.** La cabecera no coincide con lo que el receptor espera. Con `GROKBOT_WEBHOOK_HEADER` vacío tiene que llegar `Authorization: Bearer <GROKBOT_WEBHOOK_KEY>`. Esos códigos no se reintentan. Un 429 o un 5xx sí, con esperas de 1 s, 2 s, 4 s y 8 s, hasta 5 intentos. Si Coolify se comió el texto `${GROKBOT_WEBHOOK_KEY}` al guardar la cabecera, déjala vacía y pon solo `GROKBOT_WEBHOOK_KEY`, o escribe la cabecera ya con la clave, sin `${...}`.

**WAHA responde 401.** `WAHA_API_KEY` del worker y el de WAHA no coinciden, o `WAHA_NO_API_KEY` no está en `false` teniendo clave. La misma variable se inyecta en los dos servicios. Reinicia después de cambiarla.

**Audio o vídeo sin texto.** Revisa `OPENAI_API_KEY`. Whisper no acepta más de 25 MB; por encima de 50 MB ni se descarga. El mensaje se envía igual, con `transcript` vacío. El error queda en `message.enrich_failed`.

**Imagen o PDF sin URL.** Revisa `STORAGE_BUCKET`, las dos claves y, en R2, `STORAGE_ENDPOINT` y `STORAGE_FORCE_PATH_STYLE=true`. El error queda en `storage.not_configured` o `message.enrich_failed`.
