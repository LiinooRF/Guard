# Protocolo de Prueba de Aceptación: Ronda Completa en Móvil (Issue #230)

- **Estado**: APROBADO PARA EJECUCIÓN
- **Versión**: 1.0.0
- **Fecha**: 2026-08-18
- **Issues vinculados**: #230 (Prueba aceptación ronda móvil), #5 (App guardia Android), #11 (Escaneo NFC nativo), #14 (Modo offline y sincronización), #15 (Geolocalización y traza), #17 (Informes PDF y despacho), #122 (Libro de novedades y pánico), #137 (Rendimiento en gama baja), #217 (Onboarding móvil)

---

## 1. Propósito y Alcance

Este documento establece el **protocolo formal de pruebas de aceptación en terreno (FAT - Field Acceptance Testing)** para la aplicación móvil de SentryCore en dispositivos físicos Android.

El objetivo es validar de punta a punta la experiencia operativa del guardia bajo condiciones reales de trabajo en recintos de seguridad privada en Chile (subterráneos sin señal, estacionamientos perimetrales, galpones con interferencia electromagnética y equipos de gama baja con capas de personalización de fabricantes).

> **Regla de oro de QA**: Ningún feature se considera terminado con pruebas en emulador o con WiFi de oficina. La certificación de release de la app móvil exige la ejecución íntegra y sin no-conformidades bloqueantes de esta matriz sobre hardware físico de referencia con el build de **preview/release** (`npm run build:preview`).

---

## 2. Dispositivos de Referencia y Entorno de Prueba

La prueba debe ejecutarse en al menos **dos perfiles de hardware físico**:

### 2.1. Matriz de Equipos de Prueba

| Perfil | Equipo de Referencia | Hardware / SO | Requisitos Críticos |
|---|---|---|---|
| **Tier 1 (Gama Baja — Límite de soporte)** | Motorola Moto G35 / Moto G24 / Samsung Galaxy A05s | 2–3 GB RAM, SoC Unisoc/Helio, Android 13/14 (o Android Go) | **Antena NFC física activa**, almacenamiento disponible < 4 GB, cámara trasera funcional. |
| **Tier 2 (Gama Media Corporativa)** | Samsung Galaxy A15 / A25 / Xiaomi Redmi Note 13 | 4–6 GB RAM, SoC Exynos/Snapdragon, Android 14/15 | NFC, GPS de doble frecuencia, 4G LTE en bandas B7 / B28 (Chile). |

### 2.2. Condiciones Previas y Setup del Entorno

1. **Compilado de Release**: APK generado con `npm run build:preview` (firmado, con R8/minificación y `shrinkResources` activos). Prohibido usar build de `development` o Expo Go.
2. **Preparación de la Batería**: Dispositivo cargado al **100%** al inicio. Se conecta a `adb` únicamente para lectura de logs antes y después, **no durante la ronda** (para no alterar la medición de consumo energético).
3. **Tarjeta SIM y Conectividad**: Chip 4G/LTE de operador chileno (Entel, Movistar o Claro/Wom) con saldo de datos activo.
4. **Recinto de Prueba**: Recinto demo o instalación física con al menos **4 puntos de control balizados con tags NFC NTAG213/215/216** (incluyendo al menos 1 punto con QR de respaldo `VXQ-*`, 1 punto crítico con requerimiento obligatorio de foto y 1 punto marcado como `isClosingPoint`).

---

## 3. Matriz de los 9 Pasos del Recorrido Operativo

```
  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
  │   PASO 1    │ ──► │   PASO 2    │ ──► │   PASO 3    │
  │ Login y     │     │ Permisos GPS│     │ Escaneo NFC │
  │ Firma Disp. │     │ Consent. Ley│     │ Punto 1     │
  └─────────────┘     └─────────────┘     └──────┬──────┘
                                                 │
  ┌─────────────┐     ┌─────────────┐     ┌──────▼──────┐
  │   PASO 6    │ ◄── │   PASO 5    │ ◄── │   PASO 4    │
  │ Botón de    │     │ Libro Noved.│     │ Foto Cám.X  │
  │ Pánico SOS  │     │ Anotación   │     │ Punto Crít. │
  └──────┬──────┘     └─────────────┘     └─────────────┘
         │
  ┌──────▼──────┐     ┌─────────────┐     ┌─────────────┐
  │   PASO 7    │ ──► │   PASO 8    │ ──► │   PASO 9    │
  │ Modo Avión  │     │ Cierre de   │     │ Informe PDF │
  │ Offline Sync│     │ Ronda       │     │ Despacho Mail
  └─────────────┘     └─────────────┘     └─────────────┘
```

---

### Paso 1: Autenticación y Registro de Llave Criptográfica de Dispositivo
- **Acción**:
  1. Abrir la app desde el launcher de Android (medir tiempo de arranque frío, Reloj A < 2.5s).
  2. Ingresar credenciales del guardia demo (`guardia@demo-andina.test` / password).
  3. Presionar "Iniciar Sesión".
- **Comportamiento Esperado**:
  - Autenticación exitosa mediante cookie segura `HttpOnly`.
  - El puente nativo (`sentrycore.bridge`) negocia versión de protocolo (`PROTOCOLO_MAJOR=1`, `PROTOCOLO_MINOR=5`).
  - La app genera de forma transparente una llave HMAC de 32 bytes y registra el dispositivo mediante `POST /api/guard/device-signing-key`.
- **Criterio de Aceptación**:
  - Tiempo de login y transición a home < 2.0 segundos en 4G.
  - En la base de datos se crea/actualiza la llave del `device_id` para ese usuario.

---

### Paso 2: Divulgación Destacada y Permisos de Ubicación (GPS)
- **Acción**:
  1. En el primer ingreso, la app despliega la pantalla de consentimiento de geolocalización conforme a la normativa laboral chilena y requisitos de Google Play.
  2. El usuario revisa la política y presiona "Acepto el aviso de geolocalización".
  3. El sistema operativo solicita permiso de ubicación en primer plano (`ACCESS_FINE_LOCATION`) y luego en segundo plano (`ACCESS_BACKGROUND_LOCATION`).
- **Comportamiento Esperado**:
  - La aceptación se persiste en el backend vía `POST /api/geo/consent` y `POST /api/geo/permission`.
  - Se inicia el servicio foreground de rastreo periódico (`track.start` con intervalo de 60s).
  - Aparece en la barra de estado de Android la **notificación permanente**: *"SentryCore — Ronda de vigilancia en curso"*.
- **Criterio de Aceptación**:
  - La notificación permanente no puede ser descartada manualmente por el guardia mediante swipe.
  - Sin consentimiento previo, la app no permite iniciar rondas (falla cerrada).

---

### Paso 3: Asignación e Inicio de Ronda con Escaneo NFC de Punto
- **Acción**:
  1. El guardia visualiza su turno programado en la pantalla principal (`GET /api/guard/home`).
  2. Presiona "Iniciar Ronda".
  3. Se aproxima al Checkpoint 1 y acerca el reverso del teléfono a la etiqueta NFC (NTAG213).
- **Comportamiento Esperado**:
  - El lector nativo (`react-native-nfc-manager`) captura el UID hexadecimal.
  - Se calcula la firma digital local (`v1, clientScanId, deviceId, uid, method, scannedAt, lat, lng, accuracyM`).
  - Se dispara feedback háptico (vibración corta) y auditivo de éxito.
  - El punto cambia inmediatamente a estado "Escaneado" con hora local del recinto.
- **Criterio de Aceptación**:
  - **Latencia de escaneo**: < 500 ms entre el contacto físico de la antena y el feedback táctil/visual; < 2.0 segundos para la confirmación de sincronización HTTP con el servidor en 4G.

---

### Paso 4: Evidencia Fotográfica en Punto Crítico
- **Acción**:
  1. El guardia escanea el Checkpoint 2 (marcado con regla `photoRequired = true`, ej. portón perimetral o sala de servidores).
  2. La app bloquea el avance del punto hasta capturar la fotografía requerida.
  3. Presionar "Tomar Foto". Se abre la interfaz de cámara nativa (CameraX).
  4. Encuadrar y capturar la imagen.
- **Comportamiento Esperado**:
  - La imagen se comprime en el dispositivo (JPEG calidad 80%, resolución máx 1920x1080) reduciendo su peso a < 600 KB.
  - La subida se realiza directamente a `POST /api/guard/scans/:scanId/photo` con cabeceras multipart utilizando la cookie de sesión.
  - **Seguridad antifraude**: Queda totalmente deshabilitada cualquier opción de seleccionar imágenes desde la galería del teléfono o almacenamiento externo.
- **Criterio de Aceptación**:
  - Tiempo de obturación, compresión y preview en pantalla < 1.5 segundos.
  - Subida en segundo plano confirmada sin bloquear la navegación del guardia.

---

### Paso 5: Registro de Novedad en Terreno (Libro de Novedades)
- **Acción**:
  1. Durante el trayecto entre puntos, el guardia detecta una anomalía (ej. luminaria rota o candado forzado).
  2. Presiona el botón flotante "Registrar Novedad / Incidencia".
  3. Selecciona categoría: "Infraestructura", criticidad: "Media", escribe descripción: *"Luminaria poste 4 apagada"* y adjunta foto opcional.
  4. Presiona "Enviar Novedad".
- **Comportamiento Esperado**:
  - La novedad se registra como evento inmutable en el libro de novedades (`POST /api/guard/events`).
  - Se adjunta automáticamente la coordenada GPS actual del guardia y la estampa de tiempo ISO.
- **Criterio de Aceptación**:
  - El evento queda registrado en el libro de novedades de la base de datos con carácter append-only (no editable ni eliminable).
  - La UI muestra confirmación con badge de estado.

---

### Paso 6: Activación y Despacho del Botón de Pánico (SOS)
- **Acción**:
  1. Mantener presionado el botón rojo de "Pánico / SOS" durante 1.5 segundos (mecanismo anti-toque accidental).
  2. Sentir la vibración continua de advertencia y confirmar el disparo de la emergencia.
- **Comportamiento Esperado**:
  - La app emite un evento de máxima prioridad (`criticidad: 'critica'`, `tipo: 'panico'`).
  - Se despacha inmediatamente al backend `POST /api/guard/panic` con GPS de alta precisión.
  - En el panel web del supervisor (`apps/web`), la alarma se refleja en tiempo real (alerta sonora y visual en el mapa).
- **Criterio de Aceptación**:
  - Tiempo de despacho y acuse de recibo en servidor < 1.0 segundo bajo 4G.
  - Si el teléfono está con poca señal, el pánico se reintenta agresivamente cada 3 segundos hasta obtener confirmación.

---

### Paso 7: Prueba de Resistencia Offline (Modo Avión) y Sincronización
- **Acción**:
  1. **Activar Modo Avión** en Android (desconectar WiFi y Datos Móviles por completo).
  2. Verificar que la app muestra el banner discreto *"Modo sin conexión — Los datos se sincronizarán al recuperar señal"*.
  3. Escanear Checkpoint 3 (NFC) y Checkpoint 4 (usando código QR de respaldo `VXQ-xxx` con la cámara).
  4. Registrar una novedad offline.
  5. **Apagar la pantalla del teléfono y guardarlo en el bolsillo durante 20 minutos** (simulando trayecto subterráneo y forzando el modo Doze de Android).
  6. Sacar el teléfono, desbloquear y **Desactivar el Modo Avión** (restaurar 4G/WiFi).
- **Comportamiento Esperado**:
  - La app y su servicio en segundo plano sobreviven los 20 minutos sin ser eliminados por el Low Memory Killer (`lmkd`) ni por el gestor de batería del fabricante.
  - Todos los escaneos y eventos se encolaron en SQLite local (`sync-queue`).
  - Al detectar red, se dispara automáticamente el proceso de vaciado (`sync.queue.flush`).
  - El backend recibe e inserta los escaneos respetando el `scannedAt` original del dispositivo y verificando las firmas criptográficas.
- **Criterio de Aceptación**:
  - **Cero pérdida de datos**: 100% de los escaneos y fotos tomados offline se sincronizan exitosamente.
  - **Cero duplicados**: Las claves de idempotencia (`clientScanId`) evitan registros repetidos.
  - Tiempo total de sincronización de la cola offline tras recuperar red < 5.0 segundos.

---

### Paso 8: Escaneo de Punto Final y Cierre Automático de Ronda
- **Acción**:
  1. El guardia escanea el último punto de la ruta, configurado como punto de cierre (`isClosingPoint = true`).
  2. La app procesa el escaneo y evalúa la regla de cumplimiento de la ronda (`computeCompliance()`).
  3. La app muestra la pantalla de resumen: porcentaje de cumplimiento obtenido (ej. 100% o 85%), tiempo total empleado y total de novedades.
  4. Presionar "Finalizar Ronda".
- **Comportamiento Esperado**:
  - La ronda cambia su estado en la base de datos a `completada` (`patrols.status = 'completada'`).
  - El servicio de rastreo en segundo plano se detiene (`track.stop`).
  - La notificación permanente de la barra de estado de Android **desaparece inmediatamente** (cumpliendo con la garantía legal de no rastreo fuera de turno).
- **Criterio de Aceptación**:
  - Cierre formal de la ronda registrado en base de datos.
  - La app vuelve a su estado de espera de siguiente turno.

---

### Paso 9: Generación y Despacho Automatizado del Informe por Correo
- **Acción**:
  1. Tras el cierre de la ronda, el backend NestJS dispara el evento de compilación del informe PDF (#17).
  2. El PDF se encola en BullMQ (`mail` queue) y se procesa mediante `NodemailerMailProvider` hacia el relay transaccional configurado (AWS SES / Resend según ADR 040).
  3. El supervisor y el administrador del tenant revisan sus bandejas de entrada.
- **Comportamiento Esperado**:
  - El correo llega en < 60 segundos a las casillas destinatarias (@empresa.cl, @gmail.com, @outlook.com).
  - El correo incluye el PDF adjunto (con resumen ejecutivo, tabla de escaneos con hora/GPS, fotos incrustadas y mapa de calor de cumplimiento).
  - El webhook del proveedor de correo notifica `entregado` a `/api/mail/webhook` y la tabla `mail_deliveries` actualiza el estado a `entregado`.
- **Criterio de Aceptación**:
  - Entrega efectiva en bandeja principal (inbox), no en carpeta de spam/promociones.
  - El PDF abre correctamente, sin corrupción de fuentes ni imágenes rotas.

---

## 4. Criterios de Aceptación No Funcionales y Métricas

| Parámetro | Métrica Objetivo | Límite Máximo Aceptable | Herramienta de Medición |
|---|---|---|---|
| **Latencia de Escaneo NFC** | < 300 ms (feedback háptico) | **< 2.0 s** (Roundtrip completo API) | `logcat` / Cronómetro de alta velocidad |
| **Tiempo de Arranque en Frío (Reloj A)** | < 1.5 s (Splash) | **< 2.5 s** | `adb shell am start -W -n com.voxtilabs.sentrycore/.MainActivity` |
| **Tiempo de Carga del Portal (Reloj B)** | < 3.0 s (Portal interactivo) | **< 6.0 s** (en red 4G real) | Grabación de pantalla con `screenrecord` |
| **Consumo de Batería por Hora** | < 3.5% / hora | **< 6.0% / hora** (con GPS + NFC activo) | `adb shell dumpsys batterystats` |
| **Consumo de Memoria RAM (PSS)** | < 120 MB | **< 180 MB** (en equipo de 2 GB) | `adb shell dumpsys meminfo com.voxtilabs.sentrycore` |
| **Estabilidad de Proceso** | 0 ANRs, 0 Crashes | **0 fallos no controlados** | `logcat` / Sentry Crash Reporting |
| **Tasa de Entrega Offline** | 100% de eventos | **100%** (Cero tolerancia a pérdida) | Auditoría comparativa SQLite vs PostgreSQL |

---

## 5. Registro y Matriz de No-Conformidades (NC)

Toda desviación observada durante la ejecución física de esta prueba debe registrarse en la siguiente matriz categorizada por severidad:

- **P0 (Bloqueante)**: Impide completar la ronda, pierde datos offline, crashea la app o bloquea el login.
- **P1 (Crítica)**: Falla de cámara, latencia de escaneo > 3s, notificación persistente que no se apaga, o informe no despachado.
- **P2 (Menor / Cosmética)**: Textos desalineados en pantallas pequeñas, retraso menor en feedback háptico.

### Plantilla de Registro de Hallazgos

| ID NC | Severidad | Paso Afectado | Dispositivo / SO | Descripción del Defecto | Causa Raíz Técnica | Acción Correctiva / PR | Estado |
|---|---|---|---|---|---|---|---|
| **NC-01** | P1 | Paso 7 (Offline) | Moto G24 (Android 14) | El servicio de traza en segundo plano se detuvo tras 15 min en reposo. | Gestor de batería agresivo de Motorola (*Moto Battery Saver*) suspendió el WebView. | Agregar guía de exclusión de optimización de batería en onboarding y validar *Foreground Service WakeLock*. | Corregido |
| **NC-02** | P2 | Paso 4 (Foto) | Galaxy A05s (Android 13) | Retardo de 1.8s al abrir la vista previa de la cámara CameraX. | Inicialización pesada de resolución 4K por defecto en sensor de 50 MP. | Fijar `targetResolution: 1080p` en la configuración de CameraX. | En Revisión |
| **NC-03** | P1 | Paso 9 (Correo) | Servidor / SES | Correo de informe cayó en carpeta "No deseado" en cuenta `@outlook.com`. | Registro SPF en DNS no incluía el subdominio `mail.sentrycore.io`. | Actualizar registro DNS TXT en Cloudflare/Route53 (ADR 040). | Corregido |

---

## 6. Procedimiento de Certificación y Firma de Salida

Para declarar la versión móvil como **Apta para Producción (Release Ready)**:

1. Ejecución completa del recorrido de 9 pasos en al menos 2 dispositivos físicos de la matriz.
2. Todas las no-conformidades **P0 y P1** deben estar resueltas y verificadas con re-test.
3. El reporte de ejecución debe ser firmado por el responsable de QA y el líder de infraestructura.
