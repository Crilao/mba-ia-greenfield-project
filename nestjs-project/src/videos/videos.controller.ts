import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideosService } from './videos.service';
import type { InitiateUploadResult, VideoMetadata } from './videos.service';
import { VideoStatus } from './videos.types';

export interface VideoCreateResponse {
  id: string;
  channelId: string;
  title: string;
  slug: string;
  status: VideoStatus;
  mimeType: string;
  sizeBytes: number;
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Pre-register a video as draft',
    description:
      'Creates a video record bound to the authenticated user’s channel with status "draft" before the upload starts.',
  })
  @ApiResponse({
    status: 201,
    description: 'Video pre-registered',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        channelId: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        slug: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<VideoCreateResponse> {
    const video = await this.videosService.createDraft(user.sub, dto);
    return {
      id: video.id,
      channelId: video.channel_id,
      title: video.title,
      slug: video.slug,
      status: video.status,
      mimeType: video.mime_type,
      sizeBytes: video.size_bytes,
    };
  }

  @Post(':id/upload/initiate')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate multipart upload',
    description:
      'Creates an S3 multipart upload and returns presigned part URLs so the client uploads parts directly to object storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Multipart upload created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        partSize: { type: 'integer' },
        partCount: { type: 'integer' },
        partUrls: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in "draft" state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @HttpCode(HttpStatus.CREATED)
  async initiateUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(id, user.sub, dto.partSize);
  }

  @Post(':id/upload/complete')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete multipart upload and enqueue processing',
    description:
      'Completes the S3 multipart upload, transitions the video to "processing" and enqueues the video-processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or uploadId mismatch',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Not the video owner',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in "uploading" state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; status: string }> {
    return this.videosService.completeUpload(id, user.sub, dto);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get video metadata',
    description: 'Returns metadata for a video identified by its unique slug.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        channelId: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'uploading', 'processing', 'ready', 'error'],
        },
        durationSeconds: { type: 'number', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        mimeType: { type: 'string' },
        sizeBytes: { type: 'integer' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getMetadata(@Param('slug') slug: string): Promise<VideoMetadata> {
    return this.videosService.getMetadata(slug);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream the video (HTTP Range / 206)',
    description:
      'Streams the video file supporting HTTP Range requests (206 Partial Content).',
  })
  @ApiResponse({ status: 200, description: 'Full-body stream' })
  @ApiResponse({ status: 206, description: 'Partial content stream' })
  @ApiResponse({ status: 404, description: 'Video not found' })
  async stream(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.videosService.stream(slug, req.headers.range);
    res.status(result.status);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', result.video.mime_type);
    if (result.status === 416) {
      res.setHeader('Content-Range', `bytes */${result.total}`);
      res.end();
      return;
    }
    if (result.status === 206 && result.stream) {
      res.setHeader(
        'Content-Range',
        `bytes ${result.start}-${result.end}/${result.total}`,
      );
      res.setHeader(
        'Content-Length',
        String(result.contentLength ?? result.end! - result.start! + 1),
      );
    } else if (result.status === 200 && result.stream) {
      res.setHeader('Content-Length', String(result.total));
    }
    if (!result.stream) {
      res.end();
      return;
    }
    result.stream.pipe(res);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/thumbnail')
  @ApiOperation({
    summary: 'Get video thumbnail',
    description: 'Returns the generated thumbnail image bytes.',
  })
  @ApiResponse({ status: 200, description: 'Thumbnail image (JPEG)' })
  @ApiResponse({ status: 404, description: 'Video or thumbnail not found' })
  async thumbnail(
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    const { stream } = await this.videosService.getThumbnailStream(slug);
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'image/jpeg');
    stream.pipe(res);
  }

  @Public()
  @SkipThrottle()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Get a presigned download URL',
    description:
      'Returns a short-lived presigned URL to download the video file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<{ url: string }> {
    return this.videosService.presignDownload(slug);
  }
}
