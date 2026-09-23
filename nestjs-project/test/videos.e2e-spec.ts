import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 1000;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
  ): Promise<{ access_token: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return { access_token: res.body.access_token };
  }

  async function createDraft(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; slug: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        ...overrides,
      })
      .expect(201);
    return { id: res.body.id, slug: res.body.slug };
  }

  async function makeTestVideo(): Promise<{ path: string; bytes: Buffer }> {
    const dir = await mkdtemp(join(tmpdir(), 'streamtube-e2e-'));
    const path = join(dir, 'test.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=160x90:d=1',
        '-vf',
        'format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-t',
        '1',
        '-y',
        path,
      ],
      { stdio: 'ignore' },
    );
    const bytes = await readFile(path);
    return { path: dir, bytes };
  }

  async function uploadViaPresignedPart(
    url: string,
    bytes: Buffer,
  ): Promise<string> {
    const res = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(200);
    return (res.headers.get('etag') ?? '').replace(/"/g, '');
  }

  async function waitUntilReady(
    slug: string,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      const res = await request(app.getHttpServer()).get(`/videos/${slug}`);
      if (res.status === 200 && res.body.status === 'ready') return res.body;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Video ${slug} did not become ready in time`);
  }

  describe('POST /videos (pre-register)', () => {
    it('returns 201 with a draft and unique slug', async () => {
      const { access_token } =
        await registerConfirmAndLogin('draft@example.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'My video', mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.slug).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(res.body.channelId).toBeDefined();
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ mimeType: 'video/mp4', sizeBytes: 1024 })
        .expect(401);
    });

    it('returns 400 VALIDATION_ERROR for a size above 10GB', async () => {
      const { access_token } = await registerConfirmAndLogin('big@example.com');
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ mimeType: 'video/mp4', sizeBytes: 11 * 1024 ** 3 })
        .expect(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('Upload flow', () => {
    it('initiates a multipart upload with presigned part URLs', async () => {
      const { access_token } = await registerConfirmAndLogin('up@example.com');
      const { id } = await createDraft(access_token, { sizeBytes: 4096 });
      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/initiate`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ partSize: 1048576 })
        .expect(201);
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.partCount).toBe(1);
      expect(res.body.partUrls[0].url).toContain('X-Amz-');
    });

    it('returns 409 when initiating a non-draft video', async () => {
      const { access_token } =
        await registerConfirmAndLogin('conf@example.com');
      const { id } = await createDraft(access_token);
      await request(app.getHttpServer())
        .post(`/videos/${id}/upload/initiate`)
        .set('Authorization', `Bearer ${access_token}`)
        .send()
        .expect(201);
      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/initiate`)
        .set('Authorization', `Bearer ${access_token}`)
        .send()
        .expect(409);
      expect(res.body.error).toBe('VIDEO_STATUS_CONFLICT');
    });

    it('returns 403 when another user tries to initiate', async () => {
      const owner = await registerConfirmAndLogin('owner2@example.com');
      const other = await registerConfirmAndLogin('other2@example.com');
      const { id } = await createDraft(owner.access_token);
      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/initiate`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .send()
        .expect(403);
      expect(res.body.error).toBe('VIDEO_FORBIDDEN');
    });
  });

  describe('Full pipeline (upload → process → stream → download)', () => {
    it('processes a real uploaded video and serves stream, thumbnail and download', async () => {
      const { access_token } =
        await registerConfirmAndLogin('flow@example.com');
      const { id, slug } = await createDraft(access_token, {
        mimeType: 'video/mp4',
        sizeBytes: 4 * 1024,
      });

      const initRes = await request(app.getHttpServer())
        .post(`/videos/${id}/upload/initiate`)
        .set('Authorization', `Bearer ${access_token}`)
        .send()
        .expect(201);
      const { uploadId, partUrls } = initRes.body;

      const { path: tmpDir, bytes } = await makeTestVideo();
      try {
        const etag = await uploadViaPresignedPart(partUrls[0].url, bytes);

        const completeRes = await request(app.getHttpServer())
          .post(`/videos/${id}/upload/complete`)
          .set('Authorization', `Bearer ${access_token}`)
          .send({ uploadId, parts: [{ partNumber: 1, etag }] })
          .expect(200);
        expect(completeRes.body.status).toBe('processing');

        const metadata = await waitUntilReady(slug);
        expect(metadata.status).toBe('ready');
        expect(metadata.durationSeconds).toBeGreaterThan(0);
        expect(metadata.thumbnailUrl).toBe(`/videos/${slug}/thumbnail`);

        const streamRes = await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .set('Range', 'bytes=0-1023');
        expect(streamRes.status).toBe(206);
        expect(streamRes.headers['content-range']).toMatch(
          /^bytes 0-1023\/\d+$/,
        );
        expect(streamRes.headers['accept-ranges']).toBe('bytes');
        expect(Buffer.from(streamRes.body).length).toBe(1024);

        const thumbRes = await request(app.getHttpServer())
          .get(`/videos/${slug}/thumbnail`)
          .expect(200);
        expect(thumbRes.headers['content-type']).toContain('image/jpeg');

        const dlRes = await request(app.getHttpServer())
          .get(`/videos/${slug}/download`)
          .expect(200);
        expect(dlRes.body.url).toContain('X-Amz-');
        expect(dlRes.body.url).toContain('response-content-disposition');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }, 90000);
  });
});
