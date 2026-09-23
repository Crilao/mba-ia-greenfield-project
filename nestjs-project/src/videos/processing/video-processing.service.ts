import { Injectable, Logger } from '@nestjs/common';
import { basename, dirname } from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';

export interface VideoProcessingResult {
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
  thumbnailPath: string;
}

const THUMBNAIL_TIMESTAMP_SECONDS = 0;
const THUMBNAIL_SIZE = '640x360';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  private ffprobe(filePath: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(data);
      });
    });
  }

  private screenshot(filePath: string, thumbnailPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .screenshots({
          count: 1,
          timestamps: [THUMBNAIL_TIMESTAMP_SECONDS],
          filename: basename(thumbnailPath),
          folder: dirname(thumbnailPath),
          size: THUMBNAIL_SIZE,
        });
    });
  }

  async extract(
    filePath: string,
    thumbnailPath: string,
  ): Promise<VideoProcessingResult> {
    const data = await this.ffprobe(filePath);
    const videoStream = data.streams.find(
      (stream) => stream.codec_type === 'video',
    );
    const duration =
      data.format?.duration != null
        ? Number(data.format.duration)
        : videoStream?.duration != null
          ? Number(videoStream.duration)
          : null;

    const metadata: Record<string, unknown> = {
      formatName: data.format?.format_name ?? null,
      bitrate: data.format?.bit_rate ?? null,
      codec: videoStream?.codec_name ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      frameRate: videoStream?.r_frame_rate ?? null,
    };

    await this.screenshot(filePath, thumbnailPath);
    const codecName =
      typeof metadata.codec === 'string' ? metadata.codec : 'unknown';
    this.logger.log(
      `Extracted metadata for ${filePath}: duration=${duration}, codec=${codecName}`,
    );
    return { durationSeconds: duration, metadata, thumbnailPath };
  }
}
