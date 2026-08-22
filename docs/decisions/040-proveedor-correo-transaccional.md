# ADR 040 — Proveedor de correo transaccional y estrategia de fallback agnóstica

- **Estado**: ACEPTADA
- **Fecha**: 2026-08-18
- **Issues vinculados**: #40 (Spike proveedor transaccional), #9 (Decisión abierta proveedor correo), #39 (Mail provider), #41 (Cola BullMQ), #44 (Registro de envíos y webhooks), #17 (Informes PDF de ronda)

---

## 1. Contexto y Problema

SentryCore es una plataforma SaaS multi-tenant *white-label* orientada a empresas de seguridad privada y monitoreo de rondas de vigilancia en Chile y Latinoamérica. El canal de correo electrónico es un componente de infraestructura crítico para la operación del producto:

1. **Notificaciones inmediatas y de alta criticidad**: Invitaciones de onboarding a administradores y supervisores (#1), restablecimiento de credenciales, y alertas operativas urgentes (botón de pánico disparado, caída de cumplimiento bajo el 70%).
2. **Despacho masivo y periódico de informes ejecutivos en PDF (#17)**: Al completarse cada ronda de vigilancia, el sistema genera automáticamente un informe en PDF (que incluye tabla de puntos, evidencias fotográficas, cálculo de cumplimiento y traza cartográfica) y lo envía a la casilla del supervisor y del cliente final. Los adjuntos pesan típicamente entre 500 KB y 4 MB.
3. **Multi-tenant y White-Label (#19, #119)**: Cada empresa cliente (*tenant*) requiere emitir correos con su identidad corporativa (nombre de fantasía, logo, remitente `no-reply@empresa.cl` o delegado vía subdominio de plataforma).

### Requisitos no negociables del sistema

- **Cero acoplamiento a SDKs propietarios**: La arquitectura de correo de SentryCore (`apps/api/src/mail/`) se construyó deliberadamente sobre la abstracción `MailProvider` y el transporte genérico estándar `NodemailerMailProvider` (`MAIL_DRIVER=smtp`). No se admite código en la API que dependa de librerías propietarias (`@aws-sdk/client-ses`, `resend`, `postmark`), manteniendo la portabilidad absoluta mediante SMTP estándar sobre TLS.
- **Entregabilidad garantizada**: Los correos no pueden caer en spam ni ser rechazados por servidores corporativos con políticas estrictas (Microsoft 365 / Exchange en dominios corporativos chilenos `@empresa.cl`, Google Workspace) ni por casillas personales masivas (`@gmail.com`, `@outlook.com`, `@hotmail.com`, `@yahoo.com`).
- **Trazabilidad y Webhooks de entrega (#44, #220)**: El sistema requiere conocer el estado real de cada mensaje (`encolado` → `enviado` → `entregado` / `rebotado` / `reclamo` / `fallido`). La ingesta de webhooks se realiza mediante el contrato desacoplado `NOTIF_WEBHOOK_DRIVER=interno` (`registro-envios.traductor.ts`), protegiendo el endpoint con firma criptográfica HMAC-SHA256.
- **Eficiencia de costos fijos y variables**: El volumen de rondas genera cientos o miles de correos con adjuntos diarios por empresa. Un modelo de cobro excesivo por millar de envíos o por volumen de datos adjuntos penaliza directamente el margen operativo del SaaS.

---

## 2. Análisis Comparativo de Alternativas

Se evaluaron en profundidad las tres opciones líderes del mercado transaccional: **AWS SES (Amazon Simple Email Service)**, **Resend** y **Postmark**.

| Criterio | AWS SES (Amazon Web Services) | Resend | Postmark (ActiveCampaign) |
|---|---|---|---|
| **Latencia hacia Chile / LATAM** | **Excelente (35–45 ms en `sa-east-1` São Paulo; 120–140 ms en `us-east-1`)**. Conexión SMTP directa con endpoints regionales. | **Buena (~130–160 ms)**. Infraestructura basada en US-East (AWS us-east-1). | **Buena (~140–170 ms)**. Infraestructura basada en EE.UU. (Chicago / Virginia). |
| **Entregabilidad corporativa (Exchange / M365 / Gmail)** | **Muy Alta**. Requiere configuración cuidadosa de Easy DKIM (2048-bit), SPF y DMARC. Reputación de IP compartida sólida con opción de IP dedicada. | **Excelente**. IPs precalentadas de alta reputación. Optimizado para evitar la pestaña de promociones y filtros heurísticos. | **Sobresaliente (Gold Standard)**. Separación estricta al 100% entre flujos transaccionales y de marketing. Menor tasa de rebote falso en Microsoft 365. |
| **Soporte White-Label (DKIM / DMARC por tenant)** | **Nativo y granular**. *Configuration Sets*, identidades de dominio delegadas, verificación automática CNAME (Easy DKIM) y soporte para *custom MAIL FROM domain* (`mail.tenant.cl`). | **Muy amigable vía API/Dashboard**. Soporte multi-dominio con generación automática de registros DNS y subdominios de envío. | **Robusto**. *Sender Signatures*, *Message Streams* independientes y DKIM delegado por dominio o subdominio. |
| **Compatibilidad con Nodemailer / SMTP (`apps/api/src/mail`)** | **100% estándar**. Credenciales IAM SMTP estándar (usuario/clave generados a partir de IAM policies). Soporta STARTTLS (587) y TLS implícito (465). | **100% estándar**. Servidor `smtp.resend.com` en puertos 465/587 usando API Key como `SMTP_PASSWORD` y `resend` como `SMTP_USER`. | **100% estándar**. Servidor `smtp.postmarkapp.com` en puertos 587/2525 usando el Server API Token como usuario y contraseña. |
| **Gestión de Webhooks y Estados de Entrega** | Vía Amazon SNS → Endpoint Relay HTTP (o SNS HTTP subscription directa) → `registro-envios.traductor-interno.ts`. | Webhooks nativos con firma Svix (`resend-signature`) traducibles mediante relay o adaptador interno. | Webhooks nativos JSON con cabecera de autenticación o token compartido. |
| **Estructura de Costos Fijos y Variables** | **$0 costo fijo base**. **$0.10 USD por 1,000 correos** + $0.12 USD/GB de adjuntos. La opción más económica a cualquier escala. | Capa gratuita: 3,000 correos/mes (100/día). Plan Pro: **$20 USD/mes** (incluye 50,000 correos, luego $0.40 USD/1k). | Capa gratuita de prueba: 100 correos. Plan inicial: **$15 USD/mes** (incluye 10,000 correos, luego $1.50 USD/1k). |
| **Fricción Operativa y Onboarding** | Inicialmente en *SES Sandbox* (límite 200 correos/día a casillas verificadas). Requiere ticket de justificación técnica para pase a producción (demora 24-48 hrs). | Inmediato (onboarding en minutos mediante UI/API). | Requiere aprobación manual de cuenta por equipo de soporte anti-spam de Postmark (24 hrs). |

---

## 3. Decisión

Se adopta una **estrategia híbrida de proveedor primario con respaldo (failover) transparente**, gobernada por configuración de entorno y sin librerías propietarias:

### 3.1. Proveedor Primario: AWS SES (`sa-east-1` / `us-east-1`)
AWS SES es seleccionado como el **proveedor transaccional principal de producción** debido a:
1. **Rendimiento y cercanía regional**: Endpoints en `sa-east-1` (São Paulo) que garantizan latencias de conexión TCP/TLS de ~38 ms desde el VPS de SentryCore en Santiago de Chile.
2. **Economía de escala para informes pesados (#17)**: Con miles de PDF despachados mensualmente, el costo de $0.10 USD / 1,000 mensajes representa un ahorro del 75% al 93% respecto a Resend y Postmark.
3. **Madurez multi-tenant**: Gestión formal de identidades delegadas, políticas DMARC/DKIM de 2048 bits por tenant y aislamiento de reputación vía *Configuration Sets*.

### 3.2. Proveedor Secundario / Fallback de Alta Disponibilidad: Resend
Resend se establece como el **proveedor de respaldo inmediato (hot-standby)**:
1. Permite activación inmediata cambiando únicamente 3 variables de entorno en Dokploy (`SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`, `SMTP_PASSWORD=re_xxx`), sin redesplegar código ni reiniciar dependencias.
2. Utilizado como entorno de contingencia ante incidentes globales de AWS o en caso de retraso administrativo en la apertura de cuotas en SES.

### 3.3. Principio Rector: Aislamiento mediante SMTP Estándar y Nodemailer
- **Ningún SDK de terceros entra al código fuente de la API**: Todo el despacho se ejecuta a través de `NodemailerMailProvider` (`apps/api/src/mail/nodemailer-mail-provider.ts`).
- Cambiar de proveedor primario a secundario o viceversa es una operación de configuración de infraestructura (1 minuto en el panel de secretos de Dokploy) y no requiere intervención de código ni compilaciones de TypeScript.

---

## 4. Configuración y Variables de Entorno

### 4.1. Configuración para Producción (AWS SES Primario)
En el gestor de secretos de Dokploy para el entorno `production`:

```env
# Conductor y transporte
MAIL_DRIVER=smtp
MAIL_FROM=SentryCore <notificaciones@sentrycore.io>
SMTP_HOST=email-smtp.sa-east-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=AKIAIOSFODNN7EXAMPLE
SMTP_PASSWORD=BKbxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Seguridad y reputación
MAIL_BLOCKED_DOMAINS=
MAIL_ALLOW_RESERVED_DOMAINS=false

# Webhooks de estado de entrega (#44, #220)
NOTIF_WEBHOOK_DRIVER=interno
NOTIF_WEBHOOK_SECRET=<<clave-hmac-sha256-generada-64-caracteres>>
```

> **Nota sobre `SMTP_SECURE` en puerto 587**: En el estándar SMTP y Nodemailer, el puerto 587 utiliza negociación **STARTTLS** (arranca en texto claro y escala inmediatamente a TLS 1.3/1.2). Por convención de Nodemailer, `SMTP_SECURE=false` en combinación con `SMTP_PORT=587` activa STARTTLS obligatorio. Si se utiliza el puerto 465 (TLS implícito), se debe configurar `SMTP_SECURE=true`.

### 4.2. Configuración para Contingencia / Fallback (Resend Secundario)
En caso de requerir conmutación a Resend:

```env
MAIL_DRIVER=smtp
MAIL_FROM=SentryCore <notificaciones@sentrycore.io>
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=re_123456789_abcdefghijklmnopqrstuvwxyz
```

---

## 5. Estrategia Multi-Tenant: White-Label, DKIM, SPF y DMARC

Para garantizar que los correos enviados en nombre de los clientes no sean marcados como suplantación de identidad (spoofing), se definen dos modalidades de operación según el plan del tenant:

```
                  ┌───────────────────────────────────────────────────────────┐
                  │                 MODALIDADES DE ENVÍO                     │
                  └─────────────────────────────┬─────────────────────────────┘
                                                │
                 ┌──────────────────────────────┴─────────────────────────────┐
                 ▼                                                            ▼
    ┌─────────────────────────┐                                  ┌─────────────────────────┐
    │  MODALIDAD A: ESTÁNDAR  │                                  │ MODALIDAD B: WHITE-LABEL │
    │   (Dominio Plataforma)  │                                  │   (Dominio del Tenant)  │
    ├─────────────────────────┤                                  ├─────────────────────────┤
    │ From: "Empresa Andina   │                                  │ From: "Empresa Andina   │
    │ <notif@sentrycore.io>"  │                                  │ <alertas@seguridad.cl>" │
    │ Reply-To:               │                                  │ DKIM/DMARC delegado vía │
    │ operaciones@andina.cl   │                                  │ CNAMEs en DNS del cliente│
    └─────────────────────────┘                                  └─────────────────────────┘
```

### 5.1. Modalidad A (Estándar por Defecto — Sin configuración DNS del cliente)
- **Remitente visible (`From`)**: `"Nombre de Fantasía Tenant" <notificaciones@sentrycore.io>`
- **Cabecera `Reply-To`**: `contacto-operaciones@empresa-cliente.cl`
- **Autenticación**: Firmado 100% con los registros SPF, DKIM (2048-bit) y DMARC (`p=reject`) del dominio raíz `sentrycore.io`.
- **Ventaja**: Cero fricción técnica en el onboarding del cliente; entrega inmediata sin intervención de su área de TI.

### 5.2. Modalidad B (White-Label Avanzado — Dominio del Cliente)
- **Remitente visible (`From`)**: `"Nombre de Fantasía Tenant" <alertas@seguridad-andina.cl>`
- **Requisitos de delegación DNS para el cliente**:
  1. **DKIM (Easy DKIM - 3 registros CNAME)**:
     - `xxx._domainkey.seguridad-andina.cl` → `xxx.dkim.amazonses.com`
     - `yyy._domainkey.seguridad-andina.cl` → `yyy.dkim.amazonses.com`
     - `zzz._domainkey.seguridad-andina.cl` → `zzz.dkim.amazonses.com`
  2. **Custom MAIL FROM (SPF)**:
     - Subdominio `mail.seguridad-andina.cl` con registro MX `feedback-smtp.sa-east-1.amazonses.com` y TXT `"v=spf1 include:amazonses.com ~all"`.
  3. **DMARC**:
     - `_dmarc.seguridad-andina.cl` TXT `"v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@sentrycore.io"`

---

## 6. Integración con el Registro de Envíos y Webhooks (#44, #220)

El ciclo de vida de cada correo en SentryCore se mapea a través de la cola de BullMQ (`MailQueueService`) y la tabla de auditoría `mail_deliveries`:

```
 [Evento de Negocio] (Cierre Ronda / Invitación)
         │
         ▼
 ┌──────────────────┐
 │  MailQueueService│ ──► [Redis BullMQ: 'mail'] ──► Estado: 'encolado'
 └──────────────────┘
         │ (Job Processor)
         ▼
 ┌──────────────────────┐
 │ NodemailerMailProvider│ ──► [SMTP Relay SES/Resend] ──► Estado: 'enviado' (con Message-ID)
 └──────────────────────┘
         │
         ▼
  Servidor Destino (Gmail / M365)
         │
         ▼ (Notificación asíncrona)
 ┌──────────────────────┐
 │ Proveedor (SES/SNS)  │ ──► [Relay Webhook HMAC] ──► POST /api/mail/webhook
 └──────────────────────┘                                       │
                                                                ▼
                                                   ┌─────────────────────────┐
                                                   │ TraductorContratoInterno│
                                                   └────────────┬────────────┘
                                                                │
                                      ┌─────────────────────────┴─────────────────────────┐
                                      ▼                                                   ▼
                          Evento: 'entregado'                               Evento: 'rebotado' / 'reclamo'
                          (Confirma recepción buzón)                         (Registra fallo, alerta soporte)
```

1. **Idempotencia y Correlación**: Cada envío registra su `messageId` asignado por el servidor SMTP en `mail_deliveries`. Al recibir un webhook del proveedor, el `TraductorContratoInterno` correlaciona el `messageId` y actualiza la fila correspondiente de forma atómica e idempotente.
2. **Protección de Reputación (#86, `mail-dominios.ts`)**: Los rebotes duros (*Hard Bounces*) y quejas de spam (*Complaints*) alimentan automáticamente la supresión de envíos para evitar penalizaciones en el pool de IPs.

---

## 7. Plan de Operación y Salida de Sandbox

1. **Pase a Producción en AWS SES**:
   - Crear identidad de dominio `sentrycore.io` en AWS SES región `sa-east-1`.
   - Cargar registros DNS (Easy DKIM CNAMEs, TXT DMARC, MX MAIL FROM) en el proveedor DNS principal.
   - Enviar solicitud de aumento de cuota de producción justificando el caso de uso SaaS transaccional (B2B monitoring, rondas de seguridad privada, sin correos masivos de marketing).
2. **Configuración de SNS Topics para Rebotes y Quejas**:
   - Crear tópicos SNS `ses-deliveries`, `ses-bounces`, `ses-complaints`.
   - Configurar HTTPS subscription apuntando al endpoint relay `/api/mail/webhook` con firma HMAC-SHA256 compartida (`NOTIF_WEBHOOK_SECRET`).
3. **Verificación en Staging**:
   - Validar paso de `loop-e2e.py` asegurando el despacho y confirmación de recepción en casillas de prueba de dominios corporativos y personales.

---

## 8. Consecuencias

- **Positivas**:
  - Costo de despacho optimizado a su mínima expresión técnica ($0.10 / 1k correos).
  - Latencia de conexión mínima hacia Chile (~40 ms).
  - Cero deuda técnica ni vendor lock-in a nivel de código; el backend sigue operando contra la interfaz agnóstica `MailProvider`.
  - Capacidad de conmutar a Resend o Postmark en menos de 60 segundos ante cualquier contingencia.
- **Negativas / Mitigaciones**:
  - Requiere el trámite inicial de desbloqueo de Sandbox en AWS (mitigado usando Resend en staging durante la espera).
  - La infraestructura de webhooks requiere el relay de traducción SNS → HMAC (ya resuelto y cubierto por pruebas en `apps/api/src/mail/registro-envios.traductor-interno.ts`).
