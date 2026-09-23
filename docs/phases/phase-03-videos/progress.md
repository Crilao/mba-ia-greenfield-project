# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Infra: fila, storage e worker no Compose + configuração
- **Status:** completed
- **Tests:** config/env validation specs green (unit + integration)
- **Observations:**
  - Dependências instaladas: `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `fluent-ffmpeg@^2`.
  - `compose.yaml` ganhou `redis`, `minio` (quay.io/minio/minio) e `worker`; imagem do worker (`Dockerfile.worker.dev`) instala `ffmpeg`; API dev (`Dockerfile.dev`) também ganhou `ffmpeg` para os testes de integração exercerem o processamento real.
  - Portas de host remapeadas porque `5432`/`6379` estavam ocupadas por outro projeto local (`support-cms`): db `5433`, redis `6380`, minio `9000`/`9001`. Conexões internas usam os nomes de serviço.
  - Env vars de dev (JWT_SECRET etc.) passaram a ser injetadas via `compose.yaml` `x-streamtube-env` (compose sobrepõe dotenv; `.env` não está commitado).

### SI-03.2 — Entity Video + migration
- **Status:** completed
- **Tests:** entity integration spec green (defaults, UNIQUE slug, FK, bigint/jsonb)
- **Observations:**
  - `CreateVideos1790198954609` cria a tabela `videos`, enum `video_status` e FK para `channels`. Migração aplicada via `migration:run`.
  - A primeira geração capturou todo o schema porque o banco estava vazio; foi preciso aplicar as migrations 01/02 antes de regenerar apenas a diff da tabela `videos`.

### SI-03.3 — Object Storage service (MinIO)
- **Status:** completed
- **Tests:** object storage integration spec green (bucket idempotente, multipart round-trip via part URL, range get, presigned GET)
- **Observations:**
  - `ObjectStorageModule` fornece `S3Client` (`forcePathStyle`, endpoint/credenciais do `minio.config`) e exporta `ObjectStorageService`.
  - `uploadFile` lê o arquivo em Buffer (evita crash por stream ENOENT no worker).

### SI-03.4 — VideosModule: pré-cadastro (POST /videos) + slug
- **Status:** completed
- **Tests:** service unit + integration + e2e green (201 draft + slug único, 401 sem token, 400 >10GB)
- **Observations:**
  - Resposta de `POST /videos` mapeada para camelCase (`channelId`, `mimeType`, `sizeBytes`) conforme contrato.
  - Slug via `crypto.randomBytes(8).toString('base64url')` com retry na UNIQUE.

### SI-03.5 — Upload flow: initiate + complete + fila
- **Status:** completed
- **Tests:** service unit + integration + module compilation + e2e green (initiate/complete, 403/409/400, job enfileirado)
- **Observations:**
  - `VideosQueueService` usa `@InjectQueue('video-processing')`; job `process-video` com `attempts: 3`, backoff exponencial.
  - Throttler global: `@SkipThrottle()` aplicado nos endpoints de mídia (stream/thumbnail/download).

### SI-03.6 — Worker: processador FFmpeg + entrypoint
- **Status:** completed
- **Tests:** processing service integration + processor integration green (ready com duração/metadados/thumbnail; error com `processing_error` na tentativa final)
- **Observations:**
  - `WorkerModule` (aplicação standalone via `src/worker.ts`) registra `@Processor('video-processing')`; precisa de `forFeature([Video, Channel, User])` para resolver as relações TypeORM.
  - Thumbnail gerado no frame `t=0` (timestamp 1 falhava em vídeos de exatamente 1s).
  - Worker roda no container `worker` com `restart: unless-stopped`.

### SI-03.7 — Streaming e thumbnail (GET /videos/:slug/stream, /thumbnail, /videos/:slug)
- **Status:** completed
- **Tests:** e2e green (206 com Range, 200 sem Range, thumbnail JPEG, metadata por slug, 404)
- **Observations:**
  - Range parsing em `range.util.ts`; `GET /videos/:slug/stream` responde `206` com `Content-Range`/`Accept-Ranges` via proxy ao MinIO.

### SI-03.8 — Download pré-assinado + OpenAPI + catálogo de erros
- **Status:** completed
- **Tests:** e2e green (download retorna URL `X-Amz-*` com `response-content-disposition`); OpenAPI decorators nos endpoints
- **Observations:**
  - `DomainException`s do módulo em `videos.exceptions.ts` (`VIDEO_NOT_FOUND`, `VIDEO_FORBIDDEN`, `VIDEO_STATUS_CONFLICT`, `VIDEO_UPLOAD_MISMATCH`, `STORAGE_UNAVAILABLE`).

## Out-of-scope observations

- O frontend (`next-frontend/`) não foi tocado; os contratos de upload multipart e streaming ficam documentados no plano para a fase do player.
- `support-cms` (outro projeto) ocupa 5432/6379; o StreamTube foi remapeado — se os dois rodarem juntos, mantenha os mapeamentos de host atuais.
