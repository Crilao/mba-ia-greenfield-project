import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadPartDto)
  parts: UploadPartDto[];
}
