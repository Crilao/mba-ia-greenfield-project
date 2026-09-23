import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import minioConfig from '../../config/minio.config';
import { PRESIGN_URL_EXPIRATION_SECONDS, S3_CLIENT } from './storage.constants';

export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

export interface UploadPartReference {
  partNumber: number;
  etag: string;
}

export interface ObjectStream {
  stream: Readable;
  contentLength?: number;
  contentRange?: string;
}

@Injectable()
export class ObjectStorageService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    @Inject(minioConfig.KEY)
    private readonly config: ConfigType<typeof minioConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  private bucket(): string {
    return this.config.bucket;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket() }));
    } catch {
      await this.client.send(
        new CreateBucketCommand({ Bucket: this.bucket() }),
      );
    }
  }

  async headObject(key: string): Promise<ObjectHead> {
    const out = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket(), Key: key }),
    );
    return {
      contentLength: out.ContentLength ?? 0,
      contentType: out.ContentType,
    };
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket(),
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!out.UploadId) {
      throw new Error('CreateMultipartUpload returned no UploadId');
    }
    return out.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket(),
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGN_URL_EXPIRATION_SECONDS },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPartReference[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket(),
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async getObjectStream(key: string, range?: string): Promise<ObjectStream> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        Range: range,
      }),
    );
    return {
      stream: out.Body as Readable,
      contentLength: out.ContentLength,
      contentRange: out.ContentRange,
    };
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const data = await readFile(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    key: string,
    filename?: string,
    expiresInSeconds = 60,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ...(filename
        ? { ResponseContentDisposition: `attachment; filename="${filename}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}
