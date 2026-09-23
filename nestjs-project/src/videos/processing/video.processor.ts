import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ProcessVideoPayload } from '../queues/videos-queue.service';
import { Video } from '../entities/video.entity';
import {
  STORAGE_PREFIX_THUMBNAILS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_EXTENSION,
  VIDEO_PROCESS_JOB_ATTEMPTS,
  VIDEO_QUEUE,
} from '../videos.constants';
import { VideoStatus } from '../videos.types';
import { ObjectStorageService } from '../storage/object-storage.service';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_QUEUE, { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: ObjectStorageService,
    private readonly processing: VideoProcessingService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoPayload>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video || !video.storage_key) return;
    if (video.status !== VideoStatus.PROCESSING) return;

    const tmpDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    try {
      const videoPath = join(tmpDir, 'input');
      await this.download(video.storage_key, videoPath);

      const thumbnailPath = join(tmpDir, `thumb.${THUMBNAIL_EXTENSION}`);
      const result = await this.processing.extract(videoPath, thumbnailPath);

      const thumbnailKey = `${STORAGE_PREFIX_THUMBNAILS}/${videoId}.${THUMBNAIL_EXTENSION}`;
      await this.storage.uploadFile(
        thumbnailKey,
        thumbnailPath,
        THUMBNAIL_CONTENT_TYPE,
      );

      await this.videoRepository.update(video.id, {
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: thumbnailKey,
        processing_error: null,
        status: VideoStatus.READY,
      } as Parameters<typeof this.videoRepository.update>[1]);
      this.logger.log(`Video ${videoId} processed successfully`);
    } catch (err) {
      const attempts = job.opts.attempts ?? VIDEO_PROCESS_JOB_ATTEMPTS;
      const isLastAttempt = job.attemptsMade + 1 >= attempts;
      if (isLastAttempt) {
        this.logger.error(
          `Video ${videoId} processing failed after ${attempts} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.videoRepository.update(video.id, {
          status: VideoStatus.ERROR,
          processing_error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async download(storageKey: string, dest: string): Promise<void> {
    const { stream } = await this.storage.getObjectStream(storageKey);
    await pipeline(stream, createWriteStream(dest));
  }
}
