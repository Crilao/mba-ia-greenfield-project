import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import { User } from '../users/entities/user.entity';
import minioConfig from '../config/minio.config';
import redisConfig from '../config/redis.config';
import videosConfig from '../config/videos.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VIDEO_QUEUE } from './videos.constants';
import { VideoStatus } from './videos.types';
import { ObjectStorageModule } from './storage/object-storage.module';
import { VideosQueueService } from './queues/videos-queue.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService (integration)', () => {
  let service: VideosService;
  let queue: Queue;
  let moduleRef: TestingModule;
  let channel: Channel;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [minioConfig, redisConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [redisConfig.KEY],
          useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_QUEUE }),
        TypeOrmModule.forFeature([User, Channel, Video]),
        ObjectStorageModule,
      ],
      providers: [ChannelsService, VideosQueueService, VideosService],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(VideosService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    queue.on('error', () => {});
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(moduleRef.get(DataSource));
    const user = await moduleRef
      .get(DataSource)
      .getRepository(User)
      .save({
        email: 'video-owner@example.com',
        password: 'hash',
        is_confirmed: true,
      } as Partial<User>);
    userId = user.id;
    channel = await moduleRef
      .get(DataSource)
      .getRepository(Channel)
      .save({
        name: 'video-owner',
        nickname: 'video_owner',
        user_id: user.id,
      } as Partial<Channel>);
    await queue.drain(true);
  });

  it('pre-registers a draft with a unique slug', async () => {
    const video = await service.createDraft(userId, {
      title: 'Intro',
      mimeType: 'video/mp4',
      sizeBytes: 1234,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.slug).toMatch(/^[A-Za-z0-9_-]+$/);

    const loaded = await moduleRef
      .get(DataSource)
      .getRepository(Video)
      .findOneBy({ id: video.id });
    expect(loaded?.channel_id).toBe(channel.id);
  });

  it('initiates a real MinIO multipart upload and presigns part URLs', async () => {
    const video = await service.createDraft(userId, {
      mimeType: 'video/mp4',
      sizeBytes: 150 * 1024 * 1024,
    });
    const result = await service.initiateUpload(video.id, userId);
    expect(result.uploadId).toBeDefined();
    expect(result.partCount).toBe(2);
    expect(result.partUrls).toHaveLength(2);
    expect(result.partUrls[0].url).toContain('X-Amz-');
  });

  it('completes the upload, transitions to processing and enqueues the job', async () => {
    const video = await service.createDraft(userId, {
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    });
    const init = await service.initiateUpload(video.id, userId);
    const partUrl = init.partUrls[0].url;
    const putRes = await fetch(partUrl, {
      method: 'PUT',
      body: new Uint8Array(Buffer.from('fake-video-bytes')),
    });
    expect(putRes.status).toBe(200);
    const etag = (putRes.headers.get('etag') ?? '').replace(/"/g, '');

    const result = await service.completeUpload(video.id, userId, {
      uploadId: init.uploadId,
      parts: [{ partNumber: 1, etag }],
    });
    expect(result.status).toBe(VideoStatus.PROCESSING);

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce(
      (sum: number, value: unknown) =>
        sum + (typeof value === 'number' ? value : 0),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('throws VideoUploadMismatchException for a diverging uploadId', async () => {
    const video = await service.createDraft(userId, {
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    });
    await service.initiateUpload(video.id, userId);
    await expect(
      service.completeUpload(video.id, userId, {
        uploadId: 'wrong',
        parts: [{ partNumber: 1, etag: 'etag' }],
      }),
    ).rejects.toMatchObject({ errorCode: 'VIDEO_UPLOAD_MISMATCH' });
  });
});
