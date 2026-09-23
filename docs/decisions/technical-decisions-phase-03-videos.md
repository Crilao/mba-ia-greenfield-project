---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-23
scope_description: "Upload and video processing: object storage usage (MinIO/S3), background processing queue, 10GB upload strategy without blocking the API, video worker (FFmpeg metadata + thumbnail), unique video URL, streaming and download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, upload orchestration, streaming/download endpoints), the object-storage service, the background queue and the video worker container. Infra changes land in `nestjs-project/compose.yaml` (MinIO, Redis, worker).
- `next-frontend/` — Frontend deferred: this phase has no UI surface (the video interface is out of scope per the assignment). No open decision in this document.

---

## TD-01: Background Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Phase 03 needs a job queue to process videos asynchronously (metadata extraction + thumbnail generation). The project plan explicitly leaves the queue technology open ("TBD"). The architecture diagram and prior phases already assume a separate worker consuming jobs, and PostgreSQL is the only persistence in the stack today. The choice determines the compose infra added, the failure/retry story, and how the worker is written.

**Options:**

### Option A: BullMQ (Redis)
- Node.js library on top of Redis, with an official NestJS integration (`@nestjs/bullmq`). Jobs are durable in Redis; supports retries with backoff, stalled-job detection, concurrency, priorities, and a monitoring UI (@bull-board).
- **Pros:** Native NestJS integration (`@Processor`, `WorkerHost`) keeps DI + TypeORM available inside the worker. Battle-tested in the NestJS ecosystem. Simple to run locally (one Redis container). Automatic stalled-job recovery and retries with exponential backoff are built in.
- **Cons:** Adds Redis as a new service in the stack. Job visibility/state lives in Redis, not Postgres — needs an explicit DB status column to mirror state for the API. Redis is in-memory: durability relies on AOF/RDB unless the DB mirrors state.

### Option B: RabbitMQ
- Mature AMQP message broker. NestJS integration via `@golevelup/nestjs-rabbitmq` or `amqplib`. Supports exchanges, routing keys, and consumer acknowledgements.
- **Pros:** Strong routing/fan-out semantics, per-message ack, battle-tested in distributed systems.
- **Cons:** Heavier operational footprint (Erlang runtime, management UI, more moving parts) for a single-queue single-worker need. Weaker NestJS first-party story (community adapter). Overkill for fire-and-forget video processing.

### Option C: Kafka
- Distributed log-based event streaming. NestJS integration via `@nestjs/microservices` transport.
- **Pros:** Scales horizontally, durable by design, replay capability.
- **Cons:** Substantially heavier infrastructure (Zookeeper/KRaft, brokers). Unnecessary for a single-worker, low-volume video-processing queue at this stage. Tuning (partitions, consumer groups, retention) is production-grade complexity the phase does not need.

**Recommendation:** **BullMQ (Redis)** — For a NestJS 11 project whose worker must share DI + TypeORM and whose infra is Docker Compose, BullMQ's first-party `@nestjs/bullmq` integration, retries/backoff, and stalled-job recovery give the strongest value-per-infrastructure-cost. Redis is a small, well-understood addition; the video status cycle in Postgres mirrors queue state for the API (TD-05). RabbitMQ/Kafka buy capabilities this phase has no use for.

**Decision:** A (BullMQ / Redis)

**Libraries:** `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `ioredis@^5.x`

---

## TD-02: Upload Strategy for 10GB Files

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A single request carrying a 10GB body through the NestJS API would hold a worker thread, consume memory, and block the system — the assignment explicitly forbids this ("passar o arquivo inteiro pela API é o caminho errado"). The handshake between client, storage, and API is a cross-layer contract: the client must push bytes somewhere, the API must orchestrate the record, and the storage must receive the object. Object storage is S3-compatible (MinIO locally).

**Options:**

### Option A: Presigned multipart upload directly to object storage
- The API signs S3 multipart operations (`CreateMultipartUpload` → presigned `UploadPart` URLs → `CompleteMultipartUpload`). The client uploads each part directly to MinIO via HTTPS PUT to the presigned URLs (bypassing the API for the bytes), then tells the API to complete. S3's single-PUT limit is 5GB, so 10GB requires multipart.
- **Pros:** API never touches the file bytes — zero blocking. Resumable at part granularity (a failed part is re-signed and retried). All 10GB handled by S3 semantics (part size, ETags). Scales without API work. Presigned URLs expire, limiting the attack window.
- **Cons:** More orchestration (3-step handshake + per-part URL generation). Client is responsible for correct multipart framing (the frontend owns it; this phase documents the contract for the API side). Presigned part URLs have a validity window.

### Option B: Single presigned PUT
- API signs one `PutObject` URL; client PUTs the whole file directly to MinIO.
- **Pros:** Simplest handshake (one URL).
- **Cons:** S3 caps a single PUT at 5GB — hard limit, fails the 10GB requirement outright. No resume. Rejected.

### Option C: TUS resumable upload
- TUS protocol with a server-side endpoint (e.g., `tus-node-server`) that chunks and writes to storage; resume by offset.
- **Pros:** True interruption-resume semantics and rich client ecosystem (`tus-js-client`).
- **Cons:** Introduces a whole new protocol + server component just for upload; the S3 backend already gives resumable multipart. Higher novelty/ops cost than Option A for the same 10GB outcome.

### Option D: Multipart through the API
- Client streams multipart chunks to NestJS, API buffers to disk then uploads to MinIO.
- **Pros:** Simple client (plain fetch/multipart).
- **Cons:** API still proxies every byte — memory/CPU pressure, no real 10GB relief, needs custom chunk state. Defeats the "don't block the API" requirement. Rejected.

**Recommendation:** **Presigned multipart upload (Option A)** — It is the only option that keeps the API out of the byte path while satisfying 10GB (multipart is mandatory above the 5GB single-PUT cap) and gives part-level resume. The frontend consumes the documented handshake contract in a later phase.

**Decision:** A (Presigned multipart upload)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Video Processing & Thumbnail Generation (Worker)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After the upload completes, a worker must extract duration + metadata (codec, resolution, bitrate, size) and generate a thumbnail from a frame. FFmpeg/ffprobe is the industry-standard tool and the assignment assumes it. The open choices are how the worker invokes FFmpeg and how the worker process is packaged in Docker (a separate container).

**Options:**

### Option A: fluent-ffmpeg + ffmpeg/ffprobe installed in a dedicated worker container
- A separate `worker` service in compose runs a NestJS standalone entrypoint (reusing DI + TypeORM) that registers a BullMQ processor. The worker image installs `ffmpeg` + `ffprobe` via apt. The processor uses `fluent-ffmpeg` (`ffprobe()` for metadata, `.screenshots()` for the thumbnail), then uploads the thumbnail to MinIO and updates the video row.
- **Pros:** fluent-ffmpeg is the de-facto Node wrapper; the processor stays NestJS-native (DI, repositories, config). Dedicated container isolates heavy CPU work from the API. apt ffmpeg is a full, recent build — codec coverage for common formats.
- **Cons:** Image build time (apt ffmpeg is large). fluent-ffmpeg is callbacks/promisified — a small async wrapper is needed. Processing is CPU-bound; concurrency on the worker must be low.

### Option B: `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` bundled in the same API image
- npm-installed static binaries, no apt. The API process itself runs the job inline.
- **Pros:** No extra container; npm-managed binaries.
- **Cons:** Runs CPU-heavy FFmpeg inside the API process — exactly the blocking the phase must avoid. Static binaries are often trimmed builds with weaker codec coverage. No queue separation. Rejected for the processing step.

### Option C: Raw `child_process` invoking `ffmpeg`/`ffprobe` CLI
- No wrapper library; the worker shells out to the CLI directly and parses JSON from `ffprobe -print_format json`.
- **Pros:** Zero npm dependency for the wrapper; full control over CLI flags.
- **Cons:** Reimplements what fluent-ffmpeg already provides (spawn, arg building, events, screenshot timestamps); more glue code and error-handling surface. No real benefit over Option A for this project.

**Recommendation:** **Option A — fluent-ffmpeg inside a dedicated worker container** — It isolates the CPU-heavy processing in its own compose service (keeping the API responsive), keeps the worker NestJS-native, and reuses the proven fluent-ffmpeg API. The worker image installs `ffmpeg`/`ffprobe` via apt in a `Dockerfile.worker.dev`.

**Decision:** A (fluent-ffmpeg in dedicated worker container)

**Libraries:** `fluent-ffmpeg@^2.x`

---

## TD-04: Unique Video URL, Streaming & Download

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Each video needs a unique, collision-free identifier usable in URLs, and playback must stream (start before the full file is transferred) rather than require a full download. Two sub-choices: (a) what the unique URL is, and (b) how streaming bytes are served. Streaming can be served by proxying HTTP Range requests (206 Partial Content) through the API to MinIO, or by handing the client a presigned URL that points at MinIO directly.

**Options:**

### Option A: Short opaque slug + API-proxied Range streaming, presigned URL for download
- On completion, the API generates a short unique slug (e.g., `nanoid`/`crypto.randomBytes` base64url, ~11 chars) stored on the video row with a unique constraint. Streaming: `GET /videos/:slug/stream` parses the `Range` header, issues `GetObjectCommand` with `Range` to MinIO, and streams only the requested byte range back as `206 Partial Content` (with `Content-Range`, `Content-Length`, `Accept-Ranges`); no range → `200` full stream. Download: `GET /videos/:slug/download` returns a short-lived presigned `GetObject` URL (or streams the full object).
- **Pros:** Unique slug is collision-free by construction (unique index) and short/clean for URLs. API-proxied streaming keeps the byte path under app control (auth for unlisted/private videos later, consistent error envelope, no storage endpoint leak). Range requests are handled natively by S3, so the proxy is thin. Presigned download keeps the API from proxying a 10GB body.
- **Cons:** The proxy still moves bytes through the API for streaming (CPU/network cost per request; acceptable at this phase's scale — no CDN in scope). Slugs must be checked for uniqueness on insert (unique index handles it).

### Option B: Presigned URL streaming direct from MinIO
- The `stream`/`download` endpoints return a presigned MinIO URL; the client's `<video>` element talks to MinIO directly, and MinIO serves Range requests natively.
- **Pros:** Zero API bandwidth for the media; MinIO is already Range-capable.
- **Cons:** No app-level control over who streams (auth for unlisted videos impossible without extra signing logic); storage endpoint and bucket keys are exposed to clients; presigned URL expiry must outlive the whole video (long TTLs weaken the expiry benefit). The project's error/response envelope is bypassed for media.

**Recommendation:** **Option A — unique short slug + API-proxied Range streaming, presigned download** — The slug satisfies "URL única por vídeo, sem conflito" with a simple unique index, and API-proxied streaming keeps auth/observability in the app while delegating byte-range handling to S3. The download path uses a presigned URL so the API never proxies the full 10GB on demand.

**Decision:** A (Short slug + API-proxied Range streaming + presigned download)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-05: Video Status Lifecycle

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Ciclo de status do vídeo (rascunho → processando → pronto/erro) refletido no banco

**Context:** The video row must transition through explicit states as the upload and processing pipeline runs, and the DB is the source of truth for the API. The cycle must cover the pre-registration on upload start, the async processing window, a terminal success, and a failure path that leaves the video inspectable and retryable. How many states, who transitions them, and what happens on failure are the open choices.

**Options:**

### Option A: Five states — DRAFT → UPLOADING → PROCESSING → READY | ERROR
- `DRAFT` on pre-registration (no bytes yet); `UPLOADING` once the multipart upload is created; `PROCESSING` once the upload completes and the queue job is dispatched; `READY` when metadata + thumbnail are stored; `ERROR` when processing fails (with `processing_error` recorded and the job retried with backoff before marking ERROR). Only the API creates/transitions upload states; the worker transitions `PROCESSING → READY | ERROR`. A terminal `ERROR` row can be re-enqueued (manual retry) without changing status semantics.
- **Pros:** Precise, debuggable transitions; each phase of the pipeline is observable. Explicit `ERROR` with persisted reason supports failure investigation and re-processing. Matches the assignment's literal cycle (rascunho → processando → pronto/erro) plus an `UPLOADING` state for the direct-to-storage window.
- **Cons:** One more state than the minimal set; needs a small transition guard so the worker doesn't clobber API-side transitions (e.g., optimistic status check before processing).

### Option B: Four states — DRAFT → PROCESSING → READY | ERROR (no UPLOADING)
- Pre-registration is `DRAFT`; the moment the upload completes it flips straight to `PROCESSING`.
- **Pros:** Fewer states; simpler enum.
- **Cons:** During the direct-to-storage upload there is no "upload in progress" state, so the API can't show an accurate upload state or expire stale uploads — DRAFT is ambiguous between "never started" and "bytes in flight". Weaker observability for the exact window the presigned-multipart flow creates.

### Option C: Encode state in the queue only (no DB status column)
- Status lives in BullMQ job state; the video row is just metadata.
- **Pros:** No status column to maintain.
- **Cons:** The API (and future UI) would need to query Redis to know state — breaks the "DB is the source of truth" convention and the assignment's explicit requirement that the cycle "refletido no banco". Rejected.

**Recommendation:** **Option A — five states with an explicit ERROR + retry** — The five-state model makes each pipeline stage observable, gives the upload window its own state, and persists failure reasons for debugging and re-processing. The DB column mirrors the queue, keeping Redis as transport and Postgres as truth.

**Decision:** A (Five states DRAFT→UPLOADING→PROCESSING→READY | ERROR)

**Libraries:** —

---

## TD-06: Object Storage Organization (Bucket & Key Layout)

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The project fixes object storage as S3-compatible (MinIO locally). What this phase decides is how the storage is organized — bucket layout and key scheme — because it shapes every presigned URL, the worker's uploads, and the compose infra. It spans backend code (keys) and compose (MinIO setup), hence Repo-wide.

**Options:**

### Option A: One bucket, prefixed keys (`videos/`, `thumbnails/`)
- A single `streamtube` bucket. Video objects at `videos/{videoId}/{slug}.(ext)`; thumbnails at `thumbnails/{videoId}.jpg`. A startup/bootstrap step creates the bucket if absent (idempotent).
- **Pros:** Single bucket to provision and back up; prefix-based logical separation is idiomatic S3; lifecycle policies can target prefixes later. Simplest MinIO dev setup (one bucket, one set of credentials).
- **Cons:** Bucket-wide ACLs apply to both kinds (not an issue — both are app-controlled anyway).

### Option B: Two buckets (`videos`, `thumbnails`)
- Separate buckets per media type.
- **Pros:** Independent lifecycle/permissions per type from day one.
- **Cons:** Two buckets to provision/back up; more moving parts for zero current benefit — both types are app-private and served through the API. More bootstrap code for the same result.

**Recommendation:** **Option A — single `streamtube` bucket with `videos/` and `thumbnails/` prefixes** — It minimizes MinIO provisioning (one bucket, idempotent bootstrap) while keeping the two media kinds logically separated by prefix. If production ever needs divergent lifecycle policies, prefixes support them without a migration.

**Decision:** A (Single bucket, prefixed keys)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Queue Technology | A (BullMQ / Redis) | A |
| TD-02 | Cross-layer | Upload Strategy for 10GB | A (Presigned multipart upload) | A |
| TD-03 | Backend | Video Processing & Thumbnail | A (fluent-ffmpeg in dedicated worker container) | A |
| TD-04 | Cross-layer | Unique URL, Streaming & Download | A (Short slug + API-proxied Range streaming + presigned download) | A |
| TD-05 | Backend | Video Status Lifecycle | A (Five states DRAFT→UPLOADING→PROCESSING→READY\|ERROR) | A |
| TD-06 | Repo-wide | Object Storage Organization | A (Single bucket, prefixed keys) | A |
