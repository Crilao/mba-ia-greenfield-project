import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoForbiddenException extends DomainException {
  constructor() {
    super('VIDEO_FORBIDDEN', 403, 'You do not own this video');
  }
}

export class VideoStatusConflictException extends DomainException {
  constructor() {
    super(
      'VIDEO_STATUS_CONFLICT',
      409,
      'Video is not in a state that allows this operation',
    );
  }
}

export class VideoUploadMismatchException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_MISMATCH',
      400,
      'Upload identifier does not match the video',
    );
  }
}

export class StorageUnavailableException extends DomainException {
  constructor() {
    super('STORAGE_UNAVAILABLE', 502, 'Object storage is unavailable');
  }
}
