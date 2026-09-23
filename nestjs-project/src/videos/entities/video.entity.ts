import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../videos.types';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 64, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 255 })
  mime_type: string;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number | null) => value ?? 0,
      from: (value: string | null) => (value === null ? 0 : Number(value)),
    },
  })
  size_bytes: number;

  @Column({ type: 'varchar', length: 512, nullable: true })
  upload_id: string | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
