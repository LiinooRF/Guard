'use client';

/**
 * Descarga a CSV de la tabla de una grafica (#87).
 *
 * Se arma en el navegador con los datos que ya estan en la pagina: no hay
 * endpoint de exportacion todavia y no hacia falta inventarlo para esto. El
 * informe en PDF —ese si existe en la API— se enlaza aparte.
 */

import { escaparCampoCsv, nombreArchivoCsv } from './stats-charts-csv-format';

export function DescargarCsv({
  nombre,
  columnas,
  filas,
}: {
  /** Base del nombre de archivo, sin extension. */
  nombre: string;
  columnas: string[];
  filas: string[][];
}) {
  function descargar() {
    const lineas = [columnas, ...filas].map((fila) => fila.map(escaparCampoCsv).join(';'));
    // El BOM es lo que hace que Excel en Windows abra el archivo en UTF-8 y no
    // parta los apellidos con tilde. Sin el, "Muñoz" llega como "MuÃ±oz".
    const contenido = `\uFEFF${lineas.join('\r\n')}\r\n`;
    const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreArchivoCsv(nombre);
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="secondary-button stats-boton" onClick={descargar}>
      Descargar CSV
    </button>
  );
}
