import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type TenantStatus = 'active' | 'suspended';

@Entity({ name: 'tenants' })
export class TenantEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  slug!: string;

  @Column({ name: 'legal_name', type: 'text' })
  legalName!: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  @Column({ type: 'text', default: 'active' })
  status!: TenantStatus;

  /**
   * Referencia opaca al plan. Los limites concretos pertenecen a la decision
   * abierta #106 y no se codifican en el esquema de identidad.
   */
  @Column({ name: 'plan_key', type: 'text', default: 'base' })
  planKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
