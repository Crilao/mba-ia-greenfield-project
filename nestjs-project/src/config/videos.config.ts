import { registerAs } from '@nestjs/config';

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
export const DEFAULT_PART_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

export default registerAs('videos', () => ({
  partSize: parseInt(
    process.env.VIDEOS_PART_SIZE || `${DEFAULT_PART_SIZE_BYTES}`,
    10,
  ),
  maxSizeBytes: MAX_VIDEO_SIZE_BYTES,
}));
