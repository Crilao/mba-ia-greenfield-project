import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import minioConfig from '../../config/minio.config';
import { ObjectStorageModule } from './object-storage.module';
import { ObjectStorageService } from './object-storage.service';

describe('ObjectStorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storage: ObjectStorageService;
  let tmpDir: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [minioConfig] }),
        ObjectStorageModule,
      ],
    }).compile();
    storage = moduleRef.get(ObjectStorageService);
    tmpDir = await mkdtemp(join(tmpdir(), 'streamtube-storage-test-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  it('ensures the bucket idempotently', async () => {
    await storage.ensureBucket();
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
  });

  it('round-trips a multipart upload via a presigned part URL', async () => {
    const key = `videos/test/${randomUUID()}`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const partUrl = await storage.presignUploadPart(key, uploadId, 1);
    expect(partUrl).toContain('X-Amz-');

    const body = Buffer.from('hello-minio-part');
    const putRes = await fetch(partUrl, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(putRes.status).toBe(200);
    const etag = (putRes.headers.get('etag') ?? '').replace(/"/g, '');

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);
    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(body.length);
  });

  it('returns only the requested byte range from getObjectStream', async () => {
    const key = `thumbnails/test/${randomUUID()}.jpg`;
    const filePath = join(tmpDir, 'thumb.jpg');
    const content = Buffer.from('0123456789abcdef');
    await writeFile(filePath, content);
    await storage.uploadFile(key, filePath, 'image/jpeg');

    const obj = await storage.getObjectStream(key, 'bytes=2-5');
    const chunks: Buffer[] = [];
    for await (const chunk of obj.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    expect(obj.contentLength).toBe(4);
  });

  it('presigns a GET URL that downloads the object', async () => {
    const key = `videos/test/${randomUUID()}`;
    const filePath = join(tmpDir, 'video.bin');
    await writeFile(filePath, 'download-me');
    await storage.uploadFile(key, filePath, 'video/mp4');

    const url = await storage.presignGetObject(key, 'video.mp4');
    expect(url).toContain('X-Amz-');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('download-me');
  });
});
