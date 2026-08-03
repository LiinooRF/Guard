import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Muchos guardias no tienen correo; la credencial puede ser un username. */
  @Column({ type: 'citext', nullable: true })
  email!: string | null;

  @Column({ type: 'citext', nullable: true })
  username!: string | null;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ name: 'given_name', type: 'text' })
  givenName!: string;

  @Column({ name: 'family_name', type: 'text' })
  familyName!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
