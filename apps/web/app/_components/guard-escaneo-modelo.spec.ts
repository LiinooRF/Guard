import {
  BOTON_QR_PRINCIPAL,
  BOTON_QR_RESPALDO,
  ETIQUETA_METODO,
  motivoQrInvalido,
  opcionesDeEscaneo,
  type CapacidadesEscaneo,
} from './guard-escaneo-modelo';

/**
 * Lo que se prueba acá es la regla de producto, no el pintado: cuándo aparece el
 * respaldo por QR, cuándo NO tiene que aparecer, y que el camino normal con NFC
 * quede intacto (#227).
 */

const CON_TODO: CapacidadesEscaneo = {
  hayPuente: true,
  tieneNfc: true,
  puedeEscanearQr: true,
  qrPermitidoPorReglas: true,
};

describe('opcionesDeEscaneo', () => {
  it('con antena NFC el camino normal no cambia', () => {
    const opciones = opcionesDeEscaneo(CON_TODO);
    expect(opciones.modo).toBe('nfc');
    expect(opciones.nfc).toBe(true);
    // El QR está disponible para la etiqueta rota, pero como respaldo: el modo
    // sigue siendo 'nfc' y la pantalla lo pinta chico.
    expect(opciones.qr).toBe(true);
    expect(opciones.aviso).toBeUndefined();
  });

  it('sin antena y con QR ofrece el respaldo y explica por qué', () => {
    const opciones = opcionesDeEscaneo({ ...CON_TODO, tieneNfc: false });
    expect(opciones.modo).toBe('solo-qr');
    expect(opciones.nfc).toBe(false);
    expect(opciones.qr).toBe(true);
    expect(opciones.aviso).toMatch(/QR/);
  });

  it('sin antena y con el QR apagado por la empresa manda avisar al supervisor', () => {
    const opciones = opcionesDeEscaneo({
      ...CON_TODO,
      tieneNfc: false,
      qrPermitidoPorReglas: false,
    });
    expect(opciones.modo).toBe('ninguno');
    expect(opciones.qr).toBe(false);
    expect(opciones.aviso).toMatch(/supervisor/);
  });

  it('sin antena y con la app vieja manda a actualizar, no a soporte', () => {
    const opciones = opcionesDeEscaneo({
      ...CON_TODO,
      tieneNfc: false,
      puedeEscanearQr: false,
    });
    expect(opciones.modo).toBe('ninguno');
    // Actualizar la app SÍ lo arregla; mandar a soporte sería un ticket perdido.
    expect(opciones.aviso).toMatch(/Google Play/);
  });

  it('con antena, la empresa puede apagar el respaldo sin quedarse sin escaneo', () => {
    const opciones = opcionesDeEscaneo({ ...CON_TODO, qrPermitidoPorReglas: false });
    expect(opciones).toEqual({ modo: 'nfc', nfc: true, qr: false });
  });

  it('sin puente no se ofrece ningún escaneo: el QR también viaja por el puente', () => {
    const opciones = opcionesDeEscaneo({ ...CON_TODO, hayPuente: false });
    expect(opciones).toEqual({ modo: 'ninguno', nfc: false, qr: false });
    // El aviso lo redacta useGuardBridge, que sabe si falta la app o si el shell
    // no respondió. Duplicarlo acá daría dos textos distintos para lo mismo.
    expect(opciones.aviso).toBeUndefined();
  });

  it('sin antena, el shell soporta QR pero el equipo no tiene cámara', () => {
    // `puedeEscanearQr` ya viene resuelto por el hook con las capacidades del
    // shell; acá se comprueba que la pantalla no promete lo que no hay.
    const opciones = opcionesDeEscaneo({
      hayPuente: true,
      tieneNfc: false,
      puedeEscanearQr: false,
      qrPermitidoPorReglas: true,
    });
    expect(opciones.qr).toBe(false);
  });

  it('los dos textos del QR se distinguen: principal y respaldo', () => {
    expect(BOTON_QR_PRINCIPAL).not.toBe(BOTON_QR_RESPALDO);
    expect(BOTON_QR_RESPALDO).toMatch(/QR/);
  });
});

describe('motivoQrInvalido', () => {
  it('acepta el código que emite la API', () => {
    expect(motivoQrInvalido('VXQ-ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBeUndefined();
  });

  it('tolera espacios alrededor: la cámara los agrega', () => {
    expect(motivoQrInvalido('  VXQ-ABCDEFGHIJKLMNOPQRSTUVWXYZ  ')).toBeUndefined();
  });

  it('rechaza el QR de un afiche pegado al lado del punto', () => {
    expect(motivoQrInvalido('https://promo.example.cl/oferta')).toMatch(/punto de control/);
  });

  it('rechaza el prefijo correcto con alfabeto equivocado', () => {
    // base32 no tiene 0, 1, 8 ni 9: un lector que confunde O con 0 no pasa.
    expect(motivoQrInvalido('VXQ-ABCDEF01ABCDEF01')).toBeDefined();
  });

  it('rechaza el vacío en vez de mandarlo a la API', () => {
    expect(motivoQrInvalido('')).toBeDefined();
  });
});

describe('ETIQUETA_METODO', () => {
  it('nombra los dos métodos como los nombra el informe', () => {
    // Mismos textos que `apps/api/src/reports/excel-export.model.ts`: si el
    // informe dice "QR" y la pantalla dijera "Cámara", nadie cruzaría los dos.
    expect(ETIQUETA_METODO).toEqual({ nfc: 'NFC', qr: 'QR' });
  });
});
