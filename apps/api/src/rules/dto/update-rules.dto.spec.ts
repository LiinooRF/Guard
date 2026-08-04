import { BadRequestException } from '@nestjs/common';

import { UpdateRulesPipe } from './update-rules.dto';

describe('UpdateRulesPipe', () => {
  it('acepta un subconjunto valido de reglas', () => {
    expect(
      new UpdateRulesPipe('tenant').transform({ complianceThreshold: 85, allowQrFallback: false }),
    ).toEqual({ complianceThreshold: 85, allowQrFallback: false });
  });

  it('un body vacio es valido: limpia los overrides de ese nivel', () => {
    expect(new UpdateRulesPipe('site').transform({})).toEqual({});
  });

  it('una regla mal escrita es 400 y no un descarte silencioso', () => {
    expect(() => new UpdateRulesPipe('tenant').transform({ complianceTreshold: 85 })).toThrow(
      BadRequestException,
    );
  });

  it('un valor fuera de rango es 400', () => {
    expect(() => new UpdateRulesPipe('tenant').transform({ complianceThreshold: 150 })).toThrow(
      BadRequestException,
    );
  });

  it('una regla que ese nivel no configura es 400 y lo dice en castellano', () => {
    try {
      new UpdateRulesPipe('checkpoint').transform({ photoRetentionDays: 60 });
      throw new Error('deberia haber fallado');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const respuesta = (error as BadRequestException).getResponse() as { message: string[] };
      expect(respuesta.message[0]).toContain('no se configura a nivel punto de control');
    }
  });

  it('los destinatarios del informe no se pueden fijar en la plataforma', () => {
    expect(() =>
      new UpdateRulesPipe('platform').transform({ reportRecipients: ['alguien@ejemplo.cl'] }),
    ).toThrow(BadRequestException);
    expect(
      new UpdateRulesPipe('tenant').transform({ reportRecipients: ['alguien@ejemplo.cl'] }),
    ).toEqual({ reportRecipients: ['alguien@ejemplo.cl'] });
  });

  it('un correo invalido en los destinatarios es 400', () => {
    expect(() =>
      new UpdateRulesPipe('tenant').transform({ reportRecipients: ['no-es-un-correo'] }),
    ).toThrow(BadRequestException);
  });
});
