# wa-ingest-grok

Lee los mensajes nuevos de **un** grupo de WhatsApp (vía WAHA) y los manda tal cual a un webhook. El texto sale con autor, fecha ISO y `reply_to` si es una respuesta. Los audios y los vídeos se transcriben con un Whisper propio (del vídeo solo se saca el audio; no se miran los fotogramas). Las imágenes, los PDF y el resto de archivos van dentro del JSON, en base64, con su tipo y su nombre; de los PDF también se extrae el texto. Si el archivo pasa de `MAX_INLINE_FILE_MB` (5 por defecto) el mensaje se envía igual, sin los bytes y con `note: "too_large"`. Si el texto contiene un alias de `REPO_ALIASES` (por ejemplo `#plataforma`), el lote lleva `repo`. No clasifica el contenido. Si no hay mensajes nuevos, no llama al webhook.

No hace falta clave de OpenAI ni bucket. El primer ciclo solo guarda la hora actual y no reenvía el historial. El cursor está en `/data/cursor.json`.

## Requisitos

- Coolify, en un servidor que pueda construir imágenes Docker.
- Un VPS con RAM de sobra para WAHA (Chromium) y Whisper a la vez. Ver más abajo.
- Un teléfono con WhatsApp para escanear el QR.
- URL y clave del webhook que va a recibir los lotes.

OpenAI es opcional (`TRANSCRIBE_PROVIDER=openai` y `OPENAI_API_KEY`). El default no lo usa.

## Whisper en el mismo Compose

El servicio `whisper` es [Speaches](https://speaches.ai/) (`ghcr.io/speaches-ai/speaches:latest-cpu`), la continuación de faster-whisper-server. Habla la API de OpenAI: `POST /v1/audio/transcriptions`. No publica puerto. El worker lo llama en `http://whisper:8000/v1`.

El modelo por defecto es `Systran/faster-whisper-base` (multilingüe, unos 150 MB, cuantizado a int8 en CPU). Sirve para un VPS sin GPU y para audio en español. `Systran/faster-whisper-tiny` gasta menos y oye peor. `small` oye mejor y pide más RAM.

En CPU, el contenedor de Whisper necesita **1–2 GB de RAM** y va bien con **2 vCPU**. Un audio de un minuto en `base` puede tardar alrededor de un minuto en 2 vCPU, y bastante más en 1. WAHA con la imagen `latest` (motor WEBJS, Chromium, `shm_size: 2gb`) suma otros 2 GB. Para los tres servicios cuenta con **4 GB como mínimo y 8 GB si puedes**.

El worker, al arrancar y antes de cada transcripción, hace `GET /v1/models`. Si falta `WHISPER_MODEL`, hace `POST /v1/models/{id}` y espera la descarga. La primera vez puede tardar medio minuto o más. El archivo queda en el volumen `whisper-models`. Si Whisper todavía no responde, el worker sigue vivo y lo reintenta en la siguiente transcripción. Si una transcripción responde 404 `not installed`, lo instala y reintenta esa petición una vez.

Para cambiar de modelo, pon el id en `WHISPER_MODEL` y reinicia el worker.

Si no se baja solo, desde el host:

```bash
docker compose exec worker node -e "fetch('http://whisper:8000/v1/models/Systran/faster-whisper-base',{method:'POST'}).then(r=>r.text()).then(console.log)"
```

En el terminal de Coolify del contenedor `worker`, quita `docker compose exec worker` y deja el `node -e`.

## Despliegue en Coolify

1. En el proyecto: **+ New** → repositorio Git.
2. **General → Build pipeline**: estrategia **Compose**.
3. **Base Directory**: `/`. **Docker Compose Location**: `docker-compose.yml`. Guarda.
4. Revisa **Docker Compose Content**. No lo edites en Coolify. Si cambias el compose, hazlo en Git y vuelve a cargar la configuración.
5. **Environment Variables**. Coolify crea las que el compose referencia con `${...}`. Rellena el webhook. `WAHA_GROUP_ID` puede quedar vacío en este primer deploy. Deja `TRANSCRIBE_PROVIDER=speaches`.
6. **Deploy**. La primera transcripción (o el arranque del worker) descarga el modelo; puede tardar unos minutos.

No hace falta nada más en Coolify aparte del compose y las variables:

- **Volúmenes.** No los crees en Persistent Storage. El compose ya declara `waha-sessions` (sesión de WhatsApp), `waha-media`, `whisper-models` (el modelo) y `worker-data` (cursor). Coolify los crea, les pone prefijo y los enseña ahí en solo lectura. Borrar `waha-sessions` obliga a escanear el QR otra vez. Borrar `whisper-models` obliga a volver a bajar el modelo.
- **Puertos y dominio.** No añadas dominio ni publiques puertos. El compose no tiene `ports:`. WAHA solo existe en `http://waha:3000` dentro de la red del stack. Whisper solo en `http://whisper:8000`. El worker no escucha HTTP: los archivos van dentro del POST, no se sirven. Publicar WAHA o Whisper los dejaría abiertos en internet, y Whisper no lleva clave.
- **Build.** No pongas Custom Build Command ni Custom Start Command, y no actives Raw Compose. El `worker` se construye con el `Dockerfile` de la raíz (`build: .`). Whisper y WAHA son imágenes ya hechas. Las variables son de runtime: después de cambiarlas basta con **Restart**. **Redeploy** solo si cambia el código, el Dockerfile o el compose.
- **Red.** Los servicios se ven por su nombre. No hace falta Connect to predefined network.

`shm_size: 2gb` ya está en el compose por Chromium. No lo quites.

Los comandos de abajo se ejecutan **dentro** del contenedor `worker`. En Coolify abre el terminal de ese contenedor (el servicio se llama `worker`, sin el sufijo del contenedor). No escribas `docker compose exec`.

## Variables

| Variable | Qué es | Ejemplo |
| --- | --- | --- |
| `WAHA_URL` | URL de WAHA vista desde el worker. | `http://waha:3000` |
| `WAHA_API_KEY` | Clave que el worker manda en `X-Api-Key`. La misma va al contenedor de WAHA. Vacía solo si `WAHA_NO_API_KEY=true`. | una cadena larga al azar |
| `WAHA_NO_API_KEY` | `true` apaga la clave de WAHA. Si publicaras WAHA, pon `false` y rellena la clave. Aquí no se publica. | `true` |
| `WAHA_SESSION` | Nombre de la sesión de WhatsApp. | `default` |
| `WAHA_GROUP_ID` | Id del grupo (`…@g.us`), el de `npm run groups`. | `120363012345678901@g.us` |
| `INTERVAL_MINUTES` | Cada cuánto mira mensajes nuevos. | `5` |
| `TRANSCRIBE_PROVIDER` | `speaches` (default, local) u `openai`. | `speaches` |
| `WHISPER_BASE_URL` | API compatible con OpenAI, sin la ruta `/audio/transcriptions`. | `http://whisper:8000/v1` |
| `WHISPER_MODEL` | Id del modelo. El worker lo descarga si Speaches no lo tiene. | `Systran/faster-whisper-base` |
| `WHISPER_API_KEY` | Solo si más adelante pones `API_KEY` en el contenedor whisper. Vacío = sin cabecera. | vacío |
| `OPENAI_API_KEY` | Solo si `TRANSCRIBE_PROVIDER=openai`. | `sk-…` |
| `MAX_INLINE_FILE_MB` | Tope de los bytes que se meten en el JSON. Por encima: `note` = `too_large` y sin `data_base64`. | `5` |
| `GROKBOT_WEBHOOK_URL` | A dónde hace POST el lote. | `https://ejemplo.com/webhook` |
| `GROKBOT_WEBHOOK_KEY` | Secreto del webhook. | `un-secreto-largo` |
| `GROKBOT_WEBHOOK_HEADER` | Cabecera. Vacío = `Authorization: Bearer <GROKBOT_WEBHOOK_KEY>`. Si no lleva `:`, es el nombre y el valor es la clave. | vacío |
| `REPO_ALIASES` | `alias=owner/repo`, separados por comas. El primer alias en el **texto** fija `repo`. No mira la transcripción. | `#plataforma=jreyessn/plataforma_tm` |
| `DATA_DIR` | Carpeta del cursor. | `/data` |
| `WHATSAPP_DEFAULT_ENGINE` | Motor de WAHA. | `WEBJS` |

Si cambias una variable, guarda y reinicia. El proceso solo lee el entorno al arrancar.

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
      "type": "document",
      "text": "adjunto\n\ntexto del pdf",
      "transcript": null,
      "mime_type": "application/pdf",
      "file_name": "spec.pdf",
      "data_base64": "JVBERg…",
      "note": null,
      "reply_to": null
    }
  ]
}
```

`type` es `text`, `audio`, `video`, `image` o `document`. En texto, audio y vídeo, `mime_type`, `file_name` y `data_base64` van a `null`. `repo` no viene si ningún alias coincide. `note` solo vale `too_large` o `null`.

## Primer QR

1. Con el stack en marcha, abre el terminal del contenedor **worker**.
2. `npm run login`
3. En el teléfono: WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo. Escanea el QR.
4. El comando termina cuando la sesión pasa a `WORKING`.

El QR caduca enseguida. Si deja de valer, el comando imprime otro. También sale en los logs del worker mientras el estado sea `SCAN_QR_CODE`.

Si la sesión está en `FAILED` (por ejemplo un `auth timeout` de WEBJS) o en `STOPPED`, `npm run login` la para y la vuelve a arrancar (`POST /api/sessions/{sesión}/stop` y luego `/start`) antes de mostrar el QR.

Un restart normal no pide QR: la sesión está en `waha-sessions`.

## El grupo

```bash
npm run groups
```

Cada línea es `id` y nombre, separados por un tabulador. Copia el id (`…@g.us`) a `WAHA_GROUP_ID`, guarda y reinicia.

Hasta que `WAHA_GROUP_ID` y `GROKBOT_WEBHOOK_URL` tengan valor, el worker sigue vivo y escribe `worker.waiting_for_config`. No manda nada.

## Probar con `npm run once`

```bash
npm run once
```

La primera vez, con el cursor vacío, solo anota la hora y no llama al webhook.

Después escribe algo en el grupo y vuelve a ejecutar `npm run once`. En los logs tiene que aparecer `webhook.sent`. Si no hubo nada nuevo, verás `cycle.no_new_messages`.

El bucle normal hace lo mismo cada `INTERVAL_MINUTES`.

## Día a día

Los logs del worker son una línea JSON. Mira `webhook.sent`, `cycle.no_new_messages`, `webhook.retry`, `webhook.failed`, `waha.needs_login`, `worker.waiting_for_config`, `message.too_large`, `media.download`, `media.download_failed`, `media.deferred` y `media.transcription_failed`.

**WhatsApp desvinculó el dispositivo.** La sesión no está en `WORKING` (`SCAN_QR_CODE`, `STOPPED` o `FAILED`). En el terminal del worker: `npm run login`. Ese comando reinicia la sesión si está en `FAILED` o `STOPPED` y muestra el QR. No borres el volumen salvo que quieras empezar de cero.

**No llega nada al webhook.**

- `worker.waiting_for_config`: falta `WAHA_GROUP_ID` o `GROKBOT_WEBHOOK_URL`. Rellena y reinicia.
- `waha.needs_login` o estado distinto de `WORKING`: hay que escanear el QR.
- `cycle.no_new_messages`: no hay nada posterior al cursor. El historial anterior al primer arranque no se reenvía. Manda un mensaje nuevo y prueba `npm run once`.
- `WAHA_GROUP_ID` de otro grupo. `npm run groups` y corrige.
- `webhook.failed` o `webhook.retry`: el POST falló y el cursor no avanza. Lee el status.
- Para marcar "ahora" otra vez y olvidar lo pendiente, borra `/data/cursor.json` en el worker y reinicia. El siguiente ciclo no envía el historial.

**El webhook responde 401 o 403.** La cabecera no coincide. Con `GROKBOT_WEBHOOK_HEADER` vacío tiene que llegar `Authorization: Bearer <GROKBOT_WEBHOOK_KEY>`. Esos códigos no se reintentan. Un 429 o un 5xx sí, con esperas de 1 s, 2 s, 4 s y 8 s, hasta 5 intentos. Si Coolify se comió `${GROKBOT_WEBHOOK_KEY}` al guardar la cabecera, déjala vacía y pon solo la clave, o escribe la cabecera ya con la clave, sin `${...}`.

**WAHA responde 401.** `WAHA_API_KEY` del worker y el de WAHA no coinciden, o `WAHA_NO_API_KEY` no cuadra con la clave. La misma variable entra en los dos. Reinicia después de cambiarla.

**Audio o vídeo sin transcripción.** El mensaje lleva `mime_type`, `file_name` y `note` cuando se conocen. La primera transcripción espera a que el worker baje el modelo (`whisper.model_download` en los logs). `transcription_failed: …` significa que el archivo se bajó pero Whisper o ffmpeg falló; ese mensaje no se reintenta. `download_failed: …` significa que WAHA todavía no tenía el archivo (`media.url` vacío o la descarga falló). El worker reintenta esa descarga unas veces y, si sigue sin bytes, no manda el mensaje y no avanza el cursor por delante de él (`media.deferred`). El siguiente ciclo lo vuelve a intentar. Tras 3 ciclos lo envía con `note` `download_failed` para no bloquear el grupo. `too_large` es un archivo por encima del tope (25 MB para audio y vídeo, `MAX_INLINE_FILE_MB` para el resto). El primer arranque de `whisper` baja el modelo. Si `TRANSCRIBE_PROVIDER=openai` y no hay `OPENAI_API_KEY`, el worker avisa `transcriber.openai_key_missing`.

**Imagen o PDF sin datos.** Si `note` es `too_large`, el archivo pasa de `MAX_INLINE_FILE_MB`. Sube el tope y reinicia el worker. El JSON crece: 5 MB de archivo son unos 7 MB en base64. No hay URL ni disco donde recuperar el archivo.
