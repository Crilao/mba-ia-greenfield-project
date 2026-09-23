import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { CreateVideoDto } from './dto/create-video.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import { parseRange } from './range.util';
import { ObjectStorageService } from './storage/object-storage.service';
import { VideoStatus } from './videos.types';
import { generateVideoSlug } from './slug.util';
import { STORAGE_PREFIX_VIDEOS, MAX_SLUG_RETRIES } from './videos.constants';
import {
  StorageUnavailableException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoStatusConflictException,
  VideoUploadMismatchException,
} from './videos.exceptions';
import { VideosQueueService } from './queues/videos-queue.service';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';

function isPgUniqueViolationOnSlug(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; detail?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(SLUG_COLUMN)
  );
}

export interface InitiateUploadResult {
  id: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  partUrls: Array<{ partNumber: number; url: string }>;
}

export interface VideoMetadata {
  id: string;
  slug: string;
  channelId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
}

export interface StreamResult {
  video: Video;
  stream: NodeJS.ReadableStream | null;
  total: number;
  status: 200 | 206 | 416;
  start?: number;
  end?: number;
  contentLength?: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: ObjectStorageService,
    private readonly queue: VideosQueueService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  private async requireOwnedVideo(
    videoId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoForbiddenException();
    }
    return video;
  }

  private async requireChannel(userId: string): Promise<{ id: string }> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new VideoForbiddenException();
    return channel;
  }

  private async wrapStorage<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async createDraft(userId: string, dto: CreateVideoDto): Promise<Video> {
    const channel = await this.requireChannel(userId);
    const title = dto.title ?? '';
    for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
      const video = this.videoRepository.create({
        channel_id: channel.id,
        title,
        mime_type: dto.mimeType,
        size_bytes: dto.sizeBytes,
        slug: generateVideoSlug(),
        status: VideoStatus.DRAFT,
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (isPgUniqueViolationOnSlug(err)) continue;
        throw err;
      }
    }
    throw new Error('Slug conflict could not be resolved after max retries');
  }

  async initiateUpload(
    videoId: string,
    userId: string,
    partSizeOverride?: number,
  ): Promise<InitiateUploadResult> {
    const video = await this.requireOwnedVideo(videoId, userId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoStatusConflictException();
    }
    const partSize = partSizeOverride ?? this.config.partSize;
    const partCount = Math.max(1, Math.ceil(video.size_bytes / partSize));
    const storageKey = `${STORAGE_PREFIX_VIDEOS}/${videoId}/${video.slug}`;

    const uploadId = await this.wrapStorage(() =>
      this.storage.createMultipartUpload(storageKey, video.mime_type),
    );
    const partUrls = await this.wrapStorage(() =>
      Promise.all(
        Array.from({ length: partCount }, (_, i) =>
          this.storage.presignUploadPart(storageKey, uploadId, i + 1),
        ),
      ),
    );

    await this.videoRepository.update(video.id, {
      status: VideoStatus.UPLOADING,
      upload_id: uploadId,
      storage_key: storageKey,
    });

    return {
      id: video.id,
      uploadId,
      partSize,
      partCount,
      partUrls: partUrls.map((url, i) => ({
        partNumber: i + 1,
        url,
      })),
    };
  }

  async completeUpload(
    videoId: string,
    userId: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.requireOwnedVideo(videoId, userId);
    if (video.status !== VideoStatus.UPLOADING) {
      throw new VideoStatusConflictException();
    }
    if (!video.upload_id || video.upload_id !== dto.uploadId) {
      throw new VideoUploadMismatchException();
    }
    const storageKey =
      video.storage_key ?? `${STORAGE_PREFIX_VIDEOS}/${videoId}/${video.slug}`;

    await this.wrapStorage(() =>
      this.storage.completeMultipartUpload(storageKey, dto.uploadId, dto.parts),
    );

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
    });

    await this.queue.enqueueProcess(video.id);

    return { id: video.id, status: VideoStatus.PROCESSING };
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({ where: { slug } });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async getMetadata(slug: string): Promise<VideoMetadata> {
    const video = await this.findBySlug(slug);
    return {
      id: video.id,
      slug: video.slug,
      channelId: video.channel_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl: video.thumbnail_key
        ? `/videos/${video.slug}/thumbnail`
        : null,
      mimeType: video.mime_type,
      sizeBytes: video.size_bytes,
    };
  }

  async stream(slug: string, rangeHeader?: string): Promise<StreamResult> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotFoundException();
    }
    const head = await this.wrapStorage(() =>
      this.storage.headObject(video.storage_key as string),
    );
    const total = head.contentLength;
    const parsed = parseRange(rangeHeader, total);

    if (!parsed) {
      const obj = await this.wrapStorage(() =>
        this.storage.getObjectStream(video.storage_key as string),
      );
      return { video, stream: obj.stream, total, status: 200 };
    }
    if (!parsed.satisfiable || !parsed.range) {
      return { video, stream: null, total, status: 416 };
    }
    const range = `bytes=${parsed.range.start}-${parsed.range.end}`;
    const obj = await this.wrapStorage(() =>
      this.storage.getObjectStream(video.storage_key as string, range),
    );
    return {
      video,
      stream: obj.stream,
      total,
      start: parsed.range.start,
      end: parsed.range.end,
      contentLength: obj.contentLength,
      status: 206,
    };
  }

  async getThumbnailStream(
    slug: string,
  ): Promise<{ stream: NodeJS.ReadableStream }> {
    const video = await this.findBySlug(slug);
    if (!video.thumbnail_key) throw new VideoNotFoundException();
    const obj = await this.wrapStorage(() =>
      this.storage.getObjectStream(video.thumbnail_key as string),
    );
    return { stream: obj.stream };
  }

  async presignDownload(slug: string): Promise<{ url: string }> {
    const video = await this.findBySlug(slug);
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotFoundException();
    }
    const url = await this.wrapStorage(() =>
      this.storage.presignGetObject(
        video.storage_key as string,
        `video.${this.extensionFromMime(video.mime_type)}`,
      ),
    );
    return { url };
  }

  private extensionFromMime(mimeType: string): string {
    const map: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/ogg': 'ogv',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
    };
    return map[mimeType] ?? 'mp4';
  }
}
