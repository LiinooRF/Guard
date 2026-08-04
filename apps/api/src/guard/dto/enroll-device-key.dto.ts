import { IsBase64, IsUUID, Length } from 'class-validator';

export class EnrollDeviceKeyDto {
  @IsUUID()
  deviceId!: string;

  /** 32 bytes en base64 estándar (44 caracteres con padding). */
  @IsBase64()
  @Length(44, 44)
  key!: string;
}
