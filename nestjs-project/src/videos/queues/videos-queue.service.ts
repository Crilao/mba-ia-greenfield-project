import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESS_JOB_ATTEMPTS,
  VIDEO_PROCESS_JOB_BACKOFF_DELAY_MS,
  VIDEO_QUEUE,
} from '../videos.constants';

export interface ProcessVideoPayload {
  videoId: string;
}

@Injectable()
export class VideosQueueService {
  constructor(@InjectQueue(VIDEO_QUEUE) private readonly queue: Queue) {}

  async enqueueProcess(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId } satisfies ProcessVideoPayload,
      {
        attempts: VIDEO_PROCESS_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: VIDEO_PROCESS_JOB_BACKOFF_DELAY_MS,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
  }
}
