import { aplicarColoresGuardados } from './marca-aplicacion';

describe('aplicación inmediata de la marca guardada', () => {
  it('actualiza todas las variables del shell, incluidos ambos colores y sus textos', () => {
    const setProperty = jest.fn();

    aplicarColoresGuardados(
      { setProperty },
      {
        commercialName: 'Seguridad Andina',
        logoUri: null,
        primaryColor: '#bd2029',
        secondaryColor: '#0b6b5f',
        mailFromName: null,
        mailFooter: null,
      },
    );

    expect(setProperty).toHaveBeenCalledWith('--marca-primario', '#bd2029');
    expect(setProperty).toHaveBeenCalledWith('--marca-secundario', '#0b6b5f');
    expect(setProperty).toHaveBeenCalledWith('--marca-primario-texto', '#ffffff');
    expect(setProperty).toHaveBeenCalledWith('--marca-secundario-texto', '#ffffff');
  });
});

