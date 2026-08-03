import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class CompleteAuthActionDto {
  @IsString()
  @Length(43, 128)
  token!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
