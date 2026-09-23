---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-23T17:38:34-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-23T17:39:47-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T17:37:22-0300"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo de vídeos no backend NestJS com armazenamento de objetos (MinIO), fila de processamento (BullMQ/Redis) e um worker de vídeo (FFmpeg): pré-cadastro do vídeo como rascunho ao iniciar o upload, upload de até 10GB sem travar a API via multipart com URLs pré-assinadas direto ao storage, processamento automático após o upload (duração, metadados e thumbnail), URL única por vídeo, streaming por Range requests (206) e download por URL pré-assinada — tudo subindo junto no Docker Compose, com ciclo de status rascunho → processando → pronto/erro refletido no banco.

---

## Step Implementations

### SI-03.1 — Infra: fila, storage e worker no Compose + configuração

**Description:** Adiciona as dependências de fila/storage/FFmpeg, sobe Redis, MinIO e o worker no `compose.yaml`, cria a imagem do worker com ffmpeg e os namespaces de configuração + validação de env.

**Technical actions:**

1. Instalar no `nestjs-project`: `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `fluent-ffmpeg@^2` (+ `@types/fluent-ffmpeg` dev) (per `phase-03-videos/TD-01`, `TD-02`, `TD-03`).
2. Criar `src/config/minio.config.ts`, `src/config/redis.config.ts`, `src/config/videos.config.ts` (`registerAs`, padrão phase 01) e estender `env.validation.ts` com `MINIO_*`, `REDIS_*`, `STORAGE_BUCKET`, `VIDEOS_PART_SIZE`; carregar os novos factories no `ConfigModule` do `AppModule`.
3. Adicionar serviços `redis` (redis:7), `minio` (minio/minio, porta 9000 + console 9001) e `worker` ao `compose.yaml`, com healthchecks e `depends_on`; hosts usam os nomes de serviço (`redis`, `minio`).
4. Criar `Dockerfile.worker.dev` (node:25-slim + `apt-get install -y ffmpeg`) e o script `start:worker` no `package.json`.
5. `npm install` e `docker compose up -d` para subir redis/minio/worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` (novas chaves MINIO_/REDIS_/STORAGE) | Integration: schema coerce/valida | `src/config/env.validation.integration-spec.ts` |
| `minio.config` / `redis.config` / `videos.config` | Unit: defaults + coerção | `src/config/*.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose config` valida; serviços `redis`, `minio` e `worker` presentes; `docker compose ps` mostra os três running/healthy.
- `docker compose exec worker ffmpeg -version` e `ffprobe -version` respondem na imagem do worker.
- `env.validation` aceita `MINIO_ENDPOINT`, `REDIS_HOST`, `STORAGE_BUCKET` sem erro.

---

### SI-03.2 — Entity Video + migration

**Description:** Cria a entidade `Video` ligada ao canal com enum de status, slug único e a migration versionada criando a tabela `videos`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — colunas conforme `### Data Model` (`id`, `channel_id` FK→`channels.id` CASCADE, `title`, `description`, `status` enum, `slug` único, `storage_key`, `thumbnail_key`, `mime_type`, `size_bytes`, `upload_id`, `duration_seconds`, `metadata` jsonb, `processing_error`, timestamps) (per `phase-03-videos/TD-04`, `TD-05`, `TD-06`).
2. Criar a migration `<timestamp>-CreateVideos.ts` via `npm run migration:generate` (enum `video_status`, tabela `videos`, índice único em `slug`, FK para `channels`).
3. Criar esqueleto `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar `VideosModule` no `AppModule`.
4. Rodar `npm run migration:run`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: constraints, defaults, UNIQUE slug, FK | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `migration:run` cria a tabela `videos` com o enum `video_status` e índice único em `slug`.
- Novo vídeo persiste com `status` default `'draft'` e `title` default `''`.
- Inserir dois vídeos com o mesmo `slug` viola a constraint UNIQUE.

---

### SI-03.3 — Object Storage service (MinIO)

**Description:** Serviço de armazenamento sobre o AWS SDK v3 apontando para o MinIO: bootstrap idempotente do bucket e geração de URLs pré-assinadas (multipart e get).

**Technical actions:**

1. Criar `src/videos/storage/object-storage.service.ts` — `S3Client` com `forcePathStyle: true`, `endpoint`/credenciais do `minio.config`; métodos `ensureBucket()`, `headObject(key)`, `getObjectStream(key, range)`, `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `presignGetObject(key, disposition)` (per `phase-03-videos/TD-02`, `TD-04`, `TD-06`).
2. Criar `src/videos/storage/storage.constants.ts` (token de injeção do client).
3. Registrar `ObjectStorageService` no módulo (exportado para o worker) e chamar `ensureBucket()` no `onModuleInit` (idempotente).
4. Adicionar `src/config/minio.config.ts` (se não criado em SI-03.1) — endpoint, credenciais, bucket, região.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ObjectStorageService` | Integration: MinIO real (ensureBucket idempotente, head, get com Range, presign PUT/GET round-trip) | `src/videos/storage/object-storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `ensureBucket()` cria `streamtube` na primeira chamada e não falha nas seguintes (idempotente).
- `presignUploadPart` retorna URL com `X-Amz-*`; um PUT de part com essa URL persiste o objeto no MinIO; `headObject` reflete o tamanho.
- `getObjectStream(key, 'bytes=0-1023')` retorna apenas o intervalo solicitado.

---

### SI-03.4 — VideosModule: pré-cadastro (POST /videos) + slug

**Description:** Módulo de vídeos com o pré-cadastro do vídeo como rascunho ao iniciar o upload e geração de slug único por vídeo.

**Technical actions:**

1. Criar `src/videos/slug.util.ts` — `generateVideoSlug()` via `crypto.randomBytes(8).toString('base64url')` (~11 chars) com retry em colisão na UNIQUE (per `phase-03-videos/TD-04`).
2. Criar `src/videos/dto/create-video.dto.ts` — `title?`, `mimeType` (`@IsString`), `sizeBytes` (`@IsInt`, `@Min(1)`, `@Max(10 * 1024**3)`) (class-validator, padrão phase 02).
3. Criar `src/videos/videos.service.ts` — `createDraft(channelId, dto)`: valida mimeType, gera slug com retry, salva `status: 'draft'` (per `phase-03-videos/TD-05`).
4. Criar `src/videos/videos.controller.ts` — `POST /videos` (JWT; vincula ao canal do usuário autenticado via `CurrentUser`), resposta 201 conforme `### API Contracts`.
5. Registrar `VideosModule` no `AppModule` (controller + service + `TypeOrmModule.forFeature([Video])`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: slug retry em colisão, validação mimeType/size | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB contract (cria draft, UNIQUE slug, status) | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: `POST /videos` auth + 201 + validation | `src/videos/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` autenticado retorna `201` com `status: "draft"` e `slug` não-vazio.
- `POST /videos` sem token retorna `401`.
- `POST /videos` com `sizeBytes` > 10GB retorna `400` `VALIDATION_ERROR`.
- Nenhum par de vídeos compartilha `slug`.

---

### SI-03.5 — Upload flow: initiate + complete + fila

**Description:** Fluxo de upload multipart pré-assinado — endpoints `initiate` e `complete` — e o producer da fila BullMQ que dispara o processamento.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` (`partSize?`) e `src/videos/dto/complete-upload.dto.ts` (`uploadId`, `parts: [{partNumber, etag}]`).
2. `videos.service.ts` — `initiateUpload(videoId, channelId, partSize)`: valida status `draft` e dono, `createMultipartUpload` + `presignUploadPart` por part, salva `upload_id` + `storage_key`, transição → `uploading` (per `phase-03-videos/TD-02`, `TD-05`).
3. `videos.service.ts` — `completeUpload(videoId, channelId, {uploadId, parts})`: valida `uploadId` (senão `VIDEO_UPLOAD_MISMATCH`), `completeMultipartUpload`, transição → `processing`.
4. Criar `src/videos/queues/videos-queue.service.ts` — `@InjectQueue('video-processing')`, `enqueueProcess(videoId)` com `attempts: 3`, backoff exponencial, `removeOnComplete/removeOnFail` (per `phase-03-videos/TD-01`).
5. Registrar `BullModule.registerQueue({ name: 'video-processing' })` no módulo; adicionar `POST /videos/:id/upload/initiate` e `POST /videos/:id/upload/complete` ao controller (owner check).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: transições de status, `VIDEO_UPLOAD_MISMATCH`, dono | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB contract + enqueue real (Redis) | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `BullModule.registerQueue` | `src/videos/videos.module.spec.ts` |
| `VideosController` | E2E: initiate/complete + auth + 409/400 | `src/videos/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/upload/initiate` em `draft` retorna `201` com `uploadId`, `partSize`, `partCount` e `partUrls` pré-assinadas; status → `uploading`.
- `POST /videos/:id/upload/initiate` em vídeo não-`draft` retorna `409` `VIDEO_STATUS_CONFLICT`; por outro dono retorna `403` `VIDEO_FORBIDDEN`.
- `POST /videos/:id/upload/complete` com `uploadId` correto retorna `200` com `status: "processing"` e enfileira o job `process-video`.
- `POST /videos/:id/upload/complete` com `uploadId` divergente retorna `400` `VIDEO_UPLOAD_MISMATCH`.

---

### SI-03.6 — Worker: processador FFmpeg + entrypoint

**Description:** Worker BullMQ (container separado) que baixa o vídeo do storage, extrai duração/metadados via ffprobe, gera thumbnail via ffmpeg, publica no MinIO e transiciona `processing → ready | error`.

**Technical actions:**

1. Criar `src/videos/processing/video-processing.service.ts` — fluent-ffmpeg: `ffprobe()` → `duration_seconds` + `metadata` (codec, resolução, bitrate); `.screenshots()` → thumbnail JPEG temporário; upload do thumbnail ao MinIO (`thumbnails/{id}.jpg`) (per `phase-03-videos/TD-03`).
2. Criar `src/videos/processing/video.processor.ts` — `@Processor('video-processing')`, `process(job)`: carrega o vídeo, valida status `processing`, baixa o stream do storage para arquivo temporário, processa, atualiza `duration_seconds`/`metadata`/`thumbnail_key`/`status=ready`; em falha, re-throws para o retry do BullMQ; na tentativa final (falha exaustiva) marca `status=error` + `processing_error` (per `phase-03-videos/TD-05`).
3. Criar `src/worker/worker.module.ts` — `ConfigModule`, `TypeOrmModule.forRootAsync` (mesmos factory do AppModule), `TypeOrmModule.forFeature([Video])`, `BullModule.forRoot` + `registerQueue('video-processing')`, providers (processor, storage, processing service).
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` (sem HTTP listener).
5. Ajustar `start:worker` para rodar `src/worker.ts` (ex.: `nest start` com entry point próprio) e subir o serviço `worker` no Compose.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: mock ffmpeg/storage → retorna duration/thumbnail | `src/videos/processing/video-processing.service.spec.ts` |
| `VideoProcessor` | Integration: job end-to-end real (MinIO + Redis + ffmpeg no worker) | `src/videos/processing/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- Um job `process-video` real deixa o vídeo `ready`, com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos e o thumbnail presente no MinIO.
- Falha exaustiva (retries esgotados) deixa o vídeo `error` com `processing_error` persistido.
- O processamento roda no serviço `worker` (não na API).

---

### SI-03.7 — Streaming e thumbnail (GET /videos/:slug/stream, /thumbnail, /videos/:slug)

**Description:** Reprodução via streaming por Range requests (206 Partial Content) e proxy da thumbnail, mais o endpoint de metadata por slug (URL única).

**Technical actions:**

1. `videos.service.ts` — `findBySlug(slug)` e `streamObject(key, range)` via `getObjectStream` do storage (per `phase-03-videos/TD-04`).
2. `videos.controller.ts` — `GET /videos/:slug/stream`: parse do `Range`, `headObject` para o tamanho total, `getObjectStream` com `Range`, responde `206` com `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`; sem `Range` → `200`; `start >= size` → `416`.
3. `videos.controller.ts` — `GET /videos/:slug/thumbnail`: proxy dos bytes da thumbnail (`Content-Type: image/jpeg`).
4. `videos.controller.ts` — `GET /videos/:slug`: metadata (`title`, `status`, `durationSeconds`, `thumbnailUrl`, `mimeType`, `sizeBytes`).
5. Lançar `VIDEO_NOT_FOUND` (slug inexistente) e `STORAGE_UNAVAILABLE` (falha de storage) como `DomainException`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E: stream `206` com Range, `200` sem Range, thumbnail `200`, metadata por slug, `404` | `src/videos/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `GET /videos/:slug/stream` com `Range: bytes=0-1023` retorna `206` com `Content-Range: bytes 0-1023/{total}` e `Accept-Ranges: bytes`.
- `GET /videos/:slug/stream` sem `Range` retorna `200`.
- `GET /videos/:slug/thumbnail` retorna `200` com `Content-Type: image/jpeg`.
- `GET /videos/:slug` de vídeo inexistente retorna `404` `VIDEO_NOT_FOUND`.

---

### SI-03.8 — Download pré-assinado + OpenAPI + catálogo de erros

**Description:** Endpoint de download por URL pré-assinada, decorators OpenAPI nos endpoints de vídeo e o catálogo de erros do módulo.

**Technical actions:**

1. `videos.service.ts` — `presignDownload(slug)`: `presignGetObject` com `ResponseContentDisposition: attachment; filename=...` (per `phase-03-videos/TD-04`).
2. `videos.controller.ts` — `GET /videos/:slug/download` → `{ url }` (200).
3. Aplicar decorators `@ApiTags('videos')`, `@ApiResponse`/`@ApiOperation` nos endpoints (padrão OpenAPI do projeto, `@nestjs/swagger`).
4. Mapear `VIDEO_NOT_FOUND`/`VIDEO_FORBIDDEN`/`VIDEO_STATUS_CONFLICT`/`VIDEO_UPLOAD_MISMATCH`/`STORAGE_UNAVAILABLE` como `DomainException` no módulo (catálogo `### Error Catalog`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosController` | E2E: download retorna URL `X-Amz-*` assinada | `src/videos/videos.e2e-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `GET /videos/:slug/download` retorna `{ "url" }` com query `X-Amz-*` e `response-content-disposition=attachment`.
- O schema OpenAPI exportado (`openapi:export`) lista os endpoints de vídeo sob a tag `videos`.

---

## Technical Specifications

### Data Model

**Entity `Video`** (`videos` table, `src/videos/entities/video.entity.ts`)

| Field | Type | Constraints |
|-------|------|-------------|
| `id` | uuid | PK, default `gen_random_uuid()` |
| `channel_id` | uuid | NOT NULL, FK → `channels.id` ON DELETE CASCADE, indexed |
| `title` | varchar(255) | NOT NULL, default `''` |
| `description` | text | NULL |
| `status` | enum(`draft`,`uploading`,`processing`,`ready`,`error`) | NOT NULL, default `'draft'` |
| `slug` | varchar(64) | NOT NULL, UNIQUE (per-video unique URL, TD-04) |
| `storage_key` | varchar(512) | NULL (set on upload initiate; `videos/{id}/{filename}`) |
| `thumbnail_key` | varchar(512) | NULL (set by worker; `thumbnails/{id}.jpg`) |
| `mime_type` | varchar(255) | NOT NULL |
| `size_bytes` | bigint | NOT NULL, default `0` |
| `upload_id` | varchar(512) | NULL (S3 multipart `UploadId`, TD-02) |
| `duration_seconds` | double precision | NULL (set by worker via ffprobe, TD-03) |
| `metadata` | jsonb | NULL (codec, resolution, bitrate — worker, TD-03) |
| `processing_error` | text | NULL (persisted reason on `error`, TD-05) |
| `created_at` | timestamp | NOT NULL default now() |
| `updated_at` | timestamp | NOT NULL default now() |

**Status enum (`video_status`):** `draft` → `uploading` → `processing` → `ready` | `error` (TD-05). Only the API transitions upload states; only the worker transitions `processing → ready | error`.

**Storage layout (TD-06):** single `streamtube` bucket; `videos/{id}/{slug}.{ext}` and `thumbnails/{id}.jpg`.

### API Contracts

_All response errors follow the inherited `{ statusCode, error, message }` envelope (phase-02-auth/TD-07). Auth via inherited JWT guard (`@Public()` decorator marks anonymous routes)._

**POST /videos** — pre-register the video as draft (TD-05).
- Auth: JWT (channel owner).
- Body: `{ "title"?: string, "mimeType": string, "sizeBytes": number }`
- 201 → `{ "id", "channelId", "title", "slug", "status": "draft", "mimeType", "sizeBytes" }`
- Errors: `VALIDATION_ERROR` (400).

**POST /videos/:id/upload/initiate** — create multipart upload + presign part URLs (TD-02).
- Auth: JWT (owner of `:id`).
- Body: `{ "partSize"?: number }` (default `100 * 1024 * 1024`; part count = ceil(size/partSize)).
- 201 → `{ "id", "uploadId", "partSize", "partCount", "partUrls": [{ "partNumber": 1, "url": "..." }, ...] }`; video status → `uploading`.
- Errors: `VIDEO_NOT_FOUND` (404), `VIDEO_FORBIDDEN` (403), `VIDEO_STATUS_CONFLICT` (409 — not `draft`).

**POST /videos/:id/upload/complete** — complete multipart + enqueue processing (TD-02, TD-01).
- Auth: JWT (owner of `:id`).
- Body: `{ "uploadId": "string", "parts": [{ "partNumber": 1, "etag": "..." }, ...] }`
- 200 → `{ "id", "status": "processing" }`; video status → `processing`; job `process-video` added to queue `video-processing`.
- Errors: `VIDEO_NOT_FOUND` (404), `VIDEO_FORBIDDEN` (403), `VIDEO_UPLOAD_MISMATCH` (400 — `uploadId` does not match), `VIDEO_STATUS_CONFLICT` (409 — not `uploading`).

**GET /videos/:slug** — video metadata (URL única, TD-04).
- Auth: anonymous.
- 200 → `{ "id", "slug", "channelId", "title", "status", "durationSeconds", "thumbnailUrl", "mimeType", "sizeBytes" }`
- Errors: `VIDEO_NOT_FOUND` (404).

**GET /videos/:slug/stream** — Range streaming (TD-04).
- Auth: anonymous.
- Behavior: parses `Range` header; `GetObjectCommand` with `Range` to MinIO; responds `206 Partial Content` with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`; no `Range` → `200` full stream; `start >= size` → `416` with `Content-Range: bytes */size`.
- Errors: `VIDEO_NOT_FOUND` (404), `STORAGE_UNAVAILABLE` (502).

**GET /videos/:slug/thumbnail** — thumbnail bytes.
- Auth: anonymous.
- 200 → image bytes (JPEG) with `Content-Type: image/jpeg`.
- Errors: `VIDEO_NOT_FOUND` (404), `STORAGE_UNAVAILABLE` (502).

**GET /videos/:slug/download** — presigned download URL (TD-04).
- Auth: anonymous.
- 200 → `{ "url": "https://minio/...?X-Amz-..." }` (short-lived presigned `GetObject`, `ResponseContentDisposition: attachment`).
- Errors: `VIDEO_NOT_FOUND` (404), `STORAGE_UNAVAILABLE` (502).

### Authorization Matrix

| Endpoint | Auth | Access rule |
|----------|------|-------------|
| POST /videos | JWT | Any authenticated user; the video is bound to the caller's channel |
| POST /videos/:id/upload/initiate | JWT | Owner of the video's channel (`channel_id == caller.channel.id`) |
| POST /videos/:id/upload/complete | JWT | Owner of the video's channel |
| GET /videos/:slug | Anonymous | Public |
| GET /videos/:slug/stream | Anonymous | Public |
| GET /videos/:slug/thumbnail | Anonymous | Public |
| GET /videos/:slug/download | Anonymous | Public |

### Error Catalog

| `errorCode` | HTTP | When |
|-------------|------|------|
| `VALIDATION_ERROR` | 400 | Global ValidationPipe rejection (inherited from phase 02) |
| `VIDEO_NOT_FOUND` | 404 | `:id`/`:slug` resolves to no video |
| `VIDEO_FORBIDDEN` | 403 | Authenticated user is not the video's channel owner |
| `VIDEO_STATUS_CONFLICT` | 409 | Transition not allowed from current status (e.g., initiate on non-`draft`) |
| `VIDEO_UPLOAD_MISMATCH` | 400 | `uploadId` on complete does not match the stored one |
| `STORAGE_UNAVAILABLE` | 502 | Object storage call fails (connect/put/get/head) |

### Events/Messages

**Queue:** `video-processing` (BullMQ, TD-01). **Job:** `process-video` with payload `{ "videoId": string }`.

**Producers:** `POST /videos/:id/upload/complete` adds the job (after DB transition to `processing`). **Consumer:** `VideoProcessor` (`@Processor('video-processing')`, TD-03) in the worker container.

**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 50`.

**Lifecycle / status transitions (TD-05):**

```
draft ──(initiate)──> uploading ──(complete + enqueue)──> processing ──(worker ok)──> ready
                                                              └──(worker fail after retries)──> error
```

**Failure handling:** the worker updates `status → error` and persists the message in `processing_error` only after BullMQ exhausts its retries (final attempt). A `ready`/`error` row can be re-processed manually by enqueueing `process-video` again.

---

## Dependency Map

SI-03.1 (root — infra: deps, compose, config)
├── SI-03.2 — depends on SI-03.1 (entity/migration after infra)
├── SI-03.3 — depends on SI-03.1 (storage service after infra)
│   └── SI-03.4 — depends on SI-03.2, SI-03.3 (module + pre-register; entity must exist)
│       └── SI-03.5 — depends on SI-03.4 (upload flow; service + queue must exist)
│           ├── SI-03.6 — depends on SI-03.3, SI-03.5 (worker; storage + queue producer)
│           └── SI-03.7 — depends on SI-03.5 (streaming; upload flow must exist)
│               └── SI-03.8 — depends on SI-03.7 (download + OpenAPI + errors)

---

## Deliverables

- [ ] SI-03.1 — Infra: fila, storage e worker no Compose + configuração
- [ ] SI-03.2 — Entity Video + migration
- [ ] SI-03.3 — Object Storage service (MinIO)
- [ ] SI-03.4 — VideosModule: pré-cadastro (POST /videos) + slug
- [ ] SI-03.5 — Upload flow: initiate + complete + fila
- [ ] SI-03.6 — Worker: processador FFmpeg + entrypoint
- [ ] SI-03.7 — Streaming e thumbnail (GET /videos/:slug/stream, /thumbnail, /videos/:slug)
- [ ] SI-03.8 — Download pré-assinado + OpenAPI + catálogo de erros

**Full test suites:**

- [ ] Backend unit/integration tests pass (`cd nestjs-project && npm test`)
- [ ] Backend integration tests pass (`cd nestjs-project && npm run test:integration`)
- [ ] E2E tests pass (`cd nestjs-project && npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && npm run lint`)
- [ ] Migration runner verified: `npm run migration:run` aplica a tabela `videos` sem erro
