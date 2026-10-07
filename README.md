# wa-ingest-grok

Collects messages from **one WhatsApp group** and POSTs them, raw, to a webhook. Audio and video are transcribed. Images, PDFs, and other files are uploaded to S3-compatible storage and replaced with a URL. The service does not classify or interpret what the messages mean.

It is a Node.js 20 + TypeScript worker, deployed with `docker-compose` (Coolify or any other Compose host). There is no UI.

## What a cycle does

Every `INTERVAL_MINUTES` (default 5) the worker:

1. Reads messages for `WAHA_GROUP_ID` from WAHA since the stored cursor.
2. Leaves text as-is, with the sender, an ISO timestamp, and `reply_to` when the message is a reply.
3. Downloads voice notes and other audio and transcribes them with OpenAI Whisper (`whisper-1`). The transcriber sits behind a `Transcriber` interface (`src/media/transcriber.ts`).
4. For video, extracts the audio track with ffmpeg and transcribes that. Frames are not analyzed.
5. Uploads images, PDFs, and other files to `STORAGE_*` and sends a presigned URL. PDFs also get their text via `pdf-parse`.
6. If a message's **text** contains a configured alias (`REPO_ALIASES`, for example `#plataforma=jreyessn/plataforma_tm`), sets `repo` on the batch. Transcripts are not scanned.
7. POSTs the batch. Sends nothing when there are no new messages.

The first cycle only records "now" in the cursor and does not replay group history. Later cycles forward messages newer than that mark. The cursor is `DATA_DIR/cursor.json` (a volume in Compose). `batch_id` is a SHA-256 of the group id and message ids, so a retry of the same messages is the same batch. The POST also sends `Idempotency-Key: <batch_id>`. Failures retry with backoff (1s, 2s, 4s, 8s, up to 5 attempts) for network errors, HTTP 429, and HTTP 5xx. The cursor moves only after a successful POST.

## Webhook body

```json
{
  "source": "whatsapp",
  "group": "120363012345678901@g.us",
  "repo": "jreyessn/plataforma_tm",
  "batch_id": "…sha256…",
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

`repo` is omitted when no alias matches. `type` is `text`, `audio`, `video`, `image`, or `document`.

Default request header: `Authorization: Bearer ${GROKBOT_WEBHOOK_KEY}`. Override the name and value with `GROKBOT_WEBHOOK_HEADER`. A value without a colon is used as the header name, and the key is the value.

## WAHA API

Calls follow the current WAHA docs (not guessed paths):

| Use | Method and path | Docs |
| --- | --- | --- |
| Create session | `POST /api/sessions` | [Sessions](https://waha.devlike.pro/docs/how-to/sessions/) |
| Start session (idempotent) | `POST /api/sessions/{session}/start` | [Sessions](https://waha.devlike.pro/docs/how-to/sessions/) |
| Session status | `GET /api/sessions/{session}` | [Sessions](https://waha.devlike.pro/docs/how-to/sessions/) |
| QR raw value | `GET /api/{session}/auth/qr?format=raw` | [Sessions](https://waha.devlike.pro/docs/how-to/sessions/) |
| List groups | `GET /api/{session}/groups` | [Groups](https://waha.devlike.pro/docs/how-to/groups/) |
| Read history | `GET /api/{session}/chats/{chatId}/messages?downloadMedia=true&filter.timestamp.gte=` | [Chats](https://waha.devlike.pro/docs/how-to/chats/) |
| One message, with media | `GET /api/{session}/chats/{chatId}/messages/{messageId}?downloadMedia=true` | [Chats](https://waha.devlike.pro/docs/how-to/chats/) |
| Download a file | `GET` the `media.url`, header `X-Api-Key` | [Receive messages](https://waha.devlike.pro/docs/how-to/receive-messages/) |

`filter.timestamp.gte` is inclusive, so the cursor also stores the message ids at the newest timestamp. Group senders are taken from `participant` (or the engine's `_data` sender) because `from` on a group message is the group id (`…@g.us`). `@s.whatsapp.net` is normalized to `@c.us`.

The Compose file sets `WAHA_BASE_URL=http://waha:3000` so `media.url` is reachable on the Docker network. URLs that still point at `/api/files/` on another host are rewritten to `WAHA_URL`.

## Coolify

1. Push this repo and create a Coolify resource from **Docker Compose**. Point it at `docker-compose.yml`.
2. Add the variables from `.env.example`. For a private deployment set a long random `WAHA_API_KEY` and `WAHA_NO_API_KEY=false`. The same key is passed to WAHA and the worker (`X-Api-Key`).
3. Set `GROKBOT_WEBHOOK_URL`, `GROKBOT_WEBHOOK_KEY`, `OPENAI_API_KEY`, and the `STORAGE_*` values. `WAHA_GROUP_ID` can wait until after you scan the QR and list groups.
4. Deploy. Coolify keeps the named volumes `waha-sessions`, `waha-media`, and `worker-data`. The session survives restarts, and the cursor lives in `worker-data`.
5. WAHA is not published on a host port. Talk to it through the worker container.

`devlikeapro/waha:latest` uses the WEBJS engine unless you set `WHATSAPP_DEFAULT_ENGINE`. WEBJS needs the `shm_size: 2gb` already set in the compose file. A smaller image is `devlikeapro/waha:gows` with `WHATSAPP_DEFAULT_ENGINE=GOWS`; the paths above are the same on GOWS.

The worker stays up when `WAHA_GROUP_ID` or `GROKBOT_WEBHOOK_URL` is still empty, so you can open a shell in it. It logs `worker.waiting_for_config` until both are set. Restart the worker after you change them.

## QR login

WhatsApp shows the pairing QR only while the session status is `SCAN_QR_CODE`, and the code rotates. The worker prints a fresh code in its logs when it sees that status. For a code you can scan immediately:

```bash
docker compose exec worker npm run login
```

In Coolify, open a terminal on the **worker** service and run `npm run login`.

Then on the phone: WhatsApp → Settings → Linked devices → Link a device, and scan the terminal QR. The command exits when the session status is `WORKING`. Session files are stored in the `waha-sessions` volume (`/app/.sessions` inside WAHA), so you should not need to scan again after a restart.

## Pick the group

```bash
docker compose exec worker npm run groups
```

Prints one group per line: `id<TAB>name`. Copy the id (`…@g.us`) into `WAHA_GROUP_ID`, restart the worker, and it will poll that group only.

Run one cycle without waiting for the interval:

```bash
docker compose exec worker npm run once
```

The first `once` after an empty cursor only baselines "now". A later `once`, or the interval loop, sends what arrived after that.

To re-baseline and drop the backlog, delete `/data/cursor.json` in the worker volume and restart.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `WAHA_URL` | no | Default `http://localhost:3000`. Compose sets `http://waha:3000`. |
| `WAHA_API_KEY` | when WAHA auth is on | Sent as `X-Api-Key`. |
| `WAHA_NO_API_KEY` | no | Passed to the WAHA container. `true` disables its generated key. |
| `WAHA_SESSION` | no | Default `default`. |
| `WAHA_GROUP_ID` | to forward | Group id from `npm run groups`. |
| `INTERVAL_MINUTES` | no | Default `5`. |
| `OPENAI_API_KEY` | to transcribe | Whisper. Without it, audio and video are still forwarded with `transcript: null`. |
| `GROKBOT_WEBHOOK_URL` | to forward | POST target. |
| `GROKBOT_WEBHOOK_KEY` | with the default header | Substituted into the header template. |
| `GROKBOT_WEBHOOK_HEADER` | no | Default `Authorization: Bearer ${GROKBOT_WEBHOOK_KEY}`. |
| `STORAGE_ENDPOINT` | for non-AWS | R2 or MinIO endpoint. Omit for AWS. |
| `STORAGE_REGION` | no | Default `auto`. |
| `STORAGE_BUCKET` | to upload | |
| `STORAGE_ACCESS_KEY_ID` | to upload | |
| `STORAGE_SECRET_ACCESS_KEY` | to upload | |
| `STORAGE_FORCE_PATH_STYLE` | no | Default `true` when `STORAGE_ENDPOINT` is set. |
| `STORAGE_PREFIX` | no | Default `wa-ingest/`. |
| `STORAGE_URL_EXPIRES_SECONDS` | no | Presign lifetime. Default 7 days. |
| `REPO_ALIASES` | no | `alias=owner/repo` pairs, comma-separated. |
| `DATA_DIR` | no | Default `/data`. |
| `WHATSAPP_DEFAULT_ENGINE` | no | WAHA container only. Default `WEBJS`. |

Audio and video are not uploaded. Whisper rejects files over 25MB; downloads over 50MB are skipped and the message is still sent without a transcript or URL. One failed attachment does not drop the rest of the batch.

Logs are single-line JSON on stdout and stderr (`msg`, `level`, `batch_id`, ids, statuses). Message bodies and secrets are not logged.

## Local development

```bash
npm install
npm test
npm run build
```

`npm run login`, `npm run groups`, and `npm run once` run the compiled `dist/` files, which is what the container runs. Build first.

Copy `.env.example` to `.env` and export it before the CLI commands if you are not using Compose. `docker compose up --build` starts WAHA and the worker together.
