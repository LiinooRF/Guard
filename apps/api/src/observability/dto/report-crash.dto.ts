import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Lo que la app manda cuando se cayo (#27).
 *
 * ESTA CLASE ES EL CONTRATO COMPLETO. El ValidationPipe global corre con
 * `whitelist: true` y `forbidNonWhitelisted: true`, asi que un campo que no
 * este declarado aca no llega "de mas": devuelve 400. Es lo que hace que la
 * promesa "ningun evento lleva datos del guardia" sea verificable y no un
 * acuerdo de palabra — no existe forma de que una version futura de la app
 * agregue `guardName` o `lastLocation` y el servidor los acepte en silencio.
 *
 * Si la app necesita mandar un campo nuevo, se agrega aca, con revision. Ese
 * roce es la funcion, no un efecto colateral.
 */
export class ReportCrashDto {
  /** Tipo de la excepcion: 'TypeError', 'NfcBridgeError'. */
  @IsString()
  @Length(1, 120)
  errorName!: string;

  /**
   * Mensaje del error. Se enmascara en el servidor antes de guardarlo, porque
   * un mensaje de error se arma con `${variable}` y ahi puede haber cualquier
   * cosa.
   */
  @IsString()
  @Length(1, 4_000)
  errorMessage!: string;

  /** Pila cruda. Tambien se enmascara y se acota en el servidor. */
  @IsOptional()
  @IsString()
  @Length(0, 40_000)
  stack?: string;

  /**
   * Version de la app instalada. Es la mitad del diagnostico: sin ella no se
   * puede saber si la caida ya esta arreglada en una version que el guardia
   * todavia no instalo — y en Play Store eso tarda semanas.
   */
  @IsString()
  @Length(1, 32)
  @Matches(/^[A-Za-z0-9._+-]+$/, {
    message: 'appVersion solo acepta letras, numeros, punto, guion, guion bajo y mas',
  })
  appVersion!: string;

  /**
   * Modelo comercial del telefono, como lo entrega el sistema.
   *
   * Se recorta ANTES de validar, igual que `FalseAlarmDto.reason`: el CHECK de
   * la columna es `length(trim(device_model)) BETWEEN 1 AND 64`, asi que un
   * modelo de puros espacios pasaria `@Length` y reventaria contra el CHECK —
   * un 500 en vez del 400 que corresponde.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 64)
  deviceModel!: string;

  /** Version de Android, como la entrega el sistema ('10', '13'). Ver `deviceModel`. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 32)
  androidVersion!: string;

  /**
   * Version del protocolo del puente nativo <-> WebView. Un despliegue de la
   * web incompatible con una app vieja se ve igual que un bug si no se sabe con
   * que version del puente estaba hablando.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000)
  bridgeProtocolVersion?: number;

  /** True = la app se cerro. False = error recuperado que igual conviene ver. */
  @IsOptional()
  @IsBoolean()
  fatal?: boolean;

  /**
   * Cuando ocurrio segun el telefono. Es informativo: el reloj del telefono
   * miente (ver el desfase de reloj de #73) y por eso no reemplaza a la hora de
   * recepcion. Que exista importa porque la app reporta al volver la señal, y
   * eso puede ser horas despues — una ronda en subterraneo no tiene datos.
   */
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;
}
