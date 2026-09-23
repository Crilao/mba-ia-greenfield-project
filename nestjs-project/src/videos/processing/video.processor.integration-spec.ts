import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import minioConfig from '../../config/minio.config';
import redisConfig from '../../config/redis.config';
import videosConfig from '../../config/videos.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../videos.types';
import { ObjectStorageModule } from '../storage/object-storage.module';
import { ObjectStorageService } from '../storage/object-storage.service';
import { VIDEO_PROCESS_JOB } from '../videos.constants';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideoProcessor (integration)', () => {
  let processor: VideoProcessor;
  let storage: ObjectStorageService;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;
  let channel: Channel;
  let tmpDir: string;
  let moduleRef: TestingModule;

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
        BullModule.registerQueue({ name: 'video-processing' }),
        TypeOrmModule.forFeature([User, Channel, Video]),
        ObjectStorageModule,
      ],
      providers: [VideoProcessingService, VideoProcessor],
    }).compile();
    await moduleRef.init();
    processor = moduleRef.get(VideoProcessor);
    storage = moduleRef.get(ObjectStorageService);
    videoRepository = moduleRef.get(DataSource).getRepository(Video);
    dataSource = moduleRef.get(DataSource);
    tmpDir = await mkdtemp(join(tmpdir(), 'streamtube-proc-int-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'proc@example.com',
      password: 'hash',
      is_confirmed: true,
    } as Partial<User>);
    channel = await dataSource.getRepository(Channel).save({
      name: 'proc',
      nickname: 'proc_channel',
      user_id: user.id,
    } as Partial<Channel>);
  });

  async function makeRealVideoObject(): Promise<{
    key: string;
    videoPath: string;
  }> {
    const videoPath = join(tmpDir, 'input.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-y',
        videoPath,
      ],
      { stdio: 'ignore' },
    );
    const key = `videos/${crypto.randomUUID()}/clip`;
    await storage.uploadFile(key, videoPath, 'video/mp4');
    return { key, videoPath };
  }

  it('processes a real video object: READY with duration, metadata and thumbnail', async () => {
    const { key } = await makeRealVideoObject();
    const video = await videoRepository.save({
      channel_id: channel.id,
      title: 'clip',
      slug: `slug-${crypto.randomUUID().slice(0, 11)}`,
      mime_type: 'video/mp4',
      size_bytes: 100,
      storage_key: key,
      status: VideoStatus.PROCESSING,
    } as Partial<Video>);

    const job = {
      data: { videoId: video.id },
      opts: { attempts: 3 },
      attemptsMade: 0,
      name: VIDEO_PROCESS_JOB,
    } as unknown as Job<{ videoId: string }>;

    await processor.process(job);

    const loaded = await videoRepository.findOneBy({ id: video.id });
    expect(loaded?.status).toBe(VideoStatus.READY);
    expect(loaded?.duration_seconds).toBeGreaterThan(1.5);
    expect(loaded?.thumbnail_key).toBe(`thumbnails/${video.id}.jpg`);
    expect(loaded?.metadata).toMatchObject({ codec: 'h264' });
    expect(loaded?.processing_error).toBeNull();
  });

  it('marks the video ERROR with the persisted reason on the final attempt', async () => {
    const video = await videoRepository.save({
      channel_id: channel.id,
      title: 'bad',
      slug: `slug-${crypto.randomUUID().slice(0, 11)}`,
      mime_type: 'video/mp4',
      size_bytes: 100,
      storage_key: `videos/${crypto.randomUUID()}/missing`,
      status: VideoStatus.PROCESSING,
    } as Partial<Video>);

    const job = {
      data: { videoId: video.id },
      opts: { attempts: 3 },
      attemptsMade: 2, // final attempt
      name: VIDEO_PROCESS_JOB,
    } as unknown as Job<{ videoId: string }>;

    await expect(processor.process(job)).rejects.toBeDefined();

    const loaded = await videoRepository.findOneBy({ id: video.id });
    expect(loaded?.status).toBe(VideoStatus.ERROR);
    expect(loaded?.processing_error).toBeTruthy();
  });
});
