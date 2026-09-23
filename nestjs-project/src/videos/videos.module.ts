import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ObjectStorageModule } from './storage/object-storage.module';
import { Video } from './entities/video.entity';
import { VIDEO_QUEUE } from './videos.constants';
import { VideosQueueService } from './queues/videos-queue.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    ObjectStorageModule,
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService, VideosQueueService],
  exports: [VideosService, ObjectStorageModule],
})
export class VideosModule {}
