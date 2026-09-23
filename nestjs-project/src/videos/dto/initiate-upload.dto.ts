import { IsInt, IsOptional, Max, Min } from 'class-validator';

const MIN_PART_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_PART_SIZE = 1024 * 1024 * 1024; // 1GB

export class InitiateUploadDto {
  @IsOptional()
  @IsInt()
  @Min(MIN_PART_SIZE)
  @Max(MAX_PART_SIZE)
  partSize?: number;
}
