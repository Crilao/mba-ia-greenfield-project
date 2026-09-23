import { registerAs } from '@nestjs/config';

export default registerAs('minio', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
  region: process.env.MINIO_REGION || 'us-east-1',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  bucket: process.env.STORAGE_BUCKET || 'streamtube',
}));
