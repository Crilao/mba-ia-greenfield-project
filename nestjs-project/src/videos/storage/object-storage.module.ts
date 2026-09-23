import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import minioConfig from '../../config/minio.config';
import { ObjectStorageService } from './object-storage.service';
import { S3_CLIENT } from './storage.constants';

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      useFactory: (config: ConfigType<typeof minioConfig>) =>
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
          forcePathStyle: true,
        }),
      inject: [minioConfig.KEY],
    },
    ObjectStorageService,
  ],
  exports: [ObjectStorageService],
})
export class ObjectStorageModule {}
