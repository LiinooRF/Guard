import { IsInt, Max, Min } from 'class-validator';

export class UpdateAuthPolicyDto {
  @IsInt()
  @Min(3)
  @Max(20)
  maxFailedAttempts!: number;

  @IsInt()
  @Min(60)
  @Max(86_400)
  windowSeconds!: number;

  @IsInt()
  @Min(60)
  @Max(86_400)
  baseLockSeconds!: number;

  @IsInt()
  @Min(60)
  @Max(604_800)
  maxLockSeconds!: number;
}
