# Ficha de Google Play — SentryCore (issue #116)

Todo lo que hay que copiar y pegar en Play Console, más los trámites que hay que
empezar antes de que exista la app.

> **Los valores entre «comillas angulares» son marcadores de posición.** Hay que
> reemplazarlos por los reales antes de publicar; no se suben así.

> **Esto es riesgo de calendario, no de código.** La verificación de identidad
> del desarrollador y cada revisión tardan **días o semanas**, no se aceleran con
> más gente y se reinician con cada rechazo. La ubicación en segundo plano es la
> causa más frecuente de rechazo. Todo lo de este documento empieza el día 1 del
> proyecto, no cuando la app esté lista.

---

## 1. Orden de trámites

| # | Paso | Bloquea a | Plazo típico |
|---|---|---|---|
| 1 | Cuenta de desarrollador (USD 25, pago único) | todo | horas |
| 2 | **Verificación de identidad del desarrollador** | publicar | días a semanas |
| 3 | Cuenta de organización: verificación con D-U-N-S | ídem | semanas (el D-U-N-S puede tardar solo) |
| 4 | Crear la ficha con el `applicationId` definitivo | irreversible | minutos |
| 5 | **Primera subida a mano** desde Play Console | habilita `eas submit` | minutos |
| 6 | Formularios: seguridad de datos, clasificación, público objetivo, anuncios | publicar | horas |
| 7 | Política de privacidad publicada en una URL accesible | formularios | horas |
| 8 | **Declaración de ubicación en segundo plano + video** | publicar | revisión aparte, días |
| 9 | Pruebas cerradas | producción | ver nota abajo |
| 10 | Revisión de producción | — | días a semanas |

**Paso 5** es la trampa que siempre sorprende: la API de publicación de Google no
puede crear la **primera** versión de una app nueva. El primer AAB se sube desde
la consola web; recién después `eas submit` funciona.

**Paso 9**: para cuentas **personales** creadas después de noviembre de 2023,
Google exige 12 probadores en pruebas cerradas durante 14 días seguidos antes de
poder pasar a producción. Las cuentas de **organización** no arrastran ese
requisito, pero hay que confirmarlo en la consola **antes** de comprometer una
fecha de lanzamiento con el cliente: son dos semanas de diferencia.

---

## 2. Datos de la ficha

| Campo | Valor |
|---|---|
| Nombre de la app (máx. 30) | `SentryCore` |
| Nombre del paquete | `com.voxtilabs.sentrycore` |
| Categoría | **Empresa** |
| Etiquetas | Seguridad · Gestión de personal · Trabajo en terreno |
| Tipo de app | Aplicación (no juego) |
| Contiene anuncios | **No** |
| Compras en la aplicación | **No** (la licencia se cobra a la empresa fuera de la tienda) |
| Público objetivo | 18 años o más |
| Diseñada para familias | **No** |
| Correo de contacto | «soporte@voxtilabs.cl» |
| Sitio web | «https://voxtilabs.cl» |
| Política de privacidad | «https://voxtilabs.cl/privacidad-sentrycore» |

> **El acceso restringido hay que declararlo.** La app no tiene registro público:
> las credenciales las entrega la empresa de seguridad. En el formulario de
> revisión hay que entregar **credenciales de prueba funcionales** o el revisor
> ve una pantalla de login y rechaza por "no se pudo acceder al contenido". Se
> entrega una cuenta demo de GUARDIA, no una cuenta de un cliente real.

---

## 3. Descripción corta (máx. 80 caracteres)

```
Rondas de vigilancia con NFC: presencia real, evidencia y reportes al instante.
```

*(79 caracteres de 80. Si se toca, hay que volver a contar: Play Console trunca
sin avisar.)*

---

## 4. Descripción larga (máx. 4000 caracteres)

```
SentryCore es la aplicación para el personal de seguridad de las empresas que
usan la plataforma SentryCore. No es una app de uso personal: se accede con
las credenciales que entrega tu empleador.

RONDAS QUE SE PUEDEN DEMOSTRAR

En cada punto de control hay una etiqueta NFC. El guardia acerca el teléfono y el
paso queda registrado con la hora exacta y la ubicación. En los accesos críticos,
además, se fotografía el estado de la puerta con la cámara del teléfono. Al
escanear el último punto la ronda se cierra sola y el informe se genera y se
envía.

La diferencia con la planilla de papel es simple: la planilla se puede firmar
entera desde la caseta. La etiqueta NFC hay que ir a tocarla.

FUNCIONA SIN SEÑAL

Las rondas ocurren en estacionamientos subterráneos, bodegas y perímetros donde
no hay cobertura. La app registra escaneos y fotos sin conexión y los sincroniza
sola cuando vuelve la señal. No se pierde ningún registro.

LIBRO DE NOVEDADES Y BOTÓN DE PÁNICO

El personal reporta novedades con ubicación, fotos y nivel de criticidad. El
botón de pánico es una novedad de criticidad máxima con entrega garantizada al
supervisor. El libro es de solo agregado: nada se edita ni se borra después.

PARA EL SUPERVISOR

Ver quién está de servicio, seguir las rondas en curso sobre el mapa, recibir
alertas de rondas vencidas o con anomalías y descargar los informes de sus
recintos.

QUÉ NECESITA EL TELÉFONO

- Android con antena NFC para escanear las etiquetas. Sin NFC se puede usar el
  respaldo por código QR, pero el flujo completo requiere NFC.
- Cámara, para la evidencia fotográfica.
- GPS, para acreditar dónde se registró cada punto.

SOBRE LA UBICACIÓN

SentryCore registra la ubicación durante la ronda, incluso con la app en
segundo plano o la pantalla apagada, para poder acreditar el recorrido completo
de un turno. Antes de activarlo la app muestra un aviso explícito y pide tu
consentimiento, que puedes revocar cuando quieras desde la app. No se registra
la ubicación fuera del turno. Mientras el registro está activo aparece una
notificación permanente en el teléfono.

El tratamiento de estos datos lo determina la empresa de seguridad que te
contrata, que es la responsable de ellos; SentryCore opera como proveedor
tecnológico. Consulta la política de privacidad para el detalle de qué se
registra, por cuánto tiempo y cómo se ejerce cada derecho.

SOPORTE

Escríbenos a «soporte@voxtilabs.cl».
```

*(2.439 caracteres de 4.000.)*

---

## 5. Divulgación destacada de ubicación en segundo plano

**Esto es lo que más rechazos provoca.** Google exige un aviso *dentro de la
app*, propio, mostrado **antes** del diálogo del sistema, y que no esté escondido
en la política de privacidad ni en los términos.

Requisitos que el aviso tiene que cumplir, y que se verifican uno por uno:

- Aparece **antes** del diálogo de permiso del sistema.
- Es una pantalla o modal propio, no un texto dentro de un scroll largo.
- Nombra la app, dice que recoge ubicación, dice que lo hace **también con la app
  cerrada o en segundo plano**, y para qué.
- Tiene una acción afirmativa para continuar y **una para rechazar**, ambas
  visibles sin desplazarse.
- Rechazar no rompe la app: el resto sigue funcionando.

### Texto exacto para la pantalla in-app

> **SentryCore necesita tu ubicación durante el turno**
>
> Para poder acreditar que la ronda se recorrió en terreno, SentryCore
> registra tu ubicación mientras el turno está activo, **incluso cuando la app
> está en segundo plano o la pantalla apagada**.
>
> - Solo durante el turno. Al cerrarlo, el registro se detiene.
> - Mientras está activo verás una notificación permanente en el teléfono.
> - Tu empleador usa estos datos para verificar el recorrido y emitir los
>   informes del servicio.
> - Puedes revocar este permiso cuando quieras, desde esta app o desde los
>   ajustes de Android.
>
> [ Acepto y continúo ]  [ Ahora no ]

El puente nativo hace cumplir el orden: un `permission.request` de
`ubicacion-segundo-plano` con `divulgacionMostrada: false` se rechaza y el
diálogo del sistema **no se abre**. Ver `apps/mobile/src/bridge/README.md`.

> **Ojo con Android 11+**: el diálogo del sistema para "Permitir siempre" ya no
> existe como pop-up. Hay que pedir primero la ubicación en primer plano y luego
> enviar a la persona a la pantalla de Ajustes, donde elige "Permitir siempre" a
> mano. El video de la declaración tiene que mostrar ese recorrido completo.

### Formulario de declaración de permisos

Se completa en Play Console → Contenido de la app → Ubicación en segundo plano.

**Función que lo requiere:** registro continuo del recorrido durante un turno de
vigilancia (traza de la ronda).

**Justificación (para pegar en el formulario):**

```
La app la usa personal de seguridad privada contratado por empresas que operan
SentryCore. Durante un turno, el guardia recorre puntos de control físicos con
el teléfono en el bolsillo y la pantalla apagada, por períodos de hasta 8 horas y
frecuentemente en subterráneos y perímetros sin señal.

La función necesita muestrear la ubicación cada 60 segundos mientras la ronda
está en curso, para construir la traza del recorrido que respalda el informe del
servicio prestado. Con la ubicación solo en primer plano la traza se corta apenas
la pantalla se apaga, que es la condición normal de trabajo, y el informe deja de
poder acreditar el recorrido.

El registro está acotado: solo ocurre con una ronda en estado "en curso" asignada
al usuario autenticado; el servidor rechaza cualquier punto fuera de esa ventana.
El usuario ve una divulgación destacada antes de conceder el permiso, otorga un
consentimiento que queda registrado con fecha y versión del texto, y puede
revocarlo en cualquier momento desde la app, lo que detiene el registro de
inmediato. Mientras el registro está activo se muestra una notificación
permanente. Los datos de la traza se conservan 90 días por defecto.
```

**Video demostrativo** (obligatorio, enlace de YouTube no listado). Tiene que
mostrar, en este orden y sin cortes que se salten pasos:

1. Inicio de sesión con la cuenta demo.
2. La pantalla de divulgación destacada, legible.
3. El permiso de ubicación en primer plano.
4. El envío a Ajustes y la elección de "Permitir siempre".
5. El inicio de un turno y **la notificación permanente**.
6. El cierre del turno y **la notificación desapareciendo**.
7. La pantalla desde la que se revoca el consentimiento.

Los pasos 5, 6 y 7 son los que convencen: muestran que el registro está acotado
al turno y que se puede cortar.

---

## 6. Formulario de seguridad de los datos

| Dato | ¿Se recopila? | ¿Se comparte? | ¿Obligatorio? | Propósito |
|---|---|---|---|---|
| Ubicación aproximada | Sí | No | Sí | Funcionalidad de la app |
| Ubicación precisa | Sí | No | Sí | Funcionalidad de la app |
| **Ubicación en segundo plano** | Sí | No | **No** (se puede rechazar) | Funcionalidad de la app |
| Fotos | Sí | No | Sí | Funcionalidad de la app (evidencia) |
| Nombre | Sí | No | Sí | Funcionalidad, gestión de la cuenta |
| Correo electrónico | Sí (si existe) | No | No | Gestión de la cuenta |
| Identificadores de usuario | Sí | No | Sí | Gestión de la cuenta |
| Registros de la app (diagnóstico) | Sí | No | No | Análisis, prevención de fraude |

Declaraciones asociadas:

- **Los datos se cifran en tránsito**: sí (HTTPS obligatorio; el shell rechaza
  arrancar contra una URL que no sea HTTPS fuera de desarrollo local).
- **El usuario puede solicitar la eliminación de sus datos**: sí. Ruta descrita
  en la política de privacidad y operada según `docs/borrado-y-exportacion.md`.
- **No se recopila**: contactos, mensajes, historial de navegación, salud,
  información financiera, audio. La app **no pide acceso a la galería** a
  propósito: las fotos se toman siempre con la cámara en vivo.

> El formulario tiene que coincidir con lo que hace el APK. Una discrepancia se
> detecta en revisión y cuesta un ciclo completo.

---

## 7. Recursos gráficos

| Recurso | Requisito |
|---|---|
| Icono | 512×512 PNG, **sin canal alfa**, 32 bits. Se exporta de `apps/mobile/assets/icon.svg` |
| Gráfico de cabecera | 1024×500 JPG o PNG sin alfa. Obligatorio |
| Capturas de teléfono | Entre 2 y 8, mínimo 320 px de lado, proporción entre 16:9 y 9:16 |
| Video promocional | Opcional. No reemplaza al video de la declaración de ubicación |

**Las capturas no pueden mostrar datos reales de ningún cliente.** Se toman con
las cuentas demo. Nombres de guardias, direcciones de recintos y coordenadas de
un tenant real en una captura pública son una filtración, no un descuido de
diseño.

---

## 8. Política de privacidad

Hay que **publicarla en una URL accesible sin login** y pegar esa URL en la ficha
y en el formulario de datos. Texto listo para publicar:

---

### Política de privacidad — SentryCore (aplicación Android)

**Última actualización:** «fecha de publicación»

**1. Quiénes somos y qué rol cumple cada uno**

SentryCore es una plataforma de monitoreo de rondas de vigilancia operada por
«Voxti Labs SpA», RUT «XX.XXX.XXX-X», domicilio en «dirección», Chile.

La aplicación la usan trabajadores de **empresas de seguridad privada que
contratan la plataforma**. Esa empresa empleadora es la **responsable** del
tratamiento de los datos de sus trabajadores: define qué se registra, para qué y
por cuánto tiempo, dentro de los límites de esta política. «Voxti Labs SpA» actúa
como **encargado** del tratamiento, es decir, procesa los datos por cuenta de esa
empresa y siguiendo sus instrucciones.

Si eres trabajador y quieres ejercer un derecho sobre tus datos, puedes
dirigirte a tu empleador o escribirnos a «privacidad@voxtilabs.cl»; en ese caso
canalizaremos tu solicitud con la empresa responsable.

**2. Qué datos tratamos**

- **Identificación y cuenta**: nombre, apellido, nombre de usuario o correo
  electrónico si existe, rol asignado y empresa a la que perteneces. Muchos
  trabajadores no tienen correo electrónico; en ese caso la credencial la entrega
  el administrador de la empresa.
- **Actividad de la ronda**: qué punto de control se escaneó, a qué hora, con qué
  método (NFC o código QR de respaldo) y el resultado.
- **Ubicación**: la posición en el momento de cada escaneo y, si la empresa
  activó la función y tú la consentiste, un muestreo periódico de tu posición
  **mientras la ronda está en curso**. Se guardan latitud, longitud, precisión en
  metros, la hora del dispositivo y, opcionalmente, el porcentaje de batería.
- **Fotografías**: imágenes del estado de accesos y puntos críticos, tomadas
  siempre con la cámara en vivo. La aplicación **no accede a tu galería**.
- **Novedades y eventos**: el texto, las fotos y la criticidad que tú registras,
  incluido el botón de pánico.
- **Datos técnicos**: marca y modelo del equipo (asociados a tu consentimiento),
  y registros de diagnóstico de la aplicación.

**No tratamos**: tus contactos, tus mensajes, tu historial de navegación, datos
de salud, datos financieros, audio, IMEI, número de teléfono ni las redes wifi
que tu equipo detecta.

**3. Ubicación en segundo plano: qué hacemos y qué no**

Con tu consentimiento, la aplicación registra tu ubicación **también cuando está
en segundo plano o con la pantalla apagada**. Esto es necesario porque un turno de
vigilancia dura horas con el teléfono guardado, y sin ello no se puede acreditar
el recorrido.

Límites que aplicamos, y que son verificables en nuestros sistemas:

- Solo se registra ubicación cuando existe una ronda **en curso** asignada a ti.
  Fuera de esa ventana el servidor rechaza los datos y no guarda nada.
- **No se registra tu ubicación fuera del turno.**
- Mientras el registro está activo, tu teléfono muestra una notificación
  permanente.
- Puedes **revocar** el consentimiento en cualquier momento desde la aplicación.
  Desde ese instante no se registra ni un punto más.

Al revocar, los recorridos ya registrados no se eliminan de inmediato: respaldan
informes de servicios ya prestados y caducan por el plazo de conservación
indicado abajo.

**4. Para qué usamos los datos**

Para ejecutar y acreditar el servicio de vigilancia contratado: verificar la
presencia física en cada punto de control, generar los informes del servicio,
alertar de rondas incompletas o con anomalías, y atender emergencias reportadas
desde la aplicación. **No usamos estos datos para publicidad y no los vendemos.**

**5. Cuánto tiempo los conservamos**

- Recorrido (traza de ubicación): **90 días** por defecto.
- Evidencia fotográfica: **365 días** por defecto.
- Registros de rondas y novedades: mientras dure la relación con la empresa
  cliente, más los plazos legales que correspondan.

Cada empresa puede configurar plazos menores. Al término del contrato, los datos
de la empresa se exportan y se eliminan según un procedimiento con ventana de
arrepentimiento y verificación de que no quede ningún registro.

**6. Con quién los compartimos**

Con nadie fuera de: (a) la empresa de seguridad responsable de tus datos, y (b)
los proveedores de infraestructura necesarios para operar el servicio, que actúan
bajo instrucción y con obligación de confidencialidad. No hay corredores de
datos, ni redes publicitarias, ni analítica de terceros con fines comerciales.

**7. Tus derechos**

Conforme a la Ley 21.719 sobre protección de datos personales, puedes solicitar
acceso, rectificación, eliminación, oposición y portabilidad de tus datos, y
revocar los consentimientos que hayas otorgado. Escríbenos a
«privacidad@voxtilabs.cl» o dirígete a tu empleador. Responderemos en los plazos
legales.

**8. Monitoreo laboral**

El registro de ubicación de trabajadores en Chile exige aviso previo y
proporcionalidad. Por eso la aplicación te informa antes de activarlo, registra
tu consentimiento con fecha y versión del texto, limita el registro al turno y te
permite revocarlo. Si tu empleador desactiva la función, la aplicación deja de
registrar recorrido aunque tú hayas consentido.

**9. Seguridad**

Los datos viajan cifrados (HTTPS) y están aislados por empresa en la base de
datos, con controles que impiden que una empresa acceda a los datos de otra.
Nuestros registros de diagnóstico no incluyen nombres ni ubicaciones de personas.

**10. Menores de edad**

La aplicación está dirigida exclusivamente a personas mayores de 18 años en
contexto laboral. No la usan menores y no recopilamos datos de menores.

**11. Cambios**

Si cambiamos esta política te lo informaremos dentro de la aplicación. Si el
cambio afecta al registro de ubicación, se te pedirá un consentimiento nuevo: un
consentimiento otorgado sobre un texto que nunca leíste no acredita nada.

**12. Contacto**

«privacidad@voxtilabs.cl» — «Voxti Labs SpA», «dirección», Chile.

---

## 9. Antes de darle a publicar

- [ ] La verificación de identidad del desarrollador está **aprobada**.
- [ ] El `applicationId` es el definitivo. Después no se cambia.
- [ ] El keystore está respaldado fuera de EAS y fuera del repositorio.
- [ ] La política de privacidad está publicada y la URL abre **sin login**.
- [ ] La divulgación destacada aparece en la app **antes** del diálogo del
      sistema, y rechazarla no rompe nada.
- [ ] El video de la declaración muestra la notificación permanente apareciendo y
      desapareciendo con el turno.
- [ ] El formulario de datos coincide con lo que hace el APK.
- [ ] Las credenciales de prueba para el revisor funcionan y son de una cuenta
      demo, no de un cliente real.
- [ ] Las capturas no muestran datos de ningún tenant real.
- [ ] Se probó una ronda completa en **modo avión**.
