import { randomBytes } from 'node:crypto';
import { SLUG_BYTES } from './videos.constants';

export function generateVideoSlug(): string {
  return randomBytes(SLUG_BYTES).toString('base64url');
}
