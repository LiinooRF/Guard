import { IsIn } from 'class-validator';

export class UpdateTenantStatusDto {
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';
}
