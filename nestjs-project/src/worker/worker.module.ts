import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import minioConfig from '../config/minio.config';
import redisConfig from '../config/redis.config';
import videosConfig from '../config/videos.config';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { ObjectStorageModule } from '../videos/storage/object-storage.module';
import { VideoProcessingService } from '../videos/processing/video-processing.service';
import { VideoProcessor } from '../videos/processing/video.processor';
import { VIDEO_QUEUE } from '../videos/videos.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, minioConfig, redisConfig, videosConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [redisConfig.KEY],
      useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    ObjectStorageModule,
  ],
  providers: [VideoProcessor, VideoProcessingService],
})
export class WorkerModule {}
