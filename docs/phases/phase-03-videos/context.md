---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-23T17:19:00-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T17:27:32-0300"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-23T17:19:00-0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-23T17:19:00-0300"
  docs/phases/phase-02-auth/context.md: "2026-09-23T17:19:00-0300"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-09-23T17:19:00-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade pública/unlisted, painel de gerenciamento do canal, página pública do canal (Fase 04); página de visualização com player (Fase 05); comentários, likes, inscrições (Fase 06); home/busca (Fase 07). Interface de vídeo no `next-frontend/` não faz parte do escopo desta fase (entrega é backend + infra + worker).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface de vídeo (upload, player, download) fica diferida; o frontend consumirá o contrato da fase numa fase futura.

**Sequencing notes:** Depends on Fase 01 (Configuração Base) e Fase 02 (Auth). Todo usuário tem um canal (1:1) criado no cadastro; os vídeos pertencem a um canal. A arquitetura-alvo já prevê Object Storage (S3/MinIO), fila e worker como parte desta fase.

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta (prior) — fornece o canal dono do vídeo e o guard JWT.
- **Fase 04:** Gerenciamento de Vídeos e Canal (next) — edição de vídeo, visibilidade, painel.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Queue Technology | decided | A (BullMQ / Redis) | bullmq@^5.x, @nestjs/bullmq@^11.x, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Strategy for 10GB | decided | A (Presigned multipart upload) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Video Processing & Thumbnail (Worker) | decided | A (fluent-ffmpeg in dedicated worker container) | fluent-ffmpeg@^2.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Cross-layer | Unique URL, Streaming & Download | decided | A (Short slug + API-proxied Range streaming + presigned download) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (Five states DRAFT→UPLOADING→PROCESSING→READY\|ERROR) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Repo-wide | Object Storage Organization | decided | A (Single bucket, prefixed keys) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 |

## Decisions Detail

_(current-scope TDs — decided)_

### phase-03-videos/TD-01

**Recommendation:** BullMQ (Redis) — For a NestJS 11 project whose worker must share DI + TypeORM and whose infra is Docker Compose, BullMQ's first-party `@nestjs/bullmq` integration, retries/backoff, and stalled-job recovery give the strongest value-per-infrastructure-cost. Redis is a small addition; the video status cycle in Postgres mirrors queue state for the API (TD-05). RabbitMQ/Kafka buy capabilities this phase has no use for.
**Decision:** A (BullMQ / Redis)
**Libraries:** bullmq@^5.x, @nestjs/bullmq@^11.x, ioredis@^5.x

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart upload (direct to object storage) — Only option that keeps the API out of the byte path while satisfying 10GB (multipart is mandatory above the 5GB single-PUT cap) and gives part-level resume. The frontend consumes the documented handshake contract in a later phase.
**Decision:** A (Presigned multipart upload)
**Libraries:** @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x

### phase-03-videos/TD-03

**Recommendation:** fluent-ffmpeg inside a dedicated worker container — Isolates CPU-heavy processing in its own compose service (keeping the API responsive), keeps the worker NestJS-native, and reuses the proven fluent-ffmpeg API. The worker image installs `ffmpeg`/`ffprobe` via apt in a `Dockerfile.worker.dev`.
**Decision:** A (fluent-ffmpeg in dedicated worker container)
**Libraries:** fluent-ffmpeg@^2.x

### phase-03-videos/TD-04

**Recommendation:** Unique short slug + API-proxied Range streaming, presigned download — The slug satisfies "URL única por vídeo, sem conflito" with a simple unique index, and API-proxied streaming keeps auth/observability in the app while delegating byte-range handling to S3. The download path uses a presigned URL so the API never proxies the full 10GB on demand.
**Decision:** A (Short slug + API-proxied Range streaming + presigned download)
**Libraries:** @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x

### phase-03-videos/TD-05

**Recommendation:** Five states (DRAFT → UPLOADING → PROCESSING → READY | ERROR) — Makes each pipeline stage observable, gives the upload window its own state, and persists failure reasons for debugging and re-processing. The DB column mirrors the queue, keeping Redis as transport and Postgres as truth.
**Decision:** A (Five states DRAFT→UPLOADING→PROCESSING→READY | ERROR)
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Single `streamtube` bucket with `videos/` and `thumbnails/` prefixes — Minimizes MinIO provisioning (one bucket, idempotent bootstrap) while keeping the two media kinds logically separated by prefix. Prefixes support future lifecycle policies without a migration.
**Decision:** A (Single bucket, prefixed keys)
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases — conventions the phase must not reopen)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended choice for a greenfield 2026 project; native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only (no Passport) — smaller dependency surface; social login not on near-term roadmap.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — strongest security model with automatic theft detection; PostgreSQL already in the stack.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — revocability for password reset/confirmation; keeps email tokens decoupled from JWT.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** @nestjs-modules/mailer — best NestJS integration, works with Mailpit locally, Handlebars templates, no vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — documented NestJS approach; project already uses decorators extensively; fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — machine-readable `{ statusCode, error, message }` format with domain codes the frontend can switch on; no RFC 9457 overhead for a single-consumer project.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** @nestjs/throttler — native guard system, module-level `APP_GUARD`, in-memory storage sufficient for single instance.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** JWT kept for refresh tokens — reuses the access-token signing/verification infrastructure (`@nestjs/jwt`), single token format.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Strict `[a-z0-9_]` allowlist for channel handle + `user_<random>` fallback — simplest and most portable; no edge cases around hyphen positioning.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; same factory importable as a plain function for non-DI contexts. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection params sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`), `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- JWT auth via custom guards (`@nestjs/jwt`) — `JwtAuthGuard` + `@Public()` decorator, global guard registered as `APP_GUARD`. _(from phase 02)_
- Services throw domain exceptions (`DomainException`); global `DomainExceptionFilter` + `ValidationExceptionFilter` map them to the `{ statusCode, error, message }` envelope. _(from phase 02)_
- Layer separation per module: `module.ts`, `controller.ts`, `service.ts`, `entities/`, `dto/`, `decorators/`, `guards/`. Repository pattern via TypeORM injectable repositories. _(from phase 02)_
- Migrations via `typeorm-ts-node-commonjs` + `src/database/data-source.ts`; `migration:run` / `migration:revert` / `migration:generate` npm scripts; never `synchronize`. _(from phase 02)_
- Test naming: `*.spec.ts` (unit), `*.integration-spec.ts` (real DB/services), `*.e2e-spec.ts` (supertest HTTP). Controllers tested via E2E only; services via unit + integration; modules via compilation test. _(from phase 02)_
- OpenAPI via `@nestjs/swagger` decorators; error envelope DTO in `src/common/openapi/api-error-envelope.dto.ts`. _(from openapi-docs-nestjs)_
- Docker Compose service names are the hosts for inter-service connections (`db`, `nestjs-api`, `mailpit`) — never `localhost` inside containers. _(from phase 01)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| (empty on first assembly) | | | |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts`) | Integration: constraints, defaults, unique indexes |
| Service (upload orchestration, storage, slug, status transitions) | Unit: branch logic (mock repo/storage/queue) + Integration: DB contract with real MinIO/Redis |
| Service with configured lib (BullMQ queue, AWS S3 client) | Unit/Integration: real lib with test config |
| Module (`VideosModule`, `WorkerModule`) | Unit: compilation test (DI wiring incl. BullModule.registerQueue) |
| Controller (videos upload/stream/download) | E2E only (supertest) |
| DTO | E2E: one validation wiring test per endpoint |
| Worker processor | Unit: processor logic (mock ffmpeg/storage) + Integration: end-to-end job with real MinIO + ffmpeg |
| Migration | Integration: migration runner test (per phase 02 pattern) |

Per `testing-guide-nestjs-project`, integration tests use real infrastructure from the Compose stack (Postgres, MinIO, Redis) — mock only at boundaries. E2E via supertest exercises the full HTTP chain.
