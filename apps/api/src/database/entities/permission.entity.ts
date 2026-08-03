import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'permissions' })
export class PermissionEntity {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  description!: string;
}
