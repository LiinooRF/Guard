'use client';

/**
 * Pantalla "Configuracion de las funciones del sistema" (#102).
 *
 * Junta las cuatro piezas y las mantiene coherentes entre si:
 *
 *   1. Modulos contratados      -> que compro la empresa (licencia)
 *   2. Funciones de la ronda    -> los si/no del nivel empresa
 *   3. Asi esta operando hoy    -> lo que el servidor le responde a los telefonos
 *   4. Historial de cambios     -> la auditoria de lo que se toco
 *
 * El panel solo guarda el estado compartido: la vista de reglas ya guardada (que
 * usa la comprobacion para no comparar contra un formulario a medio editar) y un
 * contador que empuja al historial a refrescarse despues de cada guardado.
 *
 * Esconder secciones no es control de acceso: los cuatro endpoints exigen
 * `tenant:rules:manage` o `tenant:audit:read` en el servidor, que es donde se
 * decide de verdad.
 */
import { useState } from 'react';

import { FuncionesHistorial } from './funciones-historial';
import { FuncionesInterruptores } from './funciones-interruptores';
import { FuncionesModulos } from './funciones-modulos';
import { FuncionesTerreno } from './funciones-terreno';
import type { VistaModulos } from './funciones-modelo';
import type { CatalogoReglas, VistaReglas } from './reglas-catalogo';

export function FuncionesPanel({
  catalogoReglas,
  vistaReglasInicial,
  vistaModulosInicial,
  apiUrl,
}: {
  catalogoReglas: CatalogoReglas;
  vistaReglasInicial: VistaReglas;
  vistaModulosInicial: VistaModulos | null;
  apiUrl: string;
}) {
  const [vistaReglas, setVistaReglas] = useState<VistaReglas>(vistaReglasInicial);
  const [refresco, setRefresco] = useState(0);

  return (
    <>
      {vistaModulosInicial ? (
        <FuncionesModulos
          vistaInicial={vistaModulosInicial}
          apiUrl={apiUrl}
          onGuardado={() => setRefresco((previo) => previo + 1)}
        />
      ) : (
        <section className="management-card management-wide reglas-panel" id="funciones">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Funciones del sistema</span>
              <h2>Módulos contratados</h2>
            </div>
          </div>
          <div className="dashboard-empty">
            <strong>No pudimos leer tu plan</strong>
            <span>
              Vuelve a cargar la página. Las funciones de la ronda que aparecen más abajo se pueden
              configurar igual.
            </span>
          </div>
        </section>
      )}

      <FuncionesInterruptores
        catalogo={catalogoReglas}
        vistaInicial={vistaReglasInicial}
        apiUrl={apiUrl}
        onGuardado={(nueva) => {
          setVistaReglas(nueva);
          setRefresco((previo) => previo + 1);
        }}
      />

      <FuncionesTerreno catalogo={catalogoReglas} vista={vistaReglas} apiUrl={apiUrl} />

      <FuncionesHistorial
        parametros={catalogoReglas.parameters}
        apiUrl={apiUrl}
        refresco={refresco}
      />
    </>
  );
}
