import { Column, Entity, PrimaryColumn } from 'typeorm';

export type RoleScope = 'platform' | 'tenant';

@Entity({ name: 'roles' })
export class RoleEntity {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  scope!: RoleScope;
}
