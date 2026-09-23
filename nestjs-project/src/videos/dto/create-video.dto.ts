import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_VIDEO_SIZE_BYTES } from '../../config/videos.config';

export class CreateVideoDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_SIZE_BYTES)
  sizeBytes: number;
}
