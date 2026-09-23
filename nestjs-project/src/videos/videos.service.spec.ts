import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.types';
import { VideosService } from './videos.service';
import { VideosQueueService } from './queues/videos-queue.service';
import { ObjectStorageService } from './storage/object-storage.service';

describe('VideosService (unit)', () => {
  let service: VideosService;
  const repository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    getObjectStream: jest.fn(),
    presignGetObject: jest.fn(),
  };
  const queue = { enqueueProcess: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: ObjectStorageService, useValue: storage },
        { provide: VideosQueueService, useValue: queue },
        {
          provide: videosConfig.KEY,
          useValue: {
            partSize: 100 * 1024 * 1024,
            maxSizeBytes: 10 * 1024 ** 3,
          },
        },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  function makeVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      title: 't',
      status: VideoStatus.DRAFT,
      slug: 'slug-1234567',
      storage_key: null,
      thumbnail_key: null,
      mime_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: null,
      duration_seconds: null,
      metadata: null,
      processing_error: null,
      ...overrides,
    } as Video;
  }

  describe('createDraft', () => {
    it('persists a draft bound to the caller channel', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      repository.create.mockImplementation(
        (input: Partial<Video>) => input as Video,
      );
      repository.save.mockResolvedValue(makeVideo());
      const video = await service.createDraft('user-1', {
        title: 'Intro',
        mimeType: 'video/mp4',
        sizeBytes: 2048,
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('throws VideoForbiddenException when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);
      await expect(
        service.createDraft('user-1', {
          mimeType: 'video/mp4',
          sizeBytes: 1,
        }),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_FORBIDDEN' });
    });

    it('retries with a fresh slug on a unique-slug collision', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      repository.create.mockImplementation(
        (input: Partial<Video>) => input as Video,
      );
      repository.save
        .mockRejectedValueOnce({
          code: '23505',
          detail: 'Key (slug)=(dup) already exists.',
        })
        .mockResolvedValueOnce(makeVideo());
      const video = await service.createDraft('user-1', {
        mimeType: 'video/mp4',
        sizeBytes: 1,
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(repository.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('initiateUpload', () => {
    it('creates the multipart upload, presigns parts and moves to uploading', async () => {
      const video = makeVideo({ size_bytes: 250 * 1024 * 1024 });
      repository.findOne.mockResolvedValue(video);
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-123');
      storage.presignUploadPart.mockResolvedValue('https://minio/part');
      const result = await service.initiateUpload(
        'video-1',
        'user-1',
        100 * 1024 * 1024,
      );
      expect(result.uploadId).toBe('upload-123');
      expect(result.partCount).toBe(3);
      expect(result.partUrls).toHaveLength(3);
      expect(result.partUrls[0].url).toContain('minio');
      expect(repository.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({
          status: VideoStatus.UPLOADING,
          upload_id: 'upload-123',
        }),
      );
    });

    it('throws VideoStatusConflictException when the video is not a draft', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      await expect(
        service.initiateUpload('video-1', 'user-1'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_STATUS_CONFLICT' });
    });

    it('throws VideoForbiddenException for a non-owner', async () => {
      repository.findOne.mockResolvedValue(makeVideo());
      channelsService.findByUserId.mockResolvedValue({ id: 'other-channel' });
      await expect(
        service.initiateUpload('video-1', 'user-1'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_FORBIDDEN' });
    });

    it('throws VideoNotFoundException for a missing video', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(
        service.initiateUpload('missing', 'user-1'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });

  describe('completeUpload', () => {
    it('completes the multipart and enqueues processing', async () => {
      const video = makeVideo({
        status: VideoStatus.UPLOADING,
        upload_id: 'upload-123',
        storage_key: 'videos/video-1/slug-1234567',
      });
      repository.findOne.mockResolvedValue(video);
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storage.completeMultipartUpload.mockResolvedValue(undefined);
      const result = await service.completeUpload('video-1', 'user-1', {
        uploadId: 'upload-123',
        parts: [{ partNumber: 1, etag: 'etag-1' }],
      });
      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(repository.update).toHaveBeenCalledWith(
        'video-1',
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(queue.enqueueProcess).toHaveBeenCalledWith('video-1');
    });

    it('throws VideoUploadMismatchException on a diverging uploadId', async () => {
      const video = makeVideo({
        status: VideoStatus.UPLOADING,
        upload_id: 'expected-upload',
      });
      repository.findOne.mockResolvedValue(video);
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      await expect(
        service.completeUpload('video-1', 'user-1', {
          uploadId: 'wrong-upload',
          parts: [{ partNumber: 1, etag: 'etag' }],
        }),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_UPLOAD_MISMATCH' });
    });

    it('throws VideoStatusConflictException when not uploading', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.DRAFT }),
      );
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-1' });
      await expect(
        service.completeUpload('video-1', 'user-1', {
          uploadId: 'upload-123',
          parts: [{ partNumber: 1, etag: 'etag' }],
        }),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_STATUS_CONFLICT' });
    });
  });

  describe('stream', () => {
    it('returns a 206 result for a valid range', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/slug-1234567',
      });
      repository.findOne.mockResolvedValue(video);
      storage.headObject.mockResolvedValue({ contentLength: 1000 });
      storage.getObjectStream.mockResolvedValue({ stream: {} });
      const result = await service.stream('slug-1234567', 'bytes=0-499');
      expect(result.status).toBe(206);
      expect(result.start).toBe(0);
      expect(result.end).toBe(499);
      expect(result.total).toBe(1000);
    });

    it('returns a 200 result when no Range header is present', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/slug-1234567',
      });
      repository.findOne.mockResolvedValue(video);
      storage.headObject.mockResolvedValue({ contentLength: 1000 });
      storage.getObjectStream.mockResolvedValue({ stream: {} });
      const result = await service.stream('slug-1234567');
      expect(result.status).toBe(200);
    });

    it('returns a 416 result for an unsatisfiable range', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/slug-1234567',
      });
      repository.findOne.mockResolvedValue(video);
      storage.headObject.mockResolvedValue({ contentLength: 1000 });
      const result = await service.stream('slug-1234567', 'bytes=5000-6000');
      expect(result.status).toBe(416);
    });

    it('throws VideoNotFoundException when not ready', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      await expect(service.stream('slug-1234567')).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_FOUND',
      });
    });
  });

  describe('presignDownload', () => {
    it('returns a presigned URL for a ready video', async () => {
      const video = makeVideo({
        status: VideoStatus.READY,
        storage_key: 'videos/video-1/slug-1234567',
      });
      repository.findOne.mockResolvedValue(video);
      storage.presignGetObject.mockResolvedValue(
        'https://minio/download?X-Amz-1',
      );
      const { url } = await service.presignDownload('slug-1234567');
      expect(url).toContain('X-Amz');
    });

    it('throws VideoNotFoundException when not ready', async () => {
      repository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.ERROR }),
      );
      await expect(
        service.presignDownload('slug-1234567'),
      ).rejects.toMatchObject({
        errorCode: 'VIDEO_NOT_FOUND',
      });
    });
  });
});
