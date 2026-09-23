import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration, real ffmpeg)', () => {
  const service = new VideoProcessingService();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'streamtube-proc-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts duration/metadata and writes a thumbnail from a real clip', async () => {
    const videoPath = join(tmpDir, 'input.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-y',
        videoPath,
      ],
      { stdio: 'ignore' },
    );

    const thumbnailPath = join(tmpDir, 'thumb.jpg');
    const result = await service.extract(videoPath, thumbnailPath);

    expect(result.durationSeconds).toBeGreaterThan(1.5);
    expect(result.metadata).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
    const thumbStat = await stat(thumbnailPath);
    expect(thumbStat.size).toBeGreaterThan(0);
  });
});
