# ADR 0139 — Control de acceso de visitantes en portería y recepción

- **Estado: ACEPTADA.**
- **Fecha:** 2026-08-18
- **Issue:** #139
- **Hito:** Planificado para Fase 2 (M4) como módulo Add-on de pago
- **Autores / Rol:** Subagente Analista de Arquitectura Core SentryCore

---

## 1. Contexto y Problema

Durante el levantamiento de requerimientos con empresas de seguridad privada y administradores de instalaciones (clientes objetivo de SentryCore), ha surgido de forma reiterada la solicitud de incorporar **control de acceso de visitas y contratistas en portería/recepción** (registro de entrada/salida de personas, captura de cédula de identidad/RUT, fotografía del visitante y registro de vehículos).

En el mercado chileno existen soluciones concurrentes:
1. **Sistemas de rondas puros** (ej. Deggy, Guard1, Active Track): enfocados estrictamente en el control de rondas mediante puntos de marcación (iButton/NFC/GPS), con cero funcionalidad de portería.
2. **Plataformas de seguridad y portería integradas** (ej. Control Guard, Safeturn, CityTrooper): ofrecen módulos de portería digital donde el guardia registra visitas con escaneo de cédula de identidad chilena para sustituir el libro de papel de recepción.
3. **Software de administración de condominios** (ej. ComunidadFeliz, Edifito, Kastor): orientados a copropiedad inmobiliaria con control de visitas básico pero sin capacidades avanzadas de fiscalización de rondas operativas.

El problema arquitectónico y de negocio a resolver es: **¿Debe SentryCore incorporar el control de acceso de visitantes dentro del alcance del MVP (M1/M2), o debe postergarse para una etapa posterior sin desviar el Core de verificación de rondas?**

---

## 2. Opciones Evaluadas

### Opción 1: Incorporar Control de Visitas en el Core MVP (M2) con OCR MRZ en la App Móvil
- **Descripción:** Desarrollar en el backend las entidades de visitantes, pases, autorizaciones de anfitriones y registro de accesos en portería, sumando a la app móvil un lector OCR de la zona MRZ de la Cédula de Identidad chilena.
- **Ventajas:** Paridad de características comerciales inmediatas contra plataformas como Control Guard en licitaciones "todo en uno".
- **Desventajas:**
  - **Desviación crítica de foco (Scope Creep):** Duplica la superficie del dominio (gestión de visitas, pre-autorizaciones, blacklist de visitas, cálculo de permanencia, gestión de estacionamientos).
  - **Inviabilidad técnica en gama baja:** La lectura OCR de MRZ en teléfonos de entrada en garitas oscuras tiene alta tasa de error (ver sección 4).
  - **Complejidad regulatoria:** Impacto severo en la Ley 21.719 de Protección de Datos Personales (ver sección 5).
  - **Degradación del rendimiento móvil:** Agrega bibliotecas pesadas de visión artificial (20–30 MB al APK), violando el principio de APK liviano y arranque rápido (`docs/tamano-apk-y-arranque.md`).

### Opción 2: Descartar Permanentemente el Módulo de Visitas
- **Descripción:** Posicionar a SentryCore exclusivamente como un software de monitoreo de rondas de guardia (patrol tour verification), rechazando cualquier función de registro de visitas.
- **Ventajas:** Simplicidad arquitectónica máxima y cero pasivos legales sobre datos de terceros.
- **Desventajas:** Pérdida de oportunidades comerciales en instalaciones corporativas y parques industriales donde la empresa de seguridad provee tanto el rondín como la caseta de control de acceso perimetral.

### Opción 3 (Seleccionada): Aplazamiento a Fase 2 (M4) como Módulo Add-on de Pago con Modelo de Recintos Preparado
- **Descripción:** Congelar el desarrollo de visitantes para el MVP (M1/M2/M3), manteniendo el Core concentrado en rondas, cumplimiento operativo, libro de novedades y detección de fraude. Preparar la arquitectura relacional (entidad `Site`) para que en Fase 2 (M4) el módulo de visitas se conecte como un add-on desacoplado y tarifable.
- **Ventajas:**
  - Protege el roadmap de entrega y la estabilidad de las rondas offline (#14) y auditoría (#104).
  - Mantiene el APK móvil ligero y optimizado para teléfonos corporativos de bajo presupuesto.
  - Permite estructurar un modelo de cumplimiento legal sólido para la Ley 21.719 con tiempo suficiente.
  - Genera una nueva línea de ingresos (Add-on de pago por recinto de portería).

---

## 3. Decisión de Arquitectura

Se decide **APLAZAR el desarrollo del módulo de Control de Acceso de Visitantes a la Fase 2 (Mito M4)**, bajo las siguientes directrices técnicas y de producto:

1. **No contaminación del Core MVP:** Las tablas centrales de negocio (`patrols`, `scans`, `checkpoints`, `field_events`, `shifts`) no contendrán columnas, referencias ni lógica condicional referente a visitantes o recepción.
2. **Preparación del modelo relacional (`Site` como ancla):** La entidad `Site` (recinto) ya contiene las propiedades necesarias (`id`, `tenant_id`, `branch_name`, `timezone`, `site_business_hours`) para albergar en el futuro entidades subordinadas (`site_visitor_sessions`, `site_visitor_policies`) sin requerir refactorizaciones destructivas.
3. **Mecanismo de contingencia en MVP:** Para eventos aislados de acceso o incidentes con visitas durante las rondas de noche, los guardias utilizarán el **Libro de Novedades / Eventos de Terreno** (`field_events`, issue #124) seleccionando la categoría operativa correspondiente, sin convertirlo en un registro peatonal masivo.
4. **Empaquetado como Add-on en M4:** En Fase 2, la funcionalidad se implementará como un módulo aislado en backend (`apps/api/src/modules/visitors/`) y frontend/mobile (`apps/mobile/src/modules/visitors/`), gobernado por un feature flag de plan (`featureFlags.visitorAccess`) y permisos RBAC específicos (`visitors:manage`, `visitors:register`).

---

## 4. Análisis de Viabilidad Técnica: OCR MRZ en Gama Baja

### 4.1. Anatomía de la Cédula Chilena (Registro Civil / ICAO 9303)
La cédula de identidad chilena vigente contiene en su reverso una zona de lectura mecánica (MRZ) de formato **TD1** (3 líneas de 30 caracteres alfanuméricos) que codifica tipo de documento, país emisor (CHL), número de documento, dígito verificador, fecha de nacimiento, sexo, fecha de expiración, nacionalidad y RUN/RUT del titular.

```
I<CHL12345678<9<<<<<<<<<<<<<<<
9001014M3001018CHL<<<<<<<<<<<8
APELLIDO<PATERNO<<NOMBRES<<<<<
```

### 4.2. Restricciones de Hardware en Terreno
Los teléfonos asignados por empresas de seguridad a guardias de garita son habitualmente terminales Android de gama de entrada (ej. Samsung Galaxy A04/A05, Motorola Moto E13/G14, Xiaomi Redmi A2/A3):
- **Cámaras de bajo costo:** Sensores con pobre rango dinámico, ausencia de estabilización óptica y lentes con distancia mínima de enfoque larga (dificultad para enfocar texto pequeño a 10–15 cm).
- **Condiciones lumínicas:** Casillas de guardia perimetral con iluminación fluorescente tenue, reflejos intensos sobre el laminado plástico protector de la cédula o desgaste físico (cédulas rayadas/borrosas).
- **Capacidad de cómputo y RAM:** Equipos con 2 GB a 3 GB de memoria RAM. La inicialización de modelos de visión (Google ML Kit Text Recognition o Tesseract OCR embebido) consume entre 120 MB y 250 MB de memoria de trabajo, provocando recolecciones de basura frecuentes y cierres abruptos por *Out-Of-Memory* (OOM) en Android Go / Android estándar.

### 4.3. Evaluación de Alternativas de Reconocimiento

| Mecanismo OCR / Lectura | Tasa de Acierto en Gama Baja | Latencia Promedio | Impacto en App / Red | Veredicto |
|---|---|---|---|---|
| **On-Device ML Kit (Offline)** | 60% – 75% en condiciones de garita | 800 ms – 2.5 s | +22 MB al binario APK; alto consumo de RAM | Inviable en MVP; descartado para gama baja |
| **Server-Side OCR (Envío de foto)** | 85% – 92% | 3.5 s – 7.0 s (dependiente de 3G/4G) | Alto consumo de datos móviles y fotos pesadas | Inviable para operaciones rápidas en barrera |
| **Escaneo de Código de Barras PDF417 / QR** | 90% – 98% (muy sensible a rayas) | 150 ms – 400 ms | +1.5 MB (ZXing/MLKit Barcode) | Viable técnicamente para M4 |
| **Ingreso Manual con Validación Módulo 11** | 100% (con feedback de formato) | 3 s – 5 s (tecleo del guardia) | 0 kB adicionales (algoritmo liviano TypeScript) | **Estrategia base de respaldo mandatoria** |

**Conclusión técnica:** Ningún motor OCR en dispositivo de gama baja ofrece la confiabilidad requerida para una garita vehicular en hora punta sin generar colas. Cuando se implemente en M4, la arquitectura priorizará la lectura del código de barras 2D/QR de la cédula y mantendrá siempre como flujo principal o de rescate el ingreso asistido de RUT con validación automática de dígito verificador (Módulo 11 chileno).

---

## 5. Cumplimiento Normativo: Ley 21.719 de Protección de Datos Personales

La Ley 21.719 (que moderniza la Ley 19.628 y crea la Agencia de Protección de Datos Personales en Chile) impone exigencias estrictas que impactan directamente el tratamiento de datos de visitas:

### 5.1. Principio de Proporcionalidad y Minimización (Art. 3°)
- **Riesgo:** Capturar fotografías de la cédula completa de un tercero implica registrar datos innecesarios para la seguridad física del recinto (ej. firma del titular, profesión, lugar de nacimiento, código de documento del Registro Civil).
- **Directriz de diseño para M4:** El sistema **NO almacenará imágenes de la cédula de identidad** en el servidor de archivos. Solo se almacenarán los datos estrictamente necesarios para el control de acceso:
  1. Nombre y Apellidos.
  2. RUT / RUN o Pasaporte (documento de identidad).
  3. Empresa / Procedencia.
  4. Persona o Unidad de destino (`Host`).
  5. Marca/Patente del vehículo (si aplica).
  6. Timestamp exacto de ingreso y salida.

### 5.2. Fotografías Faciales de Terceros
- La captura de la fotografía del rostro del visitante constituye un dato biométrico/sensible bajo la Ley 21.719.
- Exige **base de licitud explícita** (interés legítimo debidamente justificado por razones de seguridad de la instalación o consentimiento informado expreso en el punto de registro mediante señalética visible).
- Su almacenamiento debe tener retención acotada independiente del archivo de rondas.

### 5.3. Política de Retención y Purga Automática
- Los datos de visitas no pueden persistir indefinidamente.
- En M4 se implementará una regla configurable `visitorRetentionDays` (con default estricto de **30 días**, extensible máximo a 90 días por requerimiento contractual del cliente).
- Cumplido el plazo, las filas de accesos de visitas se anonimizarán o eliminarán mediante un job de purga programado en PostgreSQL.

### 5.4. Ejercicio de Derechos ARCOP y Aislamiento Multitenant
- Si un visitante ejerce su derecho de Cancelación/Supresión (ARCOP), el sistema debe permitir al ADMIN del tenant anonimizar las referencias personales de dicho visitante sin romper la integridad referencial de los logs de acceso históricos.
- La función de exportación y purga completa del tenant (`docs/borrado-y-exportacion.md`, issue #33) cubrirá automáticamente las futuras tablas de visitas gracias al descubrimiento dinámico de la columna `tenant_id`.

---

## 6. Consecuencias de la Decisión

### Consecuencias Positivas
1. **Foco y Calidad en MVP:** El equipo de desarrollo concentra el 100% del esfuerzo en la excelencia de rondas, prevención de fraude de guardias (#11, #60), sincronización offline bidireccional (#14) y reportabilidad ejecutiva en PDF (#60, #308).
2. **Estabilidad de la App Móvil:** Cero incremento de tamaño del bundle ni degradación de memoria en dispositivos de gama baja durante M1/M2/M3.
3. **Reducción de Riesgo Regulatorio:** No se asumen pasivos legales por tratamiento indebido de datos de terceros durante la fase de validación inicial del producto.
4. **Monetización Clara:** Permite empaquetar el Control de Visitas como un producto Add-on de alto valor agregado en M4 con tarificación por punto de portería/garita activa.

### Consecuencias Negativas y Mitigaciones
1. **Objeción Comercial en Licitaciones Integradas:** Algunos prospectos solicitarán una solución única de portería y rondas.
   - *Mitigación:* Capacitar al equipo comercial para posicionar a SentryCore como el líder indiscutido en auditoría, cumplimiento de guardias y prueba jurídica de rondas. Comunicar que el módulo de visitas forma parte oficial del Roadmap M4 (Fase 2).
2. **Registro de Contingencia en Caseta:** Guardias que deban registrar un incidente con una visita sospechosa en la noche.
   - *Mitigación:* Utilizar el módulo existente de Libro de Novedades (`field_events`), el cual permite adjuntar observaciones y fotografía de la situación como evento operativo de seguridad.

---

## 7. Plan de Transición hacia Fase 2 (M4)

Cuando se inicie el desarrollo de M4, se ejecutarán los siguientes pasos técnicos:
1. **Esquema de Base de Datos:** Creación de migraciones TypeORM aisladas para tablas `visitors`, `visitor_passes`, `visitor_access_logs` y `site_visitor_policies`, todas protegidas con RLS (`tenant_id = app_tenant_id()`).
2. **Permisos RBAC:** Incorporación de permisos granulares en `packages/shared/src/permissions.ts`:
   - `visitors:read` (SUPERVISOR, ADMIN)
   - `visitors:register` (GUARDIA en caseta de acceso)
   - `visitors:manage` (ADMIN)
3. **Submódulo Móvil Dedicado:** Implementación en Expo/React Native de un modo "Portería" alternativo al modo "Ronda", permitiendo lectura de códigos de barra por hardware o cámara ligera y teclado numérico asistido para RUT.
4. **Feature Gate:** Integración con `packages/shared/src/rules.ts` en `featureFlagsSchema` bajo la clave `visitorAccess: z.boolean().default(false)`.
