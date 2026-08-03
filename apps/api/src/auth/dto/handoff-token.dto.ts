import { IsString, Matches } from 'class-validator';

/** 32 bytes aleatorios en base64url son exactamente 43 caracteres. */
const HANDOFF_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class HandoffTokenParams {
  @IsString()
  @Matches(HANDOFF_TOKEN, { message: 'Traspaso de sesión inválido' })
  token!: string;
}
