---
libs:
  bullmq:
    version: "^5.x"
    context7_id: "bullmq (redis)"
    fetched_at: "2026-09-23"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "nestjs/bullmq"
    fetched_at: "2026-09-23"
  ioredis:
    version: "^5.x"
    context7_id: "ioredis"
    fetched_at: "2026-09-23"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "aws-sdk-js-v3/client-s3"
    fetched_at: "2026-09-23"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "aws-sdk-js-v3/s3-request-presigner"
    fetched_at: "2026-09-23"
  fluent-ffmpeg:
    version: "^2.x"
    context7_id: "fluent-ffmpeg"
    fetched_at: "2026-09-23"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T17:19:00-0300"
---

# Library References — Phase 03: Upload e Processamento de Vídeos

## bullmq + @nestjs/bullmq + ioredis

Background queue. `@nestjs/bullmq@^11` is the NestJS 11 first-party integration; `bullmq@^5` is the core library; `ioredis` is the Redis client it uses.

### Root config (API + worker)

```ts
BullModule.forRoot({
  connection: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
})
```

- `connection: ConnectionOptions` — Redis host/port; use the Compose service name (`redis`) as host.
- `prefix` defaults to `bull`.
- `forRootAsync({ useFactory, inject, useClass, useExisting })` supported.
- Job options at `Queue.add()`: `priority` (0 default / lower first), `delay` (ms), `attempts`, `backoff: number | BackoffOptions`, `jobId` (caller must guarantee uniqueness), `removeOnComplete`, `removeOnFail`.

### Producer

```ts
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class VideoQueueService {
  constructor(@InjectQueue('video-processing') private videoQueue: Queue) {}

  async enqueue(videoId: string) {
    await this.videoQueue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
  }
}
```

### Consumer (worker)

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    switch (job.name) {
      case 'process-video': {
        await this.handle(job.data.videoId);
        break;
      }
    }
  }
}
```

- Register consumer as a provider; dispatch on `job.name` (BullMQ has no `@Process('name')`).
- Worker events: `@OnWorkerEvent('failed' | 'completed' | 'active')`.
- Set `drainDelay` (~10000) and `stalledInterval` (~60000) on the worker to avoid idle Redis churn.
- Wrap `queue.add()` in try/catch — persist the DB row first (status UPLOADING→PROCESSING), then enqueue; Redis errors must not surface as 500s.

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

S3-compatible object storage client (works against MinIO with `forcePathStyle: true`). Presigner generates SigV4-signed URLs.

### Client config (MinIO)

```ts
const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,       // e.g. http://minio:9000 (Compose service name)
  region: process.env.MINIO_REGION,           // 'us-east-1'
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,                        // required for MinIO/self-hosted
});
```

### Presign signature

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
getSignedUrl(client, command, { expiresIn: 3600 });  // expiresIn seconds, default 900, max 7 days
```

### Multipart handshake (10GB upload, TD-02)

```ts
import { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';

// 1. Create: returns UploadId (XML/JSON)
const create = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
const uploadId = create.UploadId;

// 2. Presign one UploadPart URL per part (PUT body sent by the client directly to MinIO)
const partUrl = await getSignedUrl(s3, new UploadPartCommand({ Bucket, Key, UploadId: uploadId, PartNumber: 1, ContentLength: partSize }), { expiresIn: 3600 });

// 3. Complete with ETags from each part
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId: uploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: 'etag-1' }, /* ... */] },
}));
```

- Single `PutObject` caps at 5GB — multipart is mandatory for 10GB.
- Bodies are NOT included in presigned URLs; client PUTs each part to the part URL.
- Streaming (TD-04): `GetObjectCommand({ Bucket, Key, Range: 'bytes=start-end' })` returns a `Body` stream; pipe chunks to the HTTP response. `HeadObjectCommand` gives `ContentLength` for range math.

## fluent-ffmpeg

Node wrapper around FFmpeg/FFprobe. Requires `ffmpeg` + `ffprobe` binaries (installed in the worker image via apt).

### Metadata (ffprobe)

```ts
import ffmpeg from 'fluent-ffmpeg';

const meta = await new Promise<ffmpeg.FfprobeData>((resolve, reject) =>
  ffmpeg.ffprobe(localPath, (err, data) => (err ? reject(err) : resolve(data))),
);
// meta.format.duration, meta.format.bit_rate, meta.streams[] (codec_type, codec_name, width, height)
```

### Thumbnail

```ts
await new Promise<void>((resolve, reject) =>
  ffmpeg(localPath)
    .screenshots({ timestamps: [1], filename: 'thumb.jpg', folder: tmpDir, size: '640x360' })
    .on('end', () => resolve())
    .on('error', reject),
);
```

### Worker image note

The worker Dockerfile must install ffmpeg/ffprobe (e.g., `apt-get install -y ffmpeg`), and the processor must point fluent-ffmpeg at the binaries (`ffmpeg.setFfmpegPath`/`setFfprobePath` or system PATH). Processing is CPU-bound — keep BullMQ worker concurrency low (1–2).
