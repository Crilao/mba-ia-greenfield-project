import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import minioConfig from '../config/minio.config';
import redisConfig from '../config/redis.config';
import videosConfig from '../config/videos.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VIDEO_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosModule', () => {
  it('compiles with TypeOrmModule, ChannelsModule, ObjectStorageModule and BullModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            appConfig,
            authConfig,
            mailConfig,
            minioConfig,
            redisConfig,
            videosConfig,
          ],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [redisConfig.KEY],
          useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
          }),
        }),
        VideosModule,
      ],
    }).compile();

    // The BullMQ queue keeps a Redis connection; swallow its close-time
    // error event so it does not surface as an unhandled error on module close.
    const queue = module.get<Queue>(getQueueToken(VIDEO_QUEUE));
    queue.on('error', () => {});

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
