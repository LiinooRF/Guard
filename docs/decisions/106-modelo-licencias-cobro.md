# ADR 0106 — Modelo de licenciamiento, planes de suscripción y facturación por Guardia Activo Mensual (GAM)

- **Estado: ACEPTADA.**
- **Fecha:** 2026-08-18
- **Issue:** #106 (relacionado con #100, #105, #110 y migración `CreateProgressiveBilling`)
- **Hito:** M1 / M2 — Core & Plataforma de Gestión
- **Autores / Rol:** Subagente Analista de Arquitectura Core SentryCore

---

## 1. Contexto y Problema

SentryCore es una plataforma B2B SaaS especializada en trazabilidad, fiscalización de rondas y libro de novedades para empresas de seguridad privada y administradores de instalaciones.

En la arquitectura inicial del backend se implementó una estructura preliminar de cobro progresivo (`billing_tiers` y `subscription_plans` en migraciones `1723129200000` y `1723302000000`), donde se mezclaba el conteo de recintos con el de supervisores. Sin embargo, no existía una definición formal del modelo comercial, la unidad métrica de tarificación, la política de sobrecupo ni su interacción con el panel de administración de usuarios (Issue #100).

El problema a resolver es: **¿Cómo debe estructurarse el modelo de cobro y licenciamiento de SentryCore para maximizar la adopción, reflejar el valor entregado, resistir la alta rotación laboral del rubro de la seguridad en Chile y evitar interrupciones operativas en terreno?**

---

## 2. Opciones Evaluadas

### Opción A: Tarifa Plana por Empresa / Tenant (Flat Monthly Fee)
- **Descripción:** Cobro fijo mensual por empresa sin importar la cantidad de guardias, recintos o rondas efectuadas.
- **Ventajas:** Facturación extremadamente simple y predecible.
- **Desventajas:** Desalineada del valor percibido. Una pequeña agencia con 6 guardias pagaría lo mismo que una compañía con 600 guardias. Ahuyenta a clientes iniciales y pierde captura de valor en clientes medianos y corporativos.

### Opción B: Cobro por Recinto o Punto de Control (Per Site / Checkpoint)
- **Descripción:** Facturar según la cantidad de sucursales/recintos dados de alta o el número de etiquetas NFC/QR instaladas en terreno.
- **Ventajas:** Métrica física intuitiva para el cliente.
- **Desventajas:** **Incentivo perverso para la seguridad.** Para pagar menos software, las empresas tienden a reducir los puntos de control en sus recorridos, provocando rondas más cortas, menos fiscalizadas y con mayor riesgo perimetral. Degrada el valor del producto.

### Opción C: Cobro por Usuario Registrado en Base de Datos (Total Registered Users)
- **Descripción:** Cobrar por cada fila existente en `memberships` con estado activo.
- **Ventajas:** Consulta trivial en SQL (`SELECT count(*) FROM memberships`).
- **Desventajas:** Incompatible con la realidad del mercado de seguridad privada en Chile, donde la **rotación laboral mensual oscila entre el 20% y el 35%**. Obliga al administrador del cliente a pasar horas eliminando y desactivando guardias para no pagar sobrecostos por personas que ya no trabajan en la empresa, generando constantes fricciones y disputas de cobro.

### Opción D (Seleccionada): Modelo Híbrido Escalonado por Planes + Cómputo de Guardias Activos Mensuales (GAM) con Bloqueo Suave
- **Descripción:** Suscripción mensual estructurada en tres planes (**Starter**, **Pro**, **Enterprise**) que incluyen una cuota base de **Guardias Activos Mensuales (GAM)** y recintos, con tarificación progresiva por guardia adicional activo y una política de **bloqueo suave (Soft Lock)** que prioriza la continuidad del servicio en terreno.
- **Ventajas:**
  - Se alinea 1:1 con la unidad económica de las empresas de seguridad (que cotizan y cobran a sus clientes por puesto/guardia de servicio).
  - No penaliza la rotación de personal (guardias inactivos o sin turnos en el mes no pagan).
  - Permite entrada accesible a empresas pequeñas y expansión de ingresos (*land and expand*) a medida que ganan contratos.
  - Elimina el riesgo operacional de dejar garitas desatendidas por problemas de cuota de software.

---

## 3. Decisión de Arquitectura

Se adopta el **Modelo Híbrido de Suscripción por Tramos basado en Guardias Activos Mensuales (GAM)**, con las siguientes definiciones normativas y de implementación:

---

### 3.1. Estructura de Planes de Suscripción

```
+---------------------------------------------------------------------------------------+
|                                    SENTRYCORE PLANES                                  |
+--------------------------+----------------------------+-------------------------------+
|     STARTER (Base)       |            PRO             |          ENTERPRISE           |
+--------------------------+----------------------------+-------------------------------+
| • Hasta 15 GAM incluidos | • Hasta 60 GAM incluidos   | • >100 GAM personalizados     |
| • Hasta 3 Recintos       | • Hasta 15 Recintos        | • Recintos ilimitados         |
| • Rondas NFC / QR        | • Todo de Starter +        | • Todo de Pro +               |
| • Sincronización offline | • Traza GPS y Mapas (#79)  | • Acceso soporte auditado #109|
| • Libro Novedades básico | • Escalamiento (#126)      | • White-labeling (#285)       |
| • Reportes PDF estándar  | • Checklists turno (#129)  | • Retención a medida (hasta 10a)|
| • Alertas básicas        | • Macro-estadísticas (#103)| • SLA 99.9% y Webhooks        |
|                          | • Libro de Novedades Pro   | • Add-ons avanzados (M4)      |
+--------------------------+----------------------------+-------------------------------+
| GAM Extra: $3.500 CLP/m  | GAM Extra: $2.500 CLP/m    | GAM Extra: Según contrato     |
+--------------------------+----------------------------+-------------------------------+
```

1. **Plan Starter (`starter`):**
   - Diseñado para pequeñas agencias de seguridad o instalaciones individuales con equipo propio.
   - Incluye hasta **15 Guardias Activos Mensuales** y hasta **3 Recintos**.
   - Funcionalidades esenciales: ejecución de rondas NFC/QR, detección de anomalías básicas (reloj, radio GPS), sincronización offline (#14), reportes PDF ejecutivos por ronda.
2. **Plan Pro (`pro`):**
   - Diseñado para empresas de seguridad medianas con múltiples clientes y supervisores de terreno.
   - Incluye hasta **60 Guardias Activos Mensuales** y hasta **15 Recintos**.
   - Funcionalidades avanzadas: mapas con polilínea de recorrido en informes (#79), libro de novedades con criticidad y pánico (#124), cadenas de escalamiento (#126), checklists de inicio/fin de turno (#129), tableros de analítica avanzada (#103, #99).
3. **Plan Enterprise (`enterprise`):**
   - Diseñado para corporaciones nacionales o multinacionales de seguridad (Securitas, Prosegur, G4S) y parques industriales de alta complejidad.
   - Capacidad a medida (+100 GAM) y recintos ilimitados.
   - Funcionalidades corporativas: soporte dedicado con ventana auditada (#109), personalización de marca / colores (#285), retención legal de evidencias extendida (hasta 10 años), exportación en tiempo real y prioridad en soporte técnico.

---

### 3.2. Cómputo Formal de Guardia Activo Mensual (GAM)

Un usuario con rol `GUARDIA` en un tenant se considera **Guardia Activo** en el mes calendario $M$ si y solo si registra **al menos una** de las siguientes actividades comprobables en base de datos:

1. **Rondas iniciadas o completadas:** Al menos un registro en `patrols` con `started_at` o `closed_at` dentro del mes $M$.
2. **Puntos de control escaneados:** Al menos un registro en `scans` con `scanned_at_server` dentro del mes $M$.
3. **Novedades reportadas:** Al menos un evento registrado en `field_events` dentro del mes $M$.
4. **Sincronizaciones realizadas:** Al menos una operación en `sync_operations` procesada dentro del mes $M$.
5. **Turnos programados asistidos:** Asignación en `shift_assignments` con `service_date` en el mes $M$.

#### Reglas de Exclusión:
- Un guardia contratado que no haya realizado ninguna ronda, escaneo ni novedad en el mes (ej. reposo médico, vacaciones, reserva sin llamado) **NO computa como GAM** ($0$ costo).
- Los roles `ADMIN` y `SUPERVISOR` **no son guardias de ronda**; están cubiertos por los límites de gestión de la empresa y no computan dentro del pool de GAM.

#### Expresión SQL de Referencia para Cómputo GAM:
```sql
WITH guardias_activos_mes AS (
  SELECT DISTINCT m.user_id
  FROM memberships m
  JOIN users u ON u.id = m.user_id
  WHERE m.tenant_id = $1
    AND m.role_key = 'GUARDIA'
    AND u.is_active = true
    AND (
      EXISTS (
        SELECT 1 FROM patrols p
        WHERE p.tenant_id = m.tenant_id
          AND p.guard_id = m.user_id
          AND p.started_at >= date_trunc('month', $2::date)
          AND p.started_at < date_trunc('month', $2::date) + interval '1 month'
      )
      OR EXISTS (
        SELECT 1 FROM field_events fe
        WHERE fe.tenant_id = m.tenant_id
          AND fe.guard_id = m.user_id
          AND fe.reported_at_server >= date_trunc('month', $2::date)
          AND fe.reported_at_server < date_trunc('month', $2::date) + interval '1 month'
      )
      OR EXISTS (
        SELECT 1 FROM shift_assignments sa
        WHERE sa.tenant_id = m.tenant_id
          AND sa.guard_id = m.user_id
          AND sa.service_date >= date_trunc('month', $2::date)
          AND sa.service_date < date_trunc('month', $2::date) + interval '1 month'
      )
    )
)
SELECT count(*)::integer AS total_gam FROM guardias_activos_mes;
```

---

### 3.3. Política de Bloqueo Suave y Alertas (Interacción con Issue #100)

#### El Principio de Continuidad Operativa en Seguridad
En la industria de la vigilancia física, **un bloqueo duro (Hard Lock) en terreno es un riesgo inaceptable de seguridad de la vida y las instalaciones**. Si a medianoche un guardia de relevo de emergencia llega a cubrir a un compañero enfermo y el sistema le rechaza el acceso porque la empresa alcanzó su cuota de 15 guardias, la instalación queda desprotegida y el cliente expuesto a robos y multas de fiscalización (OS-10 de Carabineros de Chile).

Por tanto, se fijan las siguientes directrices:

#### A. En la App Móvil (Terreno)
- **CERO BLOQUEOS:** La aplicación móvil de los guardias **NUNCA** bloqueará un inicio de sesión, un inicio de ronda, un escaneo NFC/QR ni el envío de novedades debido a límites comerciales o sobrecupos de plan.
- El servicio en terreno opera con disponibilidad continua ininterrumpida.

#### B. En el Panel Web de Administración (#100 — Gestión de Usuarios)
- Cuando el administrador (`ADMIN`) crea un nuevo usuario guardia (`POST /admin/users`):
  1. Si `total_guardias_activos < limite_plan`: Creación normal, sin avisos especiales.
  2. Si `total_guardias_activos >= limite_plan`:
     - La API **permite la creación** exitosa del usuario.
     - La respuesta HTTP devuelve un encabezado/payload de advertencia: `warning: "QUOTA_EXCEEDED"`.
     - La interfaz web despliega un banner de advertencia claro e informativo:
       > **Aviso de Sobrecupo:** Has alcanzado el límite de tu plan actual (**X/X guardias**). Este nuevo guardia podrá operar normalmente y se tarificará como guardia adicional ($X CLP/mes) al cierre del ciclo, o puedes actualizar a Plan Pro para reducir tu costo unitario.
     - La acción queda registrada en el log de auditoría del tenant (`audit_log`) con la etiqueta `usuario.creado_sobrecupo`.

#### C. Sistema de Alertas Proactivas
- **Al 80% de la cuota:** Notificación informativa en el tablero de administración del tenant.
- **Al 100% de la cuota:** Correo electrónico al ADMIN con resumen de uso y comparativa de conveniencia económica de subir de plan.
- **Al cierre de mes:** La plataforma calcula el total de GAM consumidos. Si hubo sobrecupo, calcula el importe base más el desglose transparente de guardias adicionales según la tabla de tramos (`calculate_progressive_charge`).

---

## 4. Consecuencias de la Decisión

### Consecuencias Positivas
1. **Protección de la Operación Crítica:** Los clientes de SentryCore tienen la certeza de que el software nunca dejará botado un servicio de guardia en terreno por razones administrativas.
2. **Cero Fricción por Rotación:** El cliente no se ve obligado a hacer microgestión diaria de altas y bajas de usuarios para evitar cobros indebidos.
3. **Escalabilidad de Ingresos (Expansion MRR):** El crecimiento natural de los clientes (nuevos contratos, refuerzos por eventos o temporadas altas) se traduce automáticamente en mayor facturación por GAM adicional sin necesidad de fricciones comerciales previas.
4. **Monitoreo Centralizado en Plataforma:** El SUPERADMIN cuenta con métricas consolidadas en `platform_tenant_metrics` (#110) y liquidaciones mensuales automáticas en `platform_current_billing`.

### Consecuencias Negativas y Mitigaciones
1. **Cálculo de Facturación Mensual Agregado:** Computar GAM a mes cerrado exige consultas con agregaciones temporales.
   - *Mitigación:* Se cuenta con índices específicos en PostgreSQL (`patrols(tenant_id, started_at)`, `field_events(tenant_id, reported_at_server)`, `shift_assignments(tenant_id, service_date)`). Adicionalmente, el job diario de estadísticas `#103` consolida métricas intermedias.
2. **Riesgo de Clientes Morosos con Sobrecupo No Autorizado:** Una empresa podría crear decenas de guardias sin intención de pagar el sobrecupo.
   - *Mitigación:* El SUPERADMIN puede establecer un tope blando de seguridad configurable (`maxOverdraftLimit`, default +50% del plan) tras el cual el panel web exige confirmación expresa con tarjeta/medio de pago antes de crear más usuarios, manteniendo siempre la operación móvil activa para los ya creados.

---

## 5. Cumplimiento Normativo y Tributario

1. **Normativa Tributaria Chilena (Servicio de Impuestos Internos - SII):**
   - La facturación de servicios de software SaaS en Chile está gravada con IVA (19%).
   - Las liquidaciones mensuales emitidas por `platform_current_billing` calculan el monto neto en CLP (`net_amount_clp`) para su posterior timbraje electrónico vía Documento Tributario Electrónico (DTE - Factura Afecta Electrónica).
2. **Trazabilidad y No Repudio:**
   - Cada cobro por GAM adicional cuenta con respaldo inmutable en los registros de auditoría y bitácoras de rondas de PostgreSQL. Ante cualquier consulta del cliente, la plataforma puede emitir un reporte detallado con las fechas, horas y rondas exactas ejecutadas por cada guardia computado en el periodo.
