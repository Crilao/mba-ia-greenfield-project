import { DataSource } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';
import { VideoStatus } from '../videos.types';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let user: User;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await dataSource.getRepository(User).save({
      email: 'owner@example.com',
      password: 'hash',
      is_confirmed: true,
    } as Partial<User>);
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: 'owner_nickname',
      user_id: user.id,
    } as Partial<Channel>);
  });

  async function saveVideo(overrides: Partial<Video> = {}): Promise<Video> {
    return dataSource.getRepository(Video).save({
      channel_id: channel.id,
      title: 'My video',
      mime_type: 'video/mp4',
      size_bytes: 1024,
      slug: 'abc123def45',
      ...overrides,
    } as Partial<Video>);
  }

  it('persists with status default "draft" and title default ""', async () => {
    const video = await dataSource.getRepository(Video).save({
      channel_id: channel.id,
      mime_type: 'video/mp4',
      size_bytes: 1,
      slug: 'x1',
    } as Partial<Video>);
    const loaded = await dataSource
      .getRepository(Video)
      .findOneBy({ id: video.id });
    expect(loaded?.status).toBe(VideoStatus.DRAFT);
    expect(loaded?.title).toBe('');
    expect(loaded?.size_bytes).toBe(1);
  });

  it('rejects a duplicate slug with a unique-violation error', async () => {
    await saveVideo({ slug: 'dup-slug-12345' });
    await expect(saveVideo({ slug: 'dup-slug-12345' })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('rejects an insert whose channel_id references a missing channel', async () => {
    await expect(
      dataSource.getRepository(Video).save({
        channel_id: '00000000-0000-4000-8000-000000000000',
        mime_type: 'video/mp4',
        size_bytes: 1,
        slug: 'fk-check-0001',
      } as Partial<Video>),
    ).rejects.toBeDefined();
  });

  it('maps bigint size_bytes and stores jsonb metadata', async () => {
    const video = await saveVideo({
      size_bytes: 10 * 1024 * 1024 * 1024,
      metadata: { codec: 'h264', width: 1920, height: 1080 },
      duration_seconds: 12.5,
    });
    const loaded = await dataSource
      .getRepository(Video)
      .findOneBy({ id: video.id });
    expect(loaded?.size_bytes).toBe(10 * 1024 * 1024 * 1024);
    expect(loaded?.metadata).toEqual({
      codec: 'h264',
      width: 1920,
      height: 1080,
    });
    expect(loaded?.duration_seconds).toBe(12.5);
  });
});
