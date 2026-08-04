import { IsString, MaxLength, MinLength } from 'class-validator';

export class AttendAlertDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  comment!: string;
}
