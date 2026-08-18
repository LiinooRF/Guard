# -*- coding: utf-8 -*-
"""
Prueba end-to-end contra un despliegue REAL. No mockea nada.

    python scripts/humo-e2e.py                       # contra staging
    SENTRYCORE_BASE=https://otro.dominio python scripts/humo-e2e.py

Variables: SENTRYCORE_BASE (por defecto staging), SENTRYCORE_DEMO_PASSWORD (la misma
DEMO_PASSWORD con que se sembraron las cuentas demo) y SENTRYCORE_HUMO_ESTRICTO
(ver "lo que no se pudo probar").

LO QUE NO SE PUDO PROBAR TAMBIEN CUENTA. Una comprobacion que no se ejecuta no
es una comprobacion que pasa, y este script llego a saltarse cuatro en silencio
—un renombre de regla que nadie propago hasta aca— mientras el resumen seguia
diciendo "0 fallas". Por eso cada `omitido()` declara POR QUE no se pudo:

  POR_EL_DESPLIEGUE  ese despliegue no da la condicion y es legitimo (no hay
                     rondas a esta hora, el modulo esta apagado en el plan de
                     esa empresa). Se lista al final y NO cuenta como falla.
  POR_LA_PRUEBA      la prueba no pudo montar algo que ella misma controla, o
                     la API le contesto algo que no esperaba. Eso no es "el
                     despliegue es asi": es cobertura perdida. Devuelve 1.

Una omision sin clasificar cuenta como POR_LA_PRUEBA: falla cerrada, igual que
las politicas de RLS. Y `SENTRYCORE_HUMO_ESTRICTO=1` hace que hasta lo ambiental
cuente — asi conviene correrla contra staging sembrado, donde no hay ninguna
razon legitima para saltarse nada.

POR QUE EXISTE: dos bugs llegaron a produccion con CI en verde y 729 tests
pasando —un SELECT de una columna que no existe y un volumen que el proceso no
podia escribir—. Ninguno de los dos es detectable con mocks: el primero pasaba
porque el mock devolvia una columna inventada, y el segundo solo aparece con el
contenedor y su volumen de verdad. Esta prueba habla con la API desplegada.

Necesita las cuentas demo (RUN_DEMO_SEED=true). No correr contra produccion con
datos de clientes: escribe novedades, sube fotos de prueba, publica un aviso de
geolocalizacion nuevo y atiende alertas de ronda.

REPETIBLE: correrla dos veces seguidas tiene que dar lo mismo. Todo lo que
escribe es o bien de nombre unico por corrida (novedades, fotos, avisos,
alertas), o bien se deja EXACTAMENTE como estaba (las reglas de la empresa, del
recinto y del punto, y las preferencias de modulos se leen antes, se tocan y se
restauran). Si esta prueba deja el despliegue distinto de como lo encontro, es
un bug de la prueba.

ALCANCE REAL DE LO QUE ESCRIBE, dicho sin adornos:

  - Publicar un aviso de geolocalizacion RETIRA el anterior (retired_at) y, si
    la empresa exige reaceptacion, el producto revoca de una sola sentencia el
    consentimiento de ubicacion de TODOS sus trabajadores, y la API no ofrece
    ningun camino para devolverlo: lo tiene que volver a aceptar cada persona
    desde la app. Por eso la prueba apaga `consentReacceptOnNewPolicy` ANTES de
    publicar y lo restaura en un `finally`. Si no consigue apagarlo, NO publica.
    Lo que si queda igual pase lo que pase, porque es inherente a publicar: quien
    habia aceptado la version anterior pasa a figurar como "desactualizado" en
    /consent/policy y /consent/roster. No se le revoca nada (revoked_at sigue en
    NULL), pero el estado que ve cambia.
  - La seccion 14 necesita un recinto que el supervisor no tenga asignado. Se lo
    fabrica ella misma con un nombre fijo (RECINTO_DESCARTABLE) y lo deja
    desactivado: se reusa entre corridas, asi que no se acumula uno por corrida.
  - La seccion 14b necesita ademas un PUNTO y una ETIQUETA dentro de ese recinto
    ajeno, para probar las rutas que no llevan el recinto en la URL. Los crea el
    ADMIN con nombre y UID fijos (PUNTO_DESCARTABLE, UID_DESCARTABLE), el punto
    queda desactivado y la etiqueta se conserva para reusarla en la corrida
    siguiente. Ninguno de los dos es dato de operacion.
"""
import os
import sys, json, http.cookiejar, urllib.request, urllib.error, uuid, io

sys.stdout.reconfigure(encoding='utf-8')

BASE = os.environ.get('SENTRYCORE_BASE', 'https://test-sentrycore.voxtilabs.cl')
API = BASE + '/api'
CLAVE = os.environ.get('SENTRYCORE_DEMO_PASSWORD', 'DemoGuardia2026!')

# El recinto que la seccion 14 necesita NO asignado al supervisor. Nombre fijo y
# no unico por corrida a proposito: la API no ofrece borrar recintos, asi que uno
# nuevo por corrida iria dejando un cadaver cada vez. Con nombre fijo existe a lo
# sumo uno, se reusa y queda desactivado.
RECINTO_DESCARTABLE = 'Recinto descartable de la prueba e2e (no operativo)'

# Un punto y una etiqueta DENTRO de ese recinto ajeno, para poder probar las
# rutas que no llevan el recinto en la URL (#309). Mismo criterio de nombre fijo
# y reuso: no hay endpoint para borrar un punto, asi que uno por corrida seria un
# cadaver por corrida. Los crea el ADMIN, nunca el supervisor: el supervisor no
# tiene que poder tocarlos, que es justo lo que se comprueba.
PUNTO_DESCARTABLE = 'Punto descartable de la prueba e2e (recinto no asignado)'
UID_DESCARTABLE = '04E2EDEADBEEF0'

# Con todo sembrado y todos los modulos encendidos —staging— no hay ninguna
# razon legitima para saltarse una comprobacion, y ahi conviene que hasta lo
# ambiental salga en rojo. Apagado por defecto porque esta misma prueba corre
# contra despliegues con modulos apagados A PROPOSITO, y un rojo que todos saben
# que no significa nada es como se pierde una prueba entera.
ESTRICTO = os.environ.get('SENTRYCORE_HUMO_ESTRICTO', '').strip().lower() in ('1', 'true', 'si')

# Por que no se pudo probar. Es lo unico que decide si la corrida sigue en verde.
POR_EL_DESPLIEGUE = 'despliegue'   # ese despliegue no da la condicion, y es legitimo
POR_LA_PRUEBA = 'prueba'           # la prueba perdio cobertura: cuenta como falla

ok = 0
fallos = []
omitidos = []   # (nombre, motivo, cuenta_como_falla)


def check(nombre, condicion, detalle=''):
    global ok
    if condicion:
        ok += 1
        print('  OK   %s' % nombre)
    else:
        fallos.append((nombre, detalle))
        print('  FALLA %s  %s' % (nombre, detalle))


def omitido(nombre, motivo, causa=None):
    """
    Comprobacion que no se ejecuto. Se cuenta aparte y se lista al final: un
    resumen que dice "todo OK" escondiendo lo que ni siquiera se intento es peor
    que una falla.

    `nombre` acepta una LISTA. Cuando se salta un bloque entero hay que pasar los
    nombres de todas las comprobaciones que ese bloque iba a hacer: si un bloque
    de catorce comprobaciones se anotara como un solo "sin probar", el recuento
    final diria 1 donde no se probaron 14, que es justo lo que este contador
    existe para evitar.

    `causa` decide el codigo de salida y por eso no tiene default util:

      POR_EL_DESPLIEGUE  la condicion no existe en ESE despliegue y esta bien
                         que no exista. No cuenta como falla.
      POR_LA_PRUEBA      la prueba no pudo montar una condicion que ella misma
                         controla, o la API le contesto algo que no esperaba.
                         Cuenta como falla.

    Sin clasificar se trata como POR_LA_PRUEBA. Es a proposito y es la misma
    regla que las politicas de RLS: lo que nadie declaro se cuenta como problema,
    no como permiso. Quien agregue un `omitido()` nuevo tiene que decidir, y el
    que se olvide se entera por el rojo, no seis semanas despues.
    """
    if causa is None:
        motivo = '%s — y la omision no declara causa' % motivo
    cuenta = ESTRICTO or causa != POR_EL_DESPLIEGUE
    etiqueta = 'FALTA' if cuenta else '--  '
    nombres = nombre if isinstance(nombre, (list, tuple)) else [nombre]
    for uno in nombres:
        omitidos.append((uno, motivo, cuenta))
        print('  %s %s  (no se pudo probar: %s)' % (etiqueta, uno, motivo))


class Sesion:
    def __init__(self, etiqueta):
        self.etiqueta = etiqueta
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        # Cabeceras de la ultima respuesta. Las necesita la descarga de la
        # planilla, que se juzga por su tipo de contenido y no solo por el cuerpo.
        self.cabeceras = {}

    def pedir(self, metodo, ruta, cuerpo=None, crudo=False, cabeceras=None):
        datos = None
        req_cab = dict(cabeceras or {})
        if cuerpo is not None:
            datos = json.dumps(cuerpo).encode()
            req_cab['Content-Type'] = 'application/json'
        req = urllib.request.Request(API + ruta, data=datos, method=metodo)
        # La API rechaza peticiones sin Origin (proteccion CSRF): el navegador
        # siempre la manda, un cliente hecho a mano tiene que mandarla igual.
        req_cab.setdefault('Origin', BASE)
        for k, v in req_cab.items():
            req.add_header(k, v)
        try:
            with self.op.open(req, timeout=60) as r:
                b = r.read()
                self.cabeceras = dict(r.headers)
                if crudo:
                    return r.status, b
                return r.status, (json.loads(b.decode()) if b.strip() else None)
        except urllib.error.HTTPError as e:
            b = e.read()
            self.cabeceras = dict(e.headers)
            if crudo:
                return e.code, b
            try:
                return e.code, json.loads(b.decode())
            except Exception:
                return e.code, b[:200].decode('utf-8', 'replace')

    def login(self, email):
        # 'identity' y no 'email': muchos guardias no tienen correo y entran con
        # la credencial que les entrega el admin.
        s, d = self.pedir('POST', '/auth/login', {'identity': email, 'password': CLAVE})
        return s, d

    def abrir_flujo(self, ruta):
        """
        Abre un flujo de eventos en vivo y lo cierra apenas llegan las cabeceras.

        No se lee el cuerpo a proposito: un flujo de eventos no termina nunca
        mientras el supervisor mire la bandeja, asi que esperar a que cierre
        colgaria la prueba. Lo que interesa aca es que el servidor acepte la
        conexion y la declare como flujo de eventos, no su contenido.
        """
        req = urllib.request.Request(API + ruta, method='GET')
        req.add_header('Origin', BASE)
        req.add_header('Accept', 'text/event-stream')
        try:
            r = self.op.open(req, timeout=45)
            estado, tipo = r.status, r.headers.get('Content-Type', '')
            r.close()
            return estado, tipo
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, ''


def cuerpo_dict(d):
    """El cuerpo como diccionario, o uno vacio si la API devolvio otra cosa."""
    return d if isinstance(d, dict) else {}


def lista_de(d, clave):
    """Colecciones que a veces viajan sueltas y a veces envueltas."""
    if isinstance(d, list):
        return d
    valor = cuerpo_dict(d).get(clave)
    return valor if isinstance(valor, list) else []


print('=' * 72)
print('1. AUTENTICACION — los 4 roles')
print('=' * 72)
sesiones = {}
for rol, email in [
    ('SUPERADMIN', 'superadmin@demo-platform.test'),
    ('ADMIN', 'admin@demo-andina.test'),
    ('SUPERVISOR', 'supervisor@demo-andina.test'),
    ('GUARDIA', 'guardia@demo-andina.test'),
]:
    ses = Sesion(rol)
    s, d = ses.login(email)
    check('login %s' % rol, s in (200, 201), 'HTTP %s' % s)
    if s in (200, 201):
        sesiones[rol] = ses
        s2, ses_data = ses.pedir('GET', '/auth/session')
        # La sesion viene anidada bajo 'user'.
        usuario = (ses_data or {}).get('user') or {}
        check('  sesion dice rol %s' % rol, s2 == 200 and usuario.get('role') == rol,
              str(ses_data)[:120])

# Tenant B, para aislamiento
ses_b = Sesion('GUARDIA_B')
s, _ = ses_b.login('guardia@demo-pacifico.test')
check('login guardia de la OTRA empresa', s in (200, 201), 'HTTP %s' % s)

# Identidad inventada DISTINTA en cada corrida, por lo mismo que las fotos: el
# bloqueo por intentos fallidos cuenta por IDENTIDAD (auth:login-attempts:identity),
# asi que reusar siempre el mismo correo falso acumula intentos entre corridas y a
# la N-esima el producto responde 429 en vez de 401. La prueba pasaba una vez y
# fallaba despues, y lo que fallaba era la prueba, no el producto.
s, d = Sesion('malo').login('no-existe-%s@demo-andina.test' % uuid.uuid4().hex[:12])
check('login con correo inexistente es rechazado', s == 401, 'HTTP %s' % s)

admin = sesiones.get('ADMIN')
supervisor = sesiones.get('SUPERVISOR')
guardia = sesiones.get('GUARDIA')
superadmin = sesiones.get('SUPERADMIN')

print()
print('=' * 72)
print('2. REGLAS EN CASCADA (#80, #81, #83)')
print('=' * 72)
s, cat = admin.pedir('GET', '/rules/catalog')
params = (cat or {}).get('parameters', [])
check('catalogo responde', s == 200 and len(params) > 0, 'HTTP %s, %d params' % (s, len(params)))
if params:
    p0 = params[0]
    check('  cada parametro trae tipo, default y descripcion',
          all(k in p0 for k in ('key', 'type', 'description')), str(p0)[:150])
    check('  y dice en que niveles se configura', 'scopes' in p0 or 'levels' in p0, str(p0.keys()))
else:
    omitido(['cada parametro trae tipo, default y descripcion',
             'el catalogo dice en que niveles se configura cada parametro'],
            'el catalogo de parametros vino vacio', POR_LA_PRUEBA)

s, reglas = admin.pedir('GET', '/rules/admin')
check('reglas del tenant responden', s == 200, 'HTTP %s' % s)
check('  trae de que nivel salio cada valor (sources)',
      isinstance(reglas, dict) and 'sources' in reglas, str(list((reglas or {}).keys()))[:120])

s, _ = guardia.pedir('GET', '/rules/admin')
check('el GUARDIA no puede leer la config del tenant', s == 403, 'HTTP %s' % s)

s, _ = admin.pedir('PUT', '/rules/admin', {'complianceThreshold': 999})
check('un umbral fuera de rango se rechaza', s == 400, 'HTTP %s' % s)

s, _ = admin.pedir('PUT', '/rules/admin', {'noExisteEstaRegla': 1})
check('un campo desconocido se rechaza', s == 400, 'HTTP %s' % s)

print()
print('=' * 72)
print('3. ESTADISTICAS (#89) y GRAFICAS (#87)')
print('=' * 72)
for nombre in ['compliance-by-site', 'compliance-by-route', 'evolution',
               'missed-checkpoints', 'guard-ranking']:
    s, d = admin.pedir('GET', '/stats/charts/%s' % nombre)
    check('grafica %s' % nombre, s == 200, 'HTTP %s %s' % (s, str(d)[:90]))

s, d = admin.pedir('GET', '/stats/charts/missed-checkpoints?from=2020-01-01&to=2026-12-31')
check('un rango absurdo se rechaza y no tumba la base', s == 400, 'HTTP %s' % s)

s, _ = guardia.pedir('GET', '/stats/charts/compliance-by-site')
check('el GUARDIA no ve estadisticas', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('4. AISLAMIENTO ENTRE EMPRESAS — lo mas importante')
print('=' * 72)
s, ov = admin.pedir('GET', '/dashboard/tenant')
patrols = (ov or {}).get('patrols', []) if isinstance(ov, dict) else []
check('el admin ve el resumen de SU empresa', s == 200, 'HTTP %s' % s)
print('     (%d rondas visibles)' % len(patrols))

s, sitios = admin.pedir('GET', '/admin/sites')
todos_los_sitios = sitios if isinstance(sitios, list) else (sitios or {}).get('sites', [])
# El recinto descartable que fabrica la seccion 14 no es un recinto de la
# operacion: se aparta aca para que no se cuele como "el recinto" de las demas
# secciones en la segunda corrida y las siguientes.
lista_sitios = [r for r in todos_los_sitios if r.get('name') != RECINTO_DESCARTABLE]
check('el admin lista sus recintos', s == 200 and len(lista_sitios) > 0,
      'HTTP %s, %d' % (s, len(lista_sitios)))

if lista_sitios:
    site_ajeno = lista_sitios[0].get('id')
    # Ojo con lo que prueba esta linea: guardia@demo-pacifico es GUARDIA y este
    # endpoint pide patrols:monitor, asi que el 403 lo pone el rol antes de que
    # el tenant llegue a importar. Es cierre por ROL, no aislamiento por empresa.
    # El aislamiento de verdad esta en la seccion 15, con endpoints que el rol
    # GUARDIA SI puede pedir.
    s, _ = ses_b.pedir('GET', '/supervisor/sites/%s/events' % site_ajeno)
    check('un GUARDIA no lee la bandeja de terreno de un recinto (ni el propio ni el ajeno)',
          s in (403, 404), 'HTTP %s — si es 200 hay FUGA' % s)
else:
    omitido('un GUARDIA no lee la bandeja de terreno de un recinto (ni el propio ni el ajeno)',
            'la empresa no tiene ningun recinto', POR_EL_DESPLIEGUE)

inventado = str(uuid.uuid4())
s, _ = admin.pedir('GET', '/evidence/patrols/%s/photos' % inventado)
check('una ronda inexistente da 404 y no filtra', s == 404, 'HTTP %s' % s)

s, _ = admin.pedir('GET', '/platform/tenants')
check('el ADMIN no entra a la plataforma', s == 403, 'HTTP %s' % s)

s, d = superadmin.pedir('GET', '/platform/tenants')
check('el SUPERADMIN si', s == 200, 'HTTP %s' % s)

print()
print('=' * 72)
print('5. EL GUARDIA EN TERRENO (#91-94, #66, #122)')
print('=' * 72)
s, home = guardia.pedir('GET', '/guard/home')
check('el guardia ve su turno', s == 200, 'HTTP %s' % s)
tiene_ronda = isinstance(home, dict) and home.get('hasAssignment')
print('     (asignacion: %s)' % ('si' if tiene_ronda else 'no hay ronda programada ahora'))

cliente_id = str(uuid.uuid4())
s, ev = guardia.pedir('POST', '/guard/events', {
    'clientEventId': cliente_id,
    'criticality': 'media',
    'text': 'Prueba e2e automatizada: porton lateral sin candado',
})
check('el guardia registra una novedad', s in (200, 201), 'HTTP %s %s' % (s, str(ev)[:120]))
event_id = (ev or {}).get('id') if isinstance(ev, dict) else None

s2, ev2 = guardia.pedir('POST', '/guard/events', {
    'clientEventId': cliente_id,
    'criticality': 'media',
    'text': 'Prueba e2e automatizada: porton lateral sin candado',
})
id2 = (ev2 or {}).get('id') if isinstance(ev2, dict) else None
check('reenviar la MISMA novedad no la duplica (idempotencia offline)',
      s2 in (200, 201) and id2 == event_id, 'ids: %s vs %s' % (event_id, id2))

print()
print('=' * 72)
print('6. FOTOS DE NOVEDAD (#66) y ENLACES FIRMADOS (#69)')
print('=' * 72)


# Cada corrida usa imagenes DISTINTAS a proposito. El producto rechaza con 409
# la imagen ya usada —es la foto reusada, el fraude de evidencia del rubro—, asi
# que un PNG fijo haria que la prueba pasara la primera vez y fallara siempre
# despues. El sufijo aleatorio va DESPUES del encabezado, que es lo unico que la
# API lee para sacar las dimensiones.
CORRIDA = uuid.uuid4().bytes


def png_minimo(relleno=0):
    b = bytearray(25)
    b[0:8] = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    b[8:12] = (13).to_bytes(4, 'big')
    b[12:16] = b'IHDR'
    b[16:20] = (640).to_bytes(4, 'big')
    b[20:24] = (480).to_bytes(4, 'big')
    b[24] = relleno
    return bytes(b) + CORRIDA + bytes([relleno])


def multipart(campo, nombre, contenido, tipo='image/png'):
    lim = '----sentrycoree2e%s' % uuid.uuid4().hex
    cuerpo = io.BytesIO()
    cuerpo.write(('--%s\r\n' % lim).encode())
    cuerpo.write(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (campo, nombre)).encode())
    cuerpo.write(('Content-Type: %s\r\n\r\n' % tipo).encode())
    cuerpo.write(contenido)
    cuerpo.write(('\r\n--%s--\r\n' % lim).encode())
    return cuerpo.getvalue(), 'multipart/form-data; boundary=%s' % lim


def subir_foto(ses, ruta, contenido):
    datos, ctype = multipart('foto', 'evidencia.png', contenido)
    req = urllib.request.Request(API + ruta, data=datos, method='POST')
    req.add_header('Content-Type', ctype)
    req.add_header('Origin', BASE)
    try:
        with ses.op.open(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, None


FOTOS_DE_LA_NOVEDAD = [
    'el guardia sube la foto de su novedad',
    'la MISMA imagen otra vez se rechaza (foto reusada)',
    'un archivo que no es imagen se rechaza por CONTENIDO',
    'no se puede colgar una foto en una novedad ajena',
]
ENLACE_FIRMADO = [
    'el enlace firmado sirve los bytes sin sesion',
    'una firma alterada es rechazada',
    'cambiar el tenant en la URL no sirve',
]

foto_id = None
if not event_id:
    omitido(FOTOS_DE_LA_NOVEDAD + ['el admin obtiene el enlace firmado']
            + ENLACE_FIRMADO + ['la verificacion de integridad dice que esta intacta'],
            'la novedad del guardia no se pudo registrar', POR_LA_PRUEBA)
if event_id:
    s, foto = subir_foto(guardia, '/evidence/events/%s/photos' % event_id, png_minimo(7))
    check('el guardia sube la foto de su novedad', s in (200, 201),
          'HTTP %s %s' % (s, str(foto)[:120]))
    foto_id = (foto or {}).get('id')

    s2, _ = subir_foto(guardia, '/evidence/events/%s/photos' % event_id, png_minimo(7))
    check('la MISMA imagen otra vez se rechaza (foto reusada)', s2 == 409, 'HTTP %s' % s2)

    s3, _ = subir_foto(guardia, '/evidence/events/%s/photos' % event_id, b'esto no es un png')
    check('un archivo que no es imagen se rechaza por CONTENIDO', s3 == 415, 'HTTP %s' % s3)

    otro_evento = str(uuid.uuid4())
    s4, _ = subir_foto(guardia, '/evidence/events/%s/photos' % otro_evento, png_minimo(9))
    check('no se puede colgar una foto en una novedad ajena', s4 == 404, 'HTTP %s' % s4)

if event_id and not foto_id:
    omitido(['el admin obtiene el enlace firmado'] + ENLACE_FIRMADO
            + ['la verificacion de integridad dice que esta intacta'],
            'no quedo ninguna foto subida a la que pedirle el enlace', POR_LA_PRUEBA)
if foto_id:
    s, enlace = admin.pedir('GET', '/evidence/photos/%s/link' % foto_id)
    check('el admin obtiene el enlace firmado', s == 200 and 'url' in (enlace or {}),
          'HTTP %s %s' % (s, str(enlace)[:100]))
    url = (enlace or {}).get('url', '')
    if not url:
        omitido(ENLACE_FIRMADO, 'la respuesta no trajo el enlace firmado', POR_LA_PRUEBA)
    if url:
        anon = urllib.request.build_opener()  # SIN sesion, a proposito
        try:
            with anon.open(API + url, timeout=60) as r:
                cuerpo = r.read()
            check('el enlace firmado sirve los bytes sin sesion',
                  r.status == 200 and cuerpo[:8] == png_minimo()[:8],
                  'HTTP %s, %d bytes' % (r.status, len(cuerpo)))
        except urllib.error.HTTPError as e:
            check('el enlace firmado sirve los bytes sin sesion', False, 'HTTP %s' % e.code)

        roto = url.replace('sig=', 'sig=0')[:-1] + '0'
        try:
            anon.open(API + roto, timeout=60)
            check('una firma alterada es rechazada', False, 'devolvio 200 — FUGA')
        except urllib.error.HTTPError as e:
            check('una firma alterada es rechazada', e.code in (400, 403), 'HTTP %s' % e.code)

        import re
        otro_tenant = re.sub(r'tenant=[0-9a-f-]+', 'tenant=%s' % uuid.uuid4(), url)
        try:
            anon.open(API + otro_tenant, timeout=60)
            check('cambiar el tenant en la URL no sirve', False, 'devolvio 200 — FUGA')
        except urllib.error.HTTPError as e:
            check('cambiar el tenant en la URL no sirve', e.code in (400, 403), 'HTTP %s' % e.code)

    s, integridad = admin.pedir('GET', '/evidence/photos/%s/integrity' % foto_id)
    check('la verificacion de integridad dice que esta intacta',
          s == 200 and (integridad or {}).get('estado') == 'intacta',
          'HTTP %s %s' % (s, str(integridad)[:120]))

print()
print('=' * 72)
print('7. INFORMES EN PDF (#85, #88)')
print('=' * 72)
if patrols:
    pid = patrols[0]['id']
    s, cuerpo = admin.pedir('GET', '/reports/patrols/%s' % pid, crudo=True)
    check('el PDF de una ronda se genera',
          s == 200 and isinstance(cuerpo, bytes) and cuerpo[:4] == b'%PDF',
          'HTTP %s, empieza con %s' % (s, cuerpo[:8] if isinstance(cuerpo, bytes) else cuerpo))
    if isinstance(cuerpo, bytes) and cuerpo[:4] == b'%PDF':
        print('     (%d KB)' % (len(cuerpo) // 1024))
    s, _ = guardia.pedir('GET', '/reports/patrols/%s' % pid)
    check('el GUARDIA no puede bajar informes', s == 403, 'HTTP %s' % s)
else:
    # Un `print` suelto no lo cuenta nadie: sin rondas estas dos no se ejecutan
    # y tienen que aparecer en el recuento final como lo que son.
    omitido(['el PDF de una ronda se genera', 'el GUARDIA no puede bajar informes'],
            'no hay rondas en el resumen de la empresa', POR_EL_DESPLIEGUE)

# --------------------------------------------------------------------------
# DE AQUI EN ADELANTE: lo que entro despues y la prueba no cubria.
# --------------------------------------------------------------------------

# Datos de partida que necesitan casi todas las secciones nuevas. Se resuelven
# UNA vez y contra la API, no con identificadores escritos a mano: el seed puede
# cambiar y una prueba que trae los uuid del seed pegados deja de probar el
# despliegue y pasa a probar el seed.
SITIO = lista_sitios[0].get('id') if lista_sitios else None
PUNTO = None
if SITIO:
    s, puntos = admin.pedir('GET', '/admin/sites/%s/checkpoints' % SITIO)
    lista_puntos = lista_de(puntos, 'checkpoints')
    PUNTO = lista_puntos[0].get('id') if lista_puntos else None

print()
print('=' * 72)
print('8. LA CONFIGURACION BAJA AL RECINTO Y AL PUNTO (#80, #83)')
print('=' * 72)

# El parametro de prueba y sus valores salen del CATALOGO, no de un numero
# escrito aca: un numero de negocio en el codigo es justo lo que el producto
# prohibe, y ademas asi la prueba sigue sirviendo si manana la regla cambia de
# rango o entra otra que se configure por punto.
param_punto = None
for p in params:
    if p.get('type') == 'integer' and 'checkpoint' in (p.get('scopes') or []):
        param_punto = p
        break

# Los nombres van sueltos porque saltar el bloque tiene que costar UN "sin
# probar" por comprobacion, no uno por bloque.
CASCADA_LECTURA = [
    'la configuracion de un recinto se puede consultar',
    'la configuracion de un punto de control se puede consultar',
]
CASCADA_ESCRITURA = [
    'configurar el recinto cambia el valor que rige ahi',
    'y el origen del valor pasa a ser el recinto',
    'configurar el punto le gana a lo del recinto',
    'y el origen del valor pasa a ser el punto',
    'preguntar solo por el punto ya resuelve la cascada completa',
    'la otra empresa no hereda la configuracion de un recinto ajeno',
    'a la otra empresa no le baja NI UN valor del punto de control ajeno',
    'quitar el valor del punto lo devuelve al del recinto',
    'quitar el valor del recinto lo devuelve al nivel de arriba',
    'la prueba deja el recinto como lo encontro',
    'la prueba deja el punto como lo encontro',
]
CASCADA_BORDES = [
    'una regla que no se configura por punto se rechaza ahi',
    '  y el rechazo dice que es por el NIVEL, no por el rango',
    'configurar un recinto inexistente da 404',
    'configurar un punto inexistente da 404',
    'consultar un recinto inexistente no inventa valores propios',
    'el GUARDIA no lee la configuracion de un recinto',
]

if not SITIO or not PUNTO or not param_punto:
    omitido(CASCADA_LECTURA + CASCADA_ESCRITURA + CASCADA_BORDES,
            'faltan recinto, punto o un parametro configurable por punto', POR_EL_DESPLIEGUE)
else:
    LLAVE = param_punto['key']
    print('     (parametro de prueba: %s)' % LLAVE)

    # Lo que hay guardado HOY en cada nivel. Se restaura al final pase lo que
    # pase: esta prueba corre contra un despliegue compartido.
    s, vista_sitio = admin.pedir('GET', '/rules/admin/sites/%s' % SITIO)
    check('la configuracion de un recinto se puede consultar', s == 200, 'HTTP %s' % s)
    original_sitio = cuerpo_dict(vista_sitio).get('overrides') or {}

    s, vista_punto = admin.pedir('GET', '/rules/admin/checkpoints/%s' % PUNTO)
    check('la configuracion de un punto de control se puede consultar', s == 200, 'HTTP %s' % s)
    original_punto = cuerpo_dict(vista_punto).get('overrides') or {}

    heredado = cuerpo_dict(vista_sitio).get('effective', {}).get(LLAVE)
    nivel_heredado = cuerpo_dict(vista_sitio).get('sources', {}).get(LLAVE)
    minimo = param_punto.get('min') or 0
    maximo = param_punto.get('max') or 0
    candidatos = [param_punto.get('min'), param_punto.get('max'), (minimo + maximo) // 2]
    distintos = [v for v in candidatos if isinstance(v, int) and v != heredado]
    valor_sitio = distintos[0] if distintos else None
    valor_punto = distintos[1] if len(distintos) > 1 else None

    if valor_sitio is None or valor_punto is None:
        omitido(CASCADA_ESCRITURA,
                'el catalogo no ofrece dos valores validos distintos del heredado', POR_LA_PRUEBA)
    else:
        try:
            s, tras_sitio = admin.pedir(
                'PUT', '/rules/admin/sites/%s' % SITIO,
                dict(original_sitio, **{LLAVE: valor_sitio}))
            d = cuerpo_dict(tras_sitio)
            check('configurar el recinto cambia el valor que rige ahi',
                  s == 200 and d.get('effective', {}).get(LLAVE) == valor_sitio,
                  'HTTP %s, quedo en %s' % (s, d.get('effective', {}).get(LLAVE)))
            check('  y el origen del valor pasa a ser el recinto',
                  d.get('sources', {}).get(LLAVE) == 'site',
                  'dice %s' % d.get('sources', {}).get(LLAVE))

            s, tras_punto = admin.pedir(
                'PUT', '/rules/admin/checkpoints/%s' % PUNTO,
                dict(original_punto, **{LLAVE: valor_punto}))
            d = cuerpo_dict(tras_punto)
            check('configurar el punto le gana a lo del recinto',
                  s == 200 and d.get('effective', {}).get(LLAVE) == valor_punto,
                  'HTTP %s, quedo en %s' % (s, d.get('effective', {}).get(LLAVE)))
            check('  y el origen del valor pasa a ser el punto',
                  d.get('sources', {}).get(LLAVE) == 'checkpoint',
                  'dice %s' % d.get('sources', {}).get(LLAVE))

            # El punto sabe a que recinto pertenece: quien pregunta por el punto
            # no tiene que mandar tambien el recinto para que la cascada resuelva.
            s, efectivas = admin.pedir('GET', '/rules/effective?checkpointId=%s' % PUNTO)
            d = cuerpo_dict(efectivas)
            check('preguntar solo por el punto ya resuelve la cascada completa',
                  s == 200 and d.get('rules', {}).get(LLAVE) == valor_punto
                  and d.get('sources', {}).get(LLAVE) == 'checkpoint',
                  'HTTP %s %s' % (s, str(d.get('sources', {}).get(LLAVE))))

            # AISLAMIENTO DE VERDAD, y por eso va AQUI y no en la seccion 15:
            # solo en este punto del guion el recinto y el punto de demo-andina
            # tienen un override puesto. Preguntado despues de restaurar, un
            # "no ve nada" no probaria nada porque no habria nada que ver.
            #
            # /rules/effective se lo responde a cualquiera con sesion, asi que no
            # hay 403 que mirar: se mira el VALOR y el ORIGEN.
            s, ajenas = ses_b.pedir('GET', '/rules/effective?siteId=%s' % SITIO)
            valor_ajeno = cuerpo_dict(ajenas).get('rules', {}).get(LLAVE)
            check('la otra empresa no hereda la configuracion de un recinto ajeno',
                  s == 200 and valor_ajeno != valor_sitio and valor_ajeno != valor_punto,
                  'HTTP %s, la otra empresa ve %s' % (s, valor_ajeno))

            s, ajenas_punto = ses_b.pedir('GET', '/rules/effective?checkpointId=%s' % PUNTO)
            d = cuerpo_dict(ajenas_punto)
            origenes = (d.get('sources') or {}).values()
            colados = sorted(set(o for o in origenes if o in ('site', 'checkpoint')))
            check('a la otra empresa no le baja NI UN valor del punto de control ajeno',
                  s == 200 and not colados and d.get('rules', {}).get(LLAVE) != valor_punto,
                  'HTTP %s, se colaron valores de nivel %s' % (s, colados))

            # Volver a heredar: quitar el valor del punto lo devuelve al recinto.
            s, tras_limpiar_punto = admin.pedir(
                'PUT', '/rules/admin/checkpoints/%s' % PUNTO, dict(original_punto))
            d = cuerpo_dict(tras_limpiar_punto)
            check('quitar el valor del punto lo devuelve al del recinto',
                  s == 200 and d.get('effective', {}).get(LLAVE) == valor_sitio
                  and d.get('sources', {}).get(LLAVE) == 'site',
                  'HTTP %s, quedo %s desde %s' % (s, d.get('effective', {}).get(LLAVE),
                                                  d.get('sources', {}).get(LLAVE)))

            # Y quitar el del recinto lo devuelve al nivel de donde venia.
            s, tras_limpiar_sitio = admin.pedir(
                'PUT', '/rules/admin/sites/%s' % SITIO, dict(original_sitio))
            d = cuerpo_dict(tras_limpiar_sitio)
            check('quitar el valor del recinto lo devuelve al nivel de arriba',
                  s == 200 and d.get('effective', {}).get(LLAVE) == heredado
                  and d.get('sources', {}).get(LLAVE) == nivel_heredado,
                  'HTTP %s, quedo %s desde %s' % (s, d.get('effective', {}).get(LLAVE),
                                                  d.get('sources', {}).get(LLAVE)))
        finally:
            # Restauracion incondicional: si algo de arriba se cayo, el recinto y
            # el punto igual quedan como estaban.
            admin.pedir('PUT', '/rules/admin/sites/%s' % SITIO, dict(original_sitio))
            admin.pedir('PUT', '/rules/admin/checkpoints/%s' % PUNTO, dict(original_punto))

        s, vuelta = admin.pedir('GET', '/rules/admin/sites/%s' % SITIO)
        check('la prueba deja el recinto como lo encontro',
              s == 200 and (cuerpo_dict(vuelta).get('overrides') or {}) == original_sitio,
              'quedo %s' % str(cuerpo_dict(vuelta).get('overrides'))[:100])
        s, vuelta = admin.pedir('GET', '/rules/admin/checkpoints/%s' % PUNTO)
        check('la prueba deja el punto como lo encontro',
              s == 200 and (cuerpo_dict(vuelta).get('overrides') or {}) == original_punto,
              'quedo %s' % str(cuerpo_dict(vuelta).get('overrides'))[:100])

    # Reglas que no se configuran a ese nivel, y objetivos que no existen.
    #
    # La regla y el valor salen del CATALOGO, no escritos aca. Con un par fijo
    # ({'photoRetentionDays': 90}) la comprobacion seguia en verde el dia que el
    # rango de esa regla se estrechara, pero el 400 ya vendria de la validacion
    # de RANGO y no del nivel: verde probando otra cosa. Por eso el valor es el
    # `default` del catalogo —siempre valido para el schema— y ademas se exige
    # que el mensaje diga que el rechazo es por el nivel.
    fuera_de_nivel = next(
        (p for p in params
         if 'checkpoint' not in (p.get('scopes') or []) and p.get('default') is not None),
        None)
    if not fuera_de_nivel:
        omitido(['una regla que no se configura por punto se rechaza ahi',
                 '  y el rechazo dice que es por el NIVEL, no por el rango'],
                'el catalogo no trae ninguna regla que el punto de control no configure',
                POR_LA_PRUEBA)
    else:
        s, motivo = admin.pedir(
            'PUT', '/rules/admin/checkpoints/%s' % PUNTO,
            {fuera_de_nivel['key']: fuera_de_nivel['default']})
        check('una regla que no se configura por punto se rechaza ahi', s == 400,
              'regla %s, HTTP %s' % (fuera_de_nivel['key'], s))
        texto_motivo = str(cuerpo_dict(motivo).get('message', ''))
        check('  y el rechazo dice que es por el NIVEL, no por el rango',
              'punto de control' in texto_motivo, texto_motivo[:140])

    s, _ = admin.pedir('PUT', '/rules/admin/sites/%s' % uuid.uuid4(), {})
    check('configurar un recinto inexistente da 404', s == 404, 'HTTP %s' % s)

    s, _ = admin.pedir('PUT', '/rules/admin/checkpoints/%s' % uuid.uuid4(), {})
    check('configurar un punto inexistente da 404', s == 404, 'HTTP %s' % s)

    s, vista = admin.pedir('GET', '/rules/admin/sites/%s' % uuid.uuid4())
    d = cuerpo_dict(vista)
    check('consultar un recinto inexistente no inventa valores propios',
          s == 200 and (d.get('overrides') or {}) == {}
          and 'site' not in (d.get('sources') or {}).values(),
          'HTTP %s %s' % (s, str(d.get('overrides'))[:80]))

    s, _ = guardia.pedir('GET', '/rules/admin/sites/%s' % SITIO)
    check('el GUARDIA no lee la configuracion de un recinto', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('9. MODULOS CONTRATADOS POR EMPRESA Y POR PLAN (#82)')
print('=' * 72)
s, catalogo_mod = admin.pedir('GET', '/features/catalog')
modulos = cuerpo_dict(catalogo_mod).get('modules') or []
check('el catalogo de modulos responde', s == 200 and len(modulos) > 0,
      'HTTP %s, %d modulos' % (s, len(modulos)))
if modulos:
    check('  cada modulo dice que hace y que deja de verse al apagarlo',
          all(m.get('description') and m.get('whenOff') for m in modulos),
          str(modulos[0])[:150])
else:
    omitido('cada modulo dice que hace y que deja de verse al apagarlo',
            'el catalogo de modulos vino vacio', POR_LA_PRUEBA)

s, vista_g = guardia.pedir('GET', '/features')
check('el guardia sabe que modulos tiene prendidos su empresa',
      s == 200 and isinstance(cuerpo_dict(vista_g).get('enabled'), dict), 'HTTP %s' % s)

s, vista_admin = admin.pedir('GET', '/features/admin')
d = cuerpo_dict(vista_admin)
check('el admin ve los modulos de su empresa', s == 200, 'HTTP %s' % s)
check('  y ve cual es el techo de su licencia', isinstance(d.get('entitlements'), dict),
      str(list(d.keys()))[:120])
check('  y de quien es la decision de cada modulo', isinstance(d.get('sources'), dict),
      str(list(d.keys()))[:120])

entitlements = d.get('entitlements') or {}
efectivos = d.get('enabled') or {}
guardado = d.get('stored') or {}
editables = [m.get('key') for m in (d.get('editable') or [])]

fuera_de_plan = [k for k, incluido in entitlements.items() if incluido is False]
check('  los modulos fuera de la licencia no se ofrecen como editables',
      all(k not in editables for k in fuera_de_plan),
      'editables: %s / fuera: %s' % (editables, fuera_de_plan))

if fuera_de_plan:
    modulo = fuera_de_plan[0]
    s, error = admin.pedir('PUT', '/features/admin', dict(guardado, **{modulo: True}))
    check('el admin no puede encender lo que su plan no incluye', s == 403,
          'HTTP %s %s' % (s, str(error)[:120]))
    mensaje = str(cuerpo_dict(error).get('message', ''))
    ficha = next((m for m in modulos if m.get('key') == modulo), {})
    check('  y el rechazo nombra el modulo como lo conoce el cliente',
          bool(ficha.get('label')) and ficha['label'] in mensaje, mensaje[:140])
    s, vuelta = admin.pedir('GET', '/features/admin')
    check('  y el intento rechazado no dejo nada escrito',
          s == 200 and (cuerpo_dict(vuelta).get('stored') or {}) == guardado,
          str(cuerpo_dict(vuelta).get('stored'))[:120])
else:
    omitido(['el admin no puede encender lo que su plan no incluye',
             'el rechazo nombra el modulo como lo conoce el cliente',
             'el intento rechazado no dejo nada escrito'],
            'la licencia de esta empresa incluye todos los modulos', POR_EL_DESPLIEGUE)

# Apagar y volver a prender uno que SI esta en la licencia.
apagable = next((k for k in editables if efectivos.get(k) is True), None)
if apagable is None:
    omitido(['el admin apaga un modulo incluido en su plan',
             'queda registrado que la decision fue del administrador',
             'la prueba deja los modulos como los encontro'],
            'no hay ningun modulo prendido y editable', POR_EL_DESPLIEGUE)
else:
    try:
        s, tras = admin.pedir('PUT', '/features/admin', dict(guardado, **{apagable: False}))
        d = cuerpo_dict(tras)
        check('el admin apaga un modulo incluido en su plan',
              s == 200 and d.get('enabled', {}).get(apagable) is False,
              'HTTP %s, quedo %s' % (s, d.get('enabled', {}).get(apagable)))
        check('  y queda registrado que la decision fue del administrador',
              d.get('sources', {}).get(apagable) == 'admin',
              'dice %s' % d.get('sources', {}).get(apagable))
    finally:
        admin.pedir('PUT', '/features/admin', dict(guardado))
    s, vuelta = admin.pedir('GET', '/features/admin')
    check('la prueba deja los modulos como los encontro',
          s == 200 and (cuerpo_dict(vuelta).get('stored') or {}) == guardado,
          str(cuerpo_dict(vuelta).get('stored'))[:120])

s, _ = admin.pedir('PUT', '/features/admin', {'moduloQueNoExiste': True})
check('un modulo desconocido se rechaza', s == 400, 'HTTP %s' % s)

s, _ = guardia.pedir('GET', '/features/admin')
check('el GUARDIA no administra los modulos de la empresa', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('10. CONSENTIMIENTO Y AVISO DE UBICACION (#78)')
print('=' * 72)
s, aviso = guardia.pedir('GET', '/consent/policy')
d = cuerpo_dict(aviso)
check('el guardia recibe el aviso vigente y su propio estado',
      s == 200 and 'hasPolicy' in d and isinstance(d.get('acceptance'), dict), 'HTTP %s' % s)
check('  y el aviso dice si se registra ubicacion, cada cuanto y por cuanto tiempo',
      isinstance(d.get('tracking'), dict)
      and set(('enabled', 'sampleIntervalSeconds', 'retentionDays')) <= set(d['tracking'].keys()),
      str(d.get('tracking'))[:140])

s, historial = admin.pedir('GET', '/consent/policies')
check('el admin ve el historial de avisos publicados', s == 200 and isinstance(historial, list),
      'HTTP %s %s' % (s, str(historial)[:100]))

# Version nueva en cada corrida: un texto publicado NO se reescribe, asi que
# reusar el nombre haria que la prueba pasara una vez y chocara para siempre.
version = 'e2e-%s' % uuid.uuid4().hex[:12]
texto = (
    'Aviso de geolocalizacion generado por la prueba de humo automatizada. '
    'Durante el turno se registra la ubicacion del trabajador con el unico fin '
    'de acreditar el recorrido de la ronda ante el cliente. No se registra '
    'ubicacion fuera del turno. El dato se conserva por el plazo configurado por '
    'la empresa y despues se elimina.'
)
PUBLICACION_DEPENDIENTES = [
    'el admin publica una version nueva del aviso',
    'la respuesta dice a cuanta gente deja pendiente de reaceptar',
    'publicar dos veces la misma version se rechaza',
    'el texto completo de una version se puede recuperar como prueba',
    'el guardia ya ve el aviso recien publicado',
    'y se le pide aceptarlo, porque todavia no lo hizo',
    'el aviso nuevo queda en el historial y es el vigente',
    'y como maximo uno del historial figura como vigente',
]

# APAGAR LA REACEPTACION ANTES DE PUBLICAR, Y RESTAURARLA PASE LO QUE PASE.
#
# Publicar un aviso no es solo escribir una fila: con consentReacceptOnNewPolicy
# activo —y su default es true, rules.ts— el producto corre
# `UPDATE gps_consents SET revoked_at = now() WHERE revoked_at IS NULL AND
# policy_version <> $1` sobre toda la empresa. Eso deja a TODOS los trabajadores
# de la empresa demo sin consentimiento de ubicacion vigente, y la API no expone
# ninguna forma de devolverlo: solo lo repone cada persona aceptando de nuevo
# desde la app. Una prueba de humo que revoca eso en cada corrida no se puede
# correr dos veces, que era justamente el criterio.
#
# Mismo patron que la seccion de gpsSharingMandatory mas abajo: leer, tocar,
# restaurar en `finally`, y comprobar despues que quedo igual.
politica_id = None
s, reglas_consent = admin.pedir('GET', '/rules/admin')
overrides_consent = cuerpo_dict(reglas_consent).get('overrides') or {}
s_apagar, _ = admin.pedir(
    'PUT', '/rules/admin', dict(overrides_consent, consentReacceptOnNewPolicy=False))
check('se puede apagar la reaceptacion antes de publicar, para no revocarle el consentimiento a nadie',
      s_apagar == 200, 'HTTP %s' % s_apagar)

try:
    if s_apagar != 200:
        # Sin poder apagarla, publicar le quitaria el consentimiento a toda la
        # empresa. Se prefiere no probar antes que dejar el ambiente peor. Las
        # otras siete que dependen de la publicacion las anota el `else` de mas
        # abajo, porque politica_id se queda en None: aca solo va la publicacion.
        omitido(PUBLICACION_DEPENDIENTES[0],
                'no se pudo apagar la reaceptacion: publicar habria revocado el '
                'consentimiento de ubicacion de toda la empresa', POR_LA_PRUEBA)
    else:
        s, publicado = admin.pedir('POST', '/consent/policies', {
            'version': version,
            'body': texto,
            'privacyPolicyUrl': 'https://example.com/privacidad-sentrycore',
        })
        check('el admin publica una version nueva del aviso', s in (200, 201),
              'HTTP %s %s' % (s, str(publicado)[:160]))
        politica_id = cuerpo_dict(publicado).get('id')
finally:
    admin.pedir('PUT', '/rules/admin', dict(overrides_consent))

s, vuelta_consent = admin.pedir('GET', '/rules/admin')
check('la prueba deja la regla de reaceptacion como la encontro',
      s == 200 and (cuerpo_dict(vuelta_consent).get('overrides') or {}) == overrides_consent,
      'quedo %s' % str(cuerpo_dict(vuelta_consent).get('overrides'))[:120])

if politica_id:
    check('  y la respuesta dice a cuanta gente deja pendiente de reaceptar',
          'pendingReacceptance' in cuerpo_dict(publicado), str(publicado)[:140])

    s, repetida = admin.pedir('POST', '/consent/policies', {
        'version': version, 'body': texto,
        'privacyPolicyUrl': 'https://example.com/privacidad-sentrycore'})
    check('publicar dos veces la misma version se rechaza', s == 409, 'HTTP %s' % s)

    s, detalle = admin.pedir('GET', '/consent/policies/%s' % politica_id)
    d = cuerpo_dict(detalle)
    check('el texto completo de una version se puede recuperar como prueba',
          s == 200 and d.get('body') == texto and d.get('isCurrent') is True,
          'HTTP %s %s' % (s, str(d)[:120]))

    s, aviso2 = guardia.pedir('GET', '/consent/policy')
    d = cuerpo_dict(aviso2)
    check('el guardia ya ve el aviso recien publicado',
          s == 200 and d.get('hasPolicy') is True
          and (d.get('policy') or {}).get('version') == version,
          'HTTP %s %s' % (s, str(d.get('policy'))[:120]))
    check('  y se le pide aceptarlo, porque todavia no lo hizo',
          d.get('actionRequired') in ('aceptar', 'reaceptar'),
          'dice %s' % d.get('actionRequired'))

    s, historial2 = admin.pedir('GET', '/consent/policies')
    # El guardado se hace UNA vez y se usa en las tres lineas de abajo. Antes
    # solo estaba en la primera: si el endpoint devolvia un objeto de error, el
    # `for p in historial2` recorria las claves como texto y `p.get` reventaba
    # con AttributeError. La prueba moria con traza en vez de reportar FALLA,
    # justo en el escenario en que hace falta que reporte.
    hist = historial2 if isinstance(historial2, list) else []
    versiones = [p.get('version') for p in hist]
    vigentes = sum(1 for p in hist if p.get('isCurrent'))
    check('el aviso nuevo queda en el historial y es el vigente',
          s == 200 and version in versiones
          and next((p.get('isCurrent') for p in hist if p.get('version') == version), None) is True,
          'versiones: %s' % str(versiones[:5]))
    check('  y como maximo uno del historial figura como vigente',
          vigentes <= 1, 'vigentes: %d' % vigentes)
else:
    omitido(PUBLICACION_DEPENDIENTES[1:], 'no se pudo publicar el aviso', POR_LA_PRUEBA)

s, _ = admin.pedir('POST', '/consent/policies', {
    'version': 'e2e-corto-%s' % uuid.uuid4().hex[:6], 'body': 'Se registra el GPS.',
    'privacyPolicyUrl': 'https://example.com/privacidad-sentrycore'})
check('un aviso demasiado corto para informar de verdad se rechaza', s == 400, 'HTTP %s' % s)

s, _ = admin.pedir('POST', '/consent/policies', {
    'version': 'e2e-http-%s' % uuid.uuid4().hex[:6], 'body': texto,
    'privacyPolicyUrl': 'http://example.com/privacidad-sentrycore'})
check('una politica de privacidad que no es https se rechaza', s == 400, 'HTTP %s' % s)

s, registro = admin.pedir('GET', '/consent/roster')
d = cuerpo_dict(registro)
check('el admin ve quien acepto y sobre todo quien falta',
      s == 200 and isinstance(d.get('people'), list) and isinstance(d.get('summary'), dict),
      'HTTP %s %s' % (s, str(d)[:120]))

s, auditoria = admin.pedir('GET', '/consent/off-shift-audit?from=2026-01-01&to=2026-12-31')
d = cuerpo_dict(auditoria)
check('se puede demostrar si hubo o no rastreo fuera del turno',
      s == 200 and 'compliant' in d and isinstance(d.get('summary'), dict),
      'HTTP %s %s' % (s, str(d)[:120]))

s, _ = admin.pedir('GET', '/consent/off-shift-audit?from=2026-12-31&to=2026-01-01')
check('un periodo con las fechas al reves se rechaza', s == 400, 'HTTP %s' % s)

s, _ = supervisor.pedir('GET', '/consent/roster')
check('el SUPERVISOR no ve el registro de toda la empresa', s == 403, 'HTTP %s' % s)

s, _ = guardia.pedir('GET', '/consent/policies')
check('el GUARDIA no publica ni administra avisos', s == 403, 'HTTP %s' % s)

# --- El aviso tiene que decir la VERDAD sobre si se registra ubicacion -------
# gpsSharingMandatory decide obligatorio vs OPCIONAL, y gpsTrackingEnabled decide
# encendido vs apagado. Confundirlos ya llego a produccion tres veces, en tres
# modulos distintos. Aca se comprueba contra el despliegue: se mueve cada una por
# separado y se mira que dicen el aviso legal y el tablero en vivo.
AVISO_DICE_LA_VERDAD = [
    'con la ubicacion OPCIONAL el aviso sigue diciendo que SI se registra',
    'el tablero en vivo muestra el seguimiento encendido',
    'con el seguimiento APAGADO el aviso dice que NO se registra, aunque la ubicacion sea obligatoria',
    'el tablero en vivo deja de mostrar posiciones',
]
s, reglas_actuales = admin.pedir('GET', '/rules/admin')
overrides_empresa = cuerpo_dict(reglas_actuales).get('overrides') or {}
try:
    s, _ = admin.pedir('PUT', '/rules/admin', dict(
        overrides_empresa, gpsTrackingEnabled=True, gpsSharingMandatory=False))
    if s != 200:
        # El motivo dice el HTTP a proposito. Cuando el renombre de esta misma
        # regla no llego hasta aca, el PUT empezo a devolver 400 (el schema del
        # PUT es strict(): una clave que ya no existe es 400, no un descarte) y
        # el motivo a secas no dejaba ver que lo roto era la prueba.
        omitido(AVISO_DICE_LA_VERDAD,
                'no se pudo dejar la empresa con el seguimiento encendido: HTTP %s' % s,
                POR_LA_PRUEBA)
    else:
        s, aviso3 = guardia.pedir('GET', '/consent/policy')
        check('con la ubicacion OPCIONAL el aviso sigue diciendo que SI se registra',
              s == 200 and cuerpo_dict(aviso3).get('tracking', {}).get('enabled') is True,
              'HTTP %s, el aviso dice %s' % (
                  s, cuerpo_dict(aviso3).get('tracking', {}).get('enabled')))

        s, tablero = supervisor.pedir('GET', '/supervisor/live')
        rondas = cuerpo_dict(tablero).get('patrols') or []
        if rondas:
            check('  y el tablero en vivo tambien muestra el seguimiento encendido',
                  all(r.get('gpsEnabled') is True for r in rondas),
                  str([r.get('gpsEnabled') for r in rondas])[:80])
        else:
            omitido('el tablero en vivo muestra el seguimiento encendido',
                    'no hay rondas en curso ni programadas ahora', POR_EL_DESPLIEGUE)

        s, _ = admin.pedir('PUT', '/rules/admin', dict(
            overrides_empresa, gpsTrackingEnabled=False, gpsSharingMandatory=True))
        s2, aviso4 = guardia.pedir('GET', '/consent/policy')
        check('con el seguimiento APAGADO el aviso dice que NO se registra, aunque la ubicacion sea obligatoria',
              s == 200 and s2 == 200
              and cuerpo_dict(aviso4).get('tracking', {}).get('enabled') is False,
              'HTTP %s/%s, el aviso dice %s' % (
                  s, s2, cuerpo_dict(aviso4).get('tracking', {}).get('enabled')))

        s, tablero2 = supervisor.pedir('GET', '/supervisor/live')
        rondas2 = cuerpo_dict(tablero2).get('patrols') or []
        if rondas2:
            check('  y el tablero en vivo deja de mostrar posiciones',
                  all(r.get('gpsEnabled') is False and r.get('position') is None
                      for r in rondas2),
                  str([(r.get('gpsEnabled'), r.get('position')) for r in rondas2])[:100])
        else:
            omitido('el tablero en vivo deja de mostrar posiciones',
                    'no hay rondas en curso ni programadas ahora', POR_EL_DESPLIEGUE)
finally:
    admin.pedir('PUT', '/rules/admin', dict(overrides_empresa))

s, vuelta = admin.pedir('GET', '/rules/admin')
check('la prueba deja la configuracion de la empresa como la encontro',
      s == 200 and (cuerpo_dict(vuelta).get('overrides') or {}) == overrides_empresa,
      'quedo %s' % str(cuerpo_dict(vuelta).get('overrides'))[:120])

print()
print('=' * 72)
print('11. ALERTAS DE RONDA EN LA BANDEJA DEL SUPERVISOR (#98)')
print('=' * 72)
alerta_id = None
ALERTAS_BLOQUE = [
    'una novedad grave del guardia queda registrada',
    'el supervisor abre la bandeja de alertas de su recinto',
    'y la bandeja arranca mostrando solo lo pendiente',
    'y cada alerta viene con titulo legible y urgencia',
    'la novedad grave recien registrada aparece como alerta',
    'el supervisor atiende la alerta dejando constancia de que hizo',
    'y atenderla dos veces se rechaza',
    'la alerta atendida sigue en el historial con quien la atendio',
    'y ya no aparece entre lo pendiente',
    'atender una alerta inexistente da 404 y no filtra',
    'atender sin decir que se hizo se rechaza',
    'un filtro con valor invalido se rechaza',
    'el ADMIN no entra a la bandeja de terreno del supervisor',
]
ALERTAS_DE_LA_MIA = ALERTAS_BLOQUE[5:9] + ['atender sin decir que se hizo se rechaza']
if not SITIO:
    omitido(ALERTAS_BLOQUE, 'no hay recintos', POR_EL_DESPLIEGUE)
else:
    # Una novedad grave nueva en cada corrida genera una alerta nueva: asi el
    # "atender" se puede probar dos veces seguidas sin depender de que haya
    # quedado algo pendiente de la corrida anterior.
    s, novedad = guardia.pedir('POST', '/guard/events', {
        'clientEventId': str(uuid.uuid4()),
        'criticality': 'alta',
        'text': 'Prueba e2e automatizada: incidente para la bandeja del supervisor',
    })
    novedad_id = cuerpo_dict(novedad).get('id')
    check('una novedad grave del guardia queda registrada', s in (200, 201),
          'HTTP %s %s' % (s, str(novedad)[:120]))

    s, bandeja = supervisor.pedir('GET', '/supervisor/sites/%s/alerts' % SITIO)
    d = cuerpo_dict(bandeja)
    alertas = d.get('alerts') or []
    check('el supervisor abre la bandeja de alertas de su recinto',
          s == 200 and isinstance(alertas, list), 'HTTP %s %s' % (s, str(d)[:120]))
    check('  y la bandeja arranca mostrando solo lo pendiente',
          d.get('onlyPending') is True and 'pendingByKind' in d, str(d)[:140])
    check('  y cada alerta viene con titulo legible y urgencia',
          all(a.get('title') and a.get('severity') in ('media', 'alta') for a in alertas),
          str([a.get('title') for a in alertas])[:140])

    mias = [a for a in alertas if a.get('eventId') == novedad_id]
    check('  la novedad grave recien registrada aparece como alerta',
          len(mias) == 1, '%d alertas apuntan a esa novedad' % len(mias))

    if mias:
        alerta_id = mias[0]['id']
        s, atendida = supervisor.pedir('POST', '/supervisor/alerts/%s/attend' % alerta_id,
                                       {'comment': 'Atendida por la prueba de humo automatizada'})
        d = cuerpo_dict(atendida)
        check('el supervisor atiende la alerta dejando constancia de que hizo',
              s in (200, 201) and d.get('attendedAt'), 'HTTP %s %s' % (s, str(d)[:120]))

        s, _ = supervisor.pedir('POST', '/supervisor/alerts/%s/attend' % alerta_id,
                                {'comment': 'Atendida por la prueba de humo automatizada'})
        check('  y atenderla dos veces se rechaza', s == 409, 'HTTP %s' % s)

        s, historial_b = supervisor.pedir(
            'GET', '/supervisor/sites/%s/alerts?onlyPending=false' % SITIO)
        atendidas = [a for a in (cuerpo_dict(historial_b).get('alerts') or [])
                     if a.get('id') == alerta_id]
        check('  la alerta atendida sigue en el historial con quien la atendio',
              s == 200 and len(atendidas) == 1 and atendidas[0].get('attendedById'),
              'HTTP %s %s' % (s, str(atendidas)[:120]))

        s, pendientes = supervisor.pedir('GET', '/supervisor/sites/%s/alerts' % SITIO)
        sigue = [a for a in (cuerpo_dict(pendientes).get('alerts') or [])
                 if a.get('id') == alerta_id]
        check('  y ya no aparece entre lo pendiente', s == 200 and not sigue,
              'HTTP %s, sigue %d veces' % (s, len(sigue)))
    else:
        omitido(ALERTAS_DE_LA_MIA, 'la novedad grave no genero alerta', POR_LA_PRUEBA)

    s, _ = supervisor.pedir('POST', '/supervisor/alerts/%s/attend' % uuid.uuid4(),
                            {'comment': 'Atendida por la prueba de humo automatizada'})
    check('atender una alerta inexistente da 404 y no filtra', s == 404, 'HTTP %s' % s)

    if alerta_id:
        s, _ = supervisor.pedir('POST', '/supervisor/alerts/%s/attend' % alerta_id,
                                {'comment': 'x'})
        check('atender sin decir que se hizo se rechaza', s == 400, 'HTTP %s' % s)

    s, _ = supervisor.pedir('GET', '/supervisor/sites/%s/alerts?onlyPending=quiza' % SITIO)
    check('un filtro con valor invalido se rechaza', s == 400, 'HTTP %s' % s)

    s, _ = admin.pedir('GET', '/supervisor/sites/%s/alerts' % SITIO)
    check('el ADMIN no entra a la bandeja de terreno del supervisor', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('12. EXPORTACION A EXCEL (#136)')
print('=' * 72)
s, planilla = admin.pedir('GET', '/reports/excel', crudo=True)
tipo = admin.cabeceras.get('Content-Type', '')
adjunto = admin.cabeceras.get('Content-Disposition', '')
es_zip = isinstance(planilla, bytes) and planilla[:2] == b'PK'
check('la exportacion devuelve un archivo de verdad y no un JSON',
      s == 200 and es_zip,
      'HTTP %s, empieza con %r' % (s, planilla[:8] if isinstance(planilla, bytes) else planilla))
check('  y viaja anunciada como planilla, no como texto',
      'spreadsheetml' in tipo and 'json' not in tipo.lower(), 'dice %s' % tipo)
check('  y se descarga con nombre de archivo .xlsx',
      'attachment' in adjunto and '.xlsx' in adjunto, 'dice %s' % adjunto)
if es_zip:
    print('     (%d KB)' % max(1, len(planilla) // 1024))

s, _ = admin.pedir('GET', '/reports/excel?from=ayer')
check('un periodo mal escrito se rechaza antes de abrir la descarga', s == 400, 'HTTP %s' % s)

s, _ = admin.pedir('GET', '/reports/excel?siteId=%s' % uuid.uuid4())
check('exportar un recinto inexistente da 404 y no un archivo vacio', s == 404, 'HTTP %s' % s)

if SITIO:
    s, propia = supervisor.pedir('GET', '/reports/excel?siteId=%s' % SITIO, crudo=True)
    check('el supervisor exporta su recinto asignado',
          s == 200 and isinstance(propia, bytes) and propia[:2] == b'PK',
          'HTTP %s' % s)
else:
    omitido('el supervisor exporta su recinto asignado', 'no hay recintos', POR_EL_DESPLIEGUE)

s, _ = guardia.pedir('GET', '/reports/excel')
check('el GUARDIA no baja la planilla de la empresa', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('13. REGISTRO DE CORREO (#44) Y REPORTES DE CAIDA DE LA APP (#27)')
print('=' * 72)
s, envios = admin.pedir('GET', '/notif/envios')
check('el admin consulta el registro de correo de su empresa',
      s == 200 and isinstance(envios, list), 'HTTP %s %s' % (s, str(envios)[:120]))
if isinstance(envios, list) and envios:
    check('  y cada envio dice plantilla, destinatario y en que quedo',
          all(('plantilla' in e and 'destinatario' in e and 'estado' in e) for e in envios),
          str(envios[0])[:150])
else:
    omitido('cada envio dice plantilla, destinatario y en que quedo',
            'todavia no hay correos registrados en esta empresa', POR_EL_DESPLIEGUE)

s, _ = admin.pedir('GET', '/notif/envios?desde=2026-01-01')
check('filtrar por fechas sin decir el recinto se rechaza (el dia es el del recinto)',
      s == 400, 'HTTP %s' % s)

s, _ = admin.pedir('GET', '/notif/envios?limite=999999')
check('pedir un limite absurdo se rechaza', s == 400, 'HTTP %s' % s)

if patrols:
    s, por_ronda = admin.pedir('GET', '/notif/rondas/%s/envios' % patrols[0]['id'])
    d = cuerpo_dict(por_ronda)
    check('se puede saber si le llego el informe de una ronda al cliente',
          s == 200 and d.get('patrolId') == patrols[0]['id'] and isinstance(d.get('envios'), list),
          'HTTP %s %s' % (s, str(d)[:120]))
else:
    omitido('se puede saber si le llego el informe de una ronda al cliente', 'no hay rondas',
            POR_EL_DESPLIEGUE)

s, _ = admin.pedir('GET', '/notif/rondas/%s/envios' % uuid.uuid4())
check('preguntar por una ronda inexistente da 404 y no filtra', s == 404, 'HTTP %s' % s)

s, _ = supervisor.pedir('GET', '/notif/envios')
check('el SUPERVISOR no ve todo el correo de la empresa', s == 403, 'HTTP %s' % s)

# El reporte de caidas es un modulo que se vende: apagado, no existe.
s, mod = admin.pedir('GET', '/features')
caidas_prendidas = cuerpo_dict(mod).get('enabled', {}).get('crashReporting') is True
caida = {
    'errorName': 'NfcBridgeError',
    'errorMessage': 'Falla simulada por la prueba de humo automatizada',
    'appVersion': '0.0.0-e2e',
    'deviceModel': 'Redmi 9A',
    'androidVersion': '13',
}
if caidas_prendidas:
    s, registro = guardia.pedir('POST', '/observability/crash-reports', caida)
    alta = cuerpo_dict(registro)
    registrada = s == 202 and alta.get('registrado') is True
    limitada = (
        s == 202
        and alta.get('registrado') is False
        and alta.get('motivo') == 'limite_por_hora'
    )

    if registrada:
        check('la app puede reportar que se cerro sola', True)

        s, resumen = admin.pedir('GET', '/observability/crash-reports/summary')
        d = cuerpo_dict(resumen)
        grupos = d.get('grupos') if isinstance(d.get('grupos'), list) else []
        grupo_inyectado = next((grupo for grupo in grupos if (
            isinstance(grupo, dict)
            and grupo.get('errorName') == caida['errorName']
            and grupo.get('appVersion') == caida['appVersion']
            and grupo.get('deviceModel') == caida['deviceModel']
            and grupo.get('androidVersion') == caida['androidVersion']
        )), None)
        conteos_validos = (
            isinstance(grupo_inyectado, dict)
            and type(grupo_inyectado.get('total')) is int
            and type(grupo_inyectado.get('fatales')) is int
            and grupo_inyectado.get('total', 0) >= grupo_inyectado.get('fatales', 0) >= 1
        )
        check('el admin ve que se cae, en que version y en que telefono',
              s == 200 and bool(grupos) and grupo_inyectado is not None and conteos_validos,
              'HTTP %s grupos=%d inyectado=%s' %
              (s, len(grupos), grupo_inyectado is not None))

        # Frontera de privacidad de #225: proyectar despues en React no alcanza,
        # porque todo el JSON ya habria llegado a DevTools/Network. Se exige la
        # lista cerrada del DTO servidor para CADA grupo, sin fechas, huella,
        # mensaje, pila, ids ni campos libres adicionales. `bool(grupos)` y la
        # busqueda del fixture evitan que `all([])` apruebe sin medir nada.
        campos_grupo_seguro = {
            'errorName', 'appVersion', 'deviceModel', 'androidVersion', 'total', 'fatales'
        }
        campos_recibidos = [
            sorted(grupo.keys()) for grupo in grupos if isinstance(grupo, dict)
        ]
        contrato_seguro = (
            s == 200
            and bool(grupos)
            and grupo_inyectado is not None
            and conteos_validos
            and all(isinstance(grupo, dict) and set(grupo.keys()) == campos_grupo_seguro
                    for grupo in grupos)
        )
        check('el navegador recibe solo el DTO tecnico seguro de cada caida', contrato_seguro,
              'HTTP %s grupos=%d campos=%s' % (s, len(grupos), campos_recibidos[:3]))
    elif limitada:
        omitido([
            'la app puede reportar que se cerro sola',
            'el admin ve que se cae, en que version y en que telefono',
            'el navegador recibe solo el DTO tecnico seguro de cada caida',
        ], 'el guardia alcanzo el limite horario de reportes antes del fixture',
                POR_EL_DESPLIEGUE)
    else:
        check('la app puede reportar que se cerro sola', False,
              'HTTP %s registrado=%r motivo=%r' %
              (s, alta.get('registrado'), alta.get('motivo')))
        omitido([
            'el admin ve que se cae, en que version y en que telefono',
            'el navegador recibe solo el DTO tecnico seguro de cada caida',
        ], 'el POST del fixture no confirmo registrado=true', POR_LA_PRUEBA)

    s, _ = guardia.pedir('POST', '/observability/crash-reports',
                         dict(caida, guardName='Nombre de una persona'))
    check('un reporte de caida que trae datos de una persona se rechaza', s == 400,
          'HTTP %s' % s)

    s, _ = supervisor.pedir('GET', '/observability/crash-reports/summary')
    check('el SUPERVISOR no ve el resumen de caidas de toda la empresa', s == 403,
          'HTTP %s' % s)
else:
    s, _ = guardia.pedir('POST', '/observability/crash-reports', caida)
    check('con el modulo de caidas apagado la app no puede reportar nada', s == 404,
          'HTTP %s' % s)
    s, resumen = admin.pedir('GET', '/observability/crash-reports/summary')
    mensaje = str(cuerpo_dict(resumen).get('message', ''))
    check('  y el resumen desaparece en vez de quedar visible y bloqueado',
          s == 404 and 'Cannot GET' not in mensaje, 'HTTP %s %s' % (s, mensaje[:120]))
    omitido(['la app puede reportar que se cerro sola',
             'el admin ve que se cae, en que version y en que telefono',
             'un reporte de caida que trae datos de una persona se rechaza',
             'el SUPERVISOR no ve el resumen de caidas de toda la empresa'],
            'el modulo de reporte de caidas esta apagado en esta empresa', POR_EL_DESPLIEGUE)

print()
print('=' * 72)
print('14. MONITOREO EN VIVO Y RECINTOS ASIGNADOS (#97)')
print('=' * 72)
s, tablero = supervisor.pedir('GET', '/supervisor/live')
d = cuerpo_dict(tablero)
en_vivo = d.get('patrols')
check('el supervisor abre el tablero en vivo',
      s == 200 and isinstance(en_vivo, list), 'HTTP %s %s' % (s, str(d)[:120]))
check('  y el tablero dice cuando volver a preguntar',
      isinstance(d.get('pollAfterMs'), int) and d.get('refreshedAt'), str(d)[:140])
if en_vivo:
    check('  y cada ronda muestra su avance sobre los puntos esperados',
          all('progressPct' in r and 'expectedCheckpoints' in r and 'scannedCheckpoints' in r
              for r in en_vivo), str(en_vivo[0])[:150])
    check('  y sin seguimiento encendido no muestra ninguna posicion',
          all(r.get('position') is None for r in en_vivo if not r.get('gpsEnabled')),
          str([(r.get('gpsEnabled'), r.get('position')) for r in en_vivo])[:120])
else:
    omitido(['cada ronda del tablero muestra su avance sobre los puntos esperados',
             'sin seguimiento encendido el tablero no muestra ninguna posicion'],
            'no hay rondas en curso ni programadas ahora', POR_EL_DESPLIEGUE)

s, mis_sitios = supervisor.pedir('GET', '/supervisor/sites')
asignados = mis_sitios if isinstance(mis_sitios, list) else []
check('el supervisor sabe cuales son sus recintos asignados',
      s == 200 and isinstance(mis_sitios, list), 'HTTP %s %s' % (s, str(mis_sitios)[:120]))
if asignados:
    check('  y cada recinto viene con su zona horaria, que es la que manda',
          all(r.get('timezone') for r in asignados), str(asignados[0])[:150])
else:
    omitido('cada recinto asignado viene con su zona horaria',
            'el supervisor no tiene ningun recinto asignado', POR_EL_DESPLIEGUE)

ids_asignados = {r.get('id') for r in asignados}
ids_todos = {r.get('id') for r in lista_sitios}
check('  y todos los que ve son recintos de su propia empresa',
      ids_asignados <= ids_todos,
      'asignados %d de %d de la empresa' % (len(ids_asignados), len(ids_todos)))

# SUPERVISOR limitado a supervisor_sites. Esto NO puede depender de que el
# despliegue tenga un recinto de mas: el seed de referencia crea UN recinto por
# empresa y se lo asigna al supervisor de esa empresa, asi que `ids_todos -
# ids_asignados` queda vacio y las tres comprobaciones se saltaban enteras. Que
# pasaran dependia de la deriva de staging, no del producto.
#
# Asi que la prueba se fabrica el recinto que necesita, con el ADMIN, y no se lo
# asigna a nadie. Nombre FIJO y no unico por corrida: la API no ofrece borrar
# recintos, asi que uno nuevo cada vez iria dejando un cadaver por corrida. Con
# nombre fijo se crea una sola vez en la vida del despliegue, se reusa, y queda
# desactivado — que no le quita el 403, porque ensureAssignedSite mira
# supervisor_sites y no is_active.
ALCANCE_SUPERVISOR = [
    'el supervisor no abre la bandeja de un recinto que no supervisa',
    'ni las rondas de ese recinto',
    'ni exporta su planilla',
]
ajeno = next((r.get('id') for r in todos_los_sitios
              if r.get('name') == RECINTO_DESCARTABLE), None)
if ajeno is None:
    s, nuevo = admin.pedir('POST', '/admin/sites', {
        'branchName': 'Prueba automatizada',
        'name': RECINTO_DESCARTABLE,
        'address': 'Sin direccion: recinto que solo usa la prueba de humo',
    })
    ajeno = cuerpo_dict(nuevo).get('id') if s in (200, 201) else None

if not ajeno:
    omitido(ALCANCE_SUPERVISOR,
            'no se pudo disponer de un recinto sin asignar para probar el alcance', POR_LA_PRUEBA)
elif ajeno in ids_asignados:
    omitido(ALCANCE_SUPERVISOR,
            'el recinto descartable quedo asignado al supervisor: alguien lo asigno a mano',
            POR_LA_PRUEBA)
else:
    try:
        s, _ = supervisor.pedir('GET', '/supervisor/sites/%s/alerts' % ajeno)
        check('el supervisor no abre la bandeja de un recinto que no supervisa', s == 403,
              'HTTP %s' % s)
        s, _ = supervisor.pedir('GET', '/supervisor/sites/%s/patrols' % ajeno)
        check('  ni las rondas de ese recinto', s == 403, 'HTTP %s' % s)
        s, _ = supervisor.pedir('GET', '/reports/excel?siteId=%s' % ajeno)
        check('  ni exporta su planilla', s == 403, 'HTTP %s' % s)
    finally:
        # Desactivado pase lo que pase: no es un recinto de la operacion y no
        # tiene por que aparecer prendido en el panel del admin de la demo.
        admin.pedir('PATCH', '/admin/sites/%s/active' % ajeno, {'isActive': False})

    s, vuelta_sitios = admin.pedir('GET', '/admin/sites')
    descartable = next((r for r in (vuelta_sitios if isinstance(vuelta_sitios, list) else [])
                        if r.get('id') == ajeno), None)
    check('la prueba deja desactivado el recinto que se fabrico',
          s == 200 and descartable is not None and descartable.get('isActive') is False,
          'quedo %s' % str(descartable)[:120])

if SITIO:
    estado, tipo = supervisor.abrir_flujo('/supervisor/sites/%s/stream' % SITIO)
    check('el supervisor abre el flujo de novedades en vivo de su recinto',
          estado == 200 and 'text/event-stream' in tipo,
          'HTTP %s, tipo %s' % (estado, tipo))
else:
    omitido('el supervisor abre el flujo de novedades en vivo de su recinto', 'no hay recintos',
            POR_EL_DESPLIEGUE)

s, _ = guardia.pedir('GET', '/supervisor/live')
check('el GUARDIA no entra al tablero en vivo', s == 403, 'HTTP %s' % s)

s, _ = admin.pedir('GET', '/supervisor/sites')
check('el ADMIN tampoco: sus recintos no son "asignados"', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('14b. EL SUPERVISOR DA DE ALTA PUNTOS Y VINCULA ETIQUETAS NFC (#309)')
print('=' * 72)
# El permiso nuevo `checkpoints:manage` abre la puerta; el alcance por recinto lo
# decide `supervisor_sites`, y eso ningun mock lo ve. Se prueban las dos mitades
# con el mismo par de recintos que la seccion 14 ya dejo armado: el ASIGNADO
# (2xx) y el DESCARTABLE sin asignar (403).
PUNTOS_SUP = '/checkpoints/supervisor'
mio = next((r.get('id') for r in asignados), None)

if not mio:
    omitido(['el supervisor lista los puntos de un recinto suyo',
             'el supervisor crea un punto en un recinto suyo',
             'el supervisor vincula una etiqueta NFC al punto que creo',
             'el supervisor lista las etiquetas de ese punto',
             'el supervisor edita el punto que creo',
             'el supervisor retira la etiqueta que vinculo',
             'la etiqueta retirada deja de estar activa en el punto',
             'el supervisor da de baja el punto que creo'],
            'el supervisor no tiene ningun recinto asignado', POR_EL_DESPLIEGUE)
    punto_nuevo = None
else:
    s, puntos_mios = supervisor.pedir('GET', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, mio))
    check('el supervisor lista los puntos de un recinto suyo',
          s == 200 and isinstance(puntos_mios, list), 'HTTP %s %s' % (s, str(puntos_mios)[:120]))

    # Nombre unico por corrida: un punto es dato de operacion y la API no ofrece
    # borrarlo, asi que se crea, se comprueba y se deja DESACTIVADO al final —
    # igual que el recinto descartable de la seccion 14.
    nombre_punto = 'Punto e2e %s' % uuid.uuid4().hex[:8]
    uid_nfc = '04' + uuid.uuid4().hex[:6].upper()
    s, creado = supervisor.pedir('POST', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, mio), {
        'name': nombre_punto,
        'description': 'Creado por la prueba de humo; se deja desactivado',
        'suggestedOrder': 999,
    })
    punto_nuevo = cuerpo_dict(creado).get('id') if s in (200, 201) else None
    check('el supervisor crea un punto en un recinto suyo',
          s in (200, 201) and punto_nuevo, 'HTTP %s %s' % (s, str(creado)[:140]))

if punto_nuevo:
    try:
        # SIN `tech`: la ruta del supervisor no lo acepta a proposito (#309). Su
        # DTO solo lleva el uid y el servidor fija 'nfc', porque un QR con UID
        # elegido por el llamador se imprime y se pega en la garita.
        s, etiqueta = supervisor.pedir('POST', '%s/checkpoints/%s/tags' % (PUNTOS_SUP, punto_nuevo),
                                       {'uid': uid_nfc})
        tag_propia = cuerpo_dict(etiqueta).get('id') if s in (200, 201) else None
        check('el supervisor vincula una etiqueta NFC al punto que creo',
              s in (200, 201) and tag_propia,
              'HTTP %s %s' % (s, str(etiqueta)[:140]))

        s, sus_tags = supervisor.pedir('GET', '%s/checkpoints/%s/tags' % (PUNTOS_SUP, punto_nuevo))
        check('el supervisor lista las etiquetas de ese punto',
              s == 200 and any(t.get('uid', '').upper() == uid_nfc for t in
                               (sus_tags if isinstance(sus_tags, list) else [])),
              'HTTP %s %s' % (s, str(sus_tags)[:160]))

        s, _ = supervisor.pedir('PATCH', '%s/checkpoints/%s' % (PUNTOS_SUP, punto_nuevo),
                                {'name': nombre_punto + ' (editado)'})
        check('el supervisor edita el punto que creo', s == 200, 'HTTP %s' % s)

        # Los dos campos que gobiernan isPhotoRequired() no estan en su DTO, y
        # `forbidNonWhitelisted` los convierte en 400. Que el formulario no los
        # muestre NO es lo que los cierra: esto lo es.
        s, _ = supervisor.pedir('PATCH', '%s/checkpoints/%s' % (PUNTOS_SUP, punto_nuevo),
                                {'kind': 'normal'})
        check('  pero no puede degradar la criticidad: apagaria la foto obligatoria',
              s == 400, 'HTTP %s' % s)
        s, _ = supervisor.pedir('POST', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, mio),
                                {'name': 'Punto con foto forzada', 'requiresPhoto': False})
        check('  ni crear un punto apagando la exigencia de foto', s == 400, 'HTTP %s' % s)

        # El DELETE de etiqueta no se llamaba NUNCA contra la base: una etiqueta
        # que se despega de la pared y se reemplaza es la operacion mas comun de
        # este modulo, y estaba verificada solo con mocks.
        if tag_propia:
            s, _ = supervisor.pedir('DELETE', '%s/tags/%s' % (PUNTOS_SUP, tag_propia))
            check('el supervisor retira la etiqueta que vinculo', s in (200, 204),
                  'HTTP %s' % s)
            s, quedan = supervisor.pedir('GET', '%s/checkpoints/%s/tags' % (PUNTOS_SUP,
                                                                           punto_nuevo))
            activas = [t for t in (quedan if isinstance(quedan, list) else [])
                       if t.get('uid', '').upper() == uid_nfc and t.get('active')]
            check('  y la etiqueta retirada deja de estar activa en el punto',
                  s == 200 and not activas, 'HTTP %s %s' % (s, str(quedan)[:160]))
        else:
            omitido(['el supervisor retira la etiqueta que vinculo',
                     'la etiqueta retirada deja de estar activa en el punto'],
                    'la etiqueta no se llego a crear', POR_LA_PRUEBA)
    finally:
        s, _ = supervisor.pedir('PATCH', '%s/checkpoints/%s/active' % (PUNTOS_SUP, punto_nuevo),
                                {'isActive': False})
        check('el supervisor da de baja el punto que creo (y la prueba no deja basura activa)',
              s == 200, 'HTTP %s' % s)

# La otra mitad: el recinto que NO tiene asignado. El 403 lo pone
# supervisor_sites, no el rol — el rol ya paso el guard.
if not ajeno:
    omitido(['el supervisor no lista los puntos de un recinto ajeno',
             'ni crea un punto ahi',
             'ni importa una tanda por CSV ahi'],
            'no se pudo disponer de un recinto sin asignar', POR_LA_PRUEBA)
else:
    s, _ = supervisor.pedir('GET', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, ajeno))
    check('el supervisor no lista los puntos de un recinto ajeno', s == 403, 'HTTP %s' % s)
    s, _ = supervisor.pedir('POST', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, ajeno),
                            {'name': 'Punto que no deberia existir'})
    check('  ni crea un punto ahi', s == 403, 'HTTP %s' % s)
    s, _ = supervisor.pedir('POST', '%s/sites/%s/checkpoints/import' % (PUNTOS_SUP, ajeno),
                            {'checkpoints': [{'name': 'Fila que no deberia entrar'}]})
    check('  ni importa una tanda por CSV ahi', s == 403, 'HTTP %s' % s)

# LAS RUTAS POR ID, QUE SON EL CORAZON DEL ISSUE.
#
# Todo lo de arriba lleva el `siteId` en la URL, asi que el alcance se comprueba
# leyendo un parametro. En estas cinco NO: el recinto hay que deducirlo del punto
# o de la etiqueta, y ahi es donde un guard olvidado no se nota mirando la firma.
# Hasta aca esas rutas se probaban solo contra el recinto PROPIO —o sea, el 2xx—
# y el 403 quedaba verificado unicamente con mocks: exactamente el patron que ya
# metio dos bugs a staging con CI en verde (ver CLAUDE.md, "como verificar tu
# trabajo").
#
# Para probarlas hace falta un punto que exista en un recinto que el supervisor
# NO tenga asignado, y eso el supervisor no lo puede fabricar por definicion. Lo
# crea el ADMIN en el recinto descartable, con nombre fijo para reusarlo entre
# corridas, y queda desactivado al final.
ALCANCE_POR_ID = [
    'el supervisor no edita un punto de un recinto ajeno',
    'ni lo da de baja',
    'ni lista las etiquetas de ese punto',
    'ni le vincula una etiqueta NFC',
    'ni retira una etiqueta de ese punto',
    'y la etiqueta ajena sigue vinculada y activa despues del intento',
]
if not ajeno:
    omitido(ALCANCE_POR_ID, 'no se pudo disponer de un recinto sin asignar', POR_LA_PRUEBA)
else:
    s, puntos_ajenos = admin.pedir('GET', '/admin/sites/%s/checkpoints' % ajeno)
    lista_ajena = puntos_ajenos if isinstance(puntos_ajenos, list) else []
    punto_ajeno = next((p.get('id') for p in lista_ajena
                        if p.get('name') == PUNTO_DESCARTABLE), None)
    if punto_ajeno is None:
        s, punto_admin = admin.pedir('POST', '/admin/sites/%s/checkpoints' % ajeno, {
            'name': PUNTO_DESCARTABLE,
            'description': 'Creado por la prueba de humo para medir el alcance por recinto',
            'suggestedOrder': 999,
        })
        punto_ajeno = cuerpo_dict(punto_admin).get('id') if s in (200, 201) else None
        check('el ADMIN fabrica un punto en el recinto que el supervisor no tiene asignado',
              s in (200, 201) and punto_ajeno, 'HTTP %s %s' % (s, str(punto_admin)[:140]))
    else:
        check('el ADMIN fabrica un punto en el recinto que el supervisor no tiene asignado',
              True, 'reusa el de una corrida anterior')

    tag_ajena = None
    if punto_ajeno:
        s, tags_ajenas = admin.pedir('GET', '/admin/checkpoints/%s/tags' % punto_ajeno)
        tag_ajena = next((t.get('id') for t in (tags_ajenas if isinstance(tags_ajenas, list)
                                                else []) if t.get('active')), None)
        if tag_ajena is None:
            s, tag_admin = admin.pedir('POST', '/admin/checkpoints/%s/tags' % punto_ajeno,
                                       {'uid': UID_DESCARTABLE, 'tech': 'nfc'})
            tag_ajena = cuerpo_dict(tag_admin).get('id') if s in (200, 201) else None
            check('  y le pega una etiqueta NFC, que es lo que el supervisor no debe poder retirar',
                  s in (200, 201) and tag_ajena, 'HTTP %s %s' % (s, str(tag_admin)[:140]))
        else:
            check('  y le pega una etiqueta NFC, que es lo que el supervisor no debe poder retirar',
                  True, 'reusa la de una corrida anterior')

    if not punto_ajeno:
        omitido(ALCANCE_POR_ID,
                'el ADMIN no pudo fabricar el punto en el recinto sin asignar', POR_LA_PRUEBA)
    else:
        s, _ = supervisor.pedir('PATCH', '%s/checkpoints/%s' % (PUNTOS_SUP, punto_ajeno),
                                {'name': 'Renombrado por quien no supervisa este recinto'})
        check('el supervisor no edita un punto de un recinto ajeno', s == 403, 'HTTP %s' % s)
        s, _ = supervisor.pedir('PATCH', '%s/checkpoints/%s/active' % (PUNTOS_SUP, punto_ajeno),
                                {'isActive': False})
        check('  ni lo da de baja', s == 403, 'HTTP %s' % s)
        s, _ = supervisor.pedir('GET', '%s/checkpoints/%s/tags' % (PUNTOS_SUP, punto_ajeno))
        check('  ni lista las etiquetas de ese punto', s == 403, 'HTTP %s' % s)
        # Tambien sin `tech`: con el campo, el 400 de validacion llegaba ANTES que
        # el 403 y esta comprobacion dejaba de medir la autorizacion, que es lo suyo.
        s, _ = supervisor.pedir('POST', '%s/checkpoints/%s/tags' % (PUNTOS_SUP, punto_ajeno),
                                {'uid': '04' + uuid.uuid4().hex[:6].upper()})
        check('  ni le vincula una etiqueta NFC', s == 403, 'HTTP %s' % s)

        if tag_ajena:
            s, _ = supervisor.pedir('DELETE', '%s/tags/%s' % (PUNTOS_SUP, tag_ajena))
            check('  ni retira una etiqueta de ese punto', s == 403, 'HTTP %s' % s)
            # Que el 403 no sea un "no existe" disfrazado: la etiqueta tiene que
            # seguir viva. Un DELETE que borra y despues devuelve 403 pasaria la
            # comprobacion de arriba y habria perdido la etiqueta igual.
            s, sigue = admin.pedir('GET', '/admin/checkpoints/%s/tags' % punto_ajeno)
            check('  y la etiqueta ajena sigue vinculada y activa despues del intento',
                  s == 200 and any(t.get('id') == tag_ajena and t.get('active')
                                   for t in (sigue if isinstance(sigue, list) else [])),
                  'HTTP %s %s' % (s, str(sigue)[:160]))
        else:
            omitido(['ni retira una etiqueta de ese punto',
                     'y la etiqueta ajena sigue vinculada y activa despues del intento'],
                    'el ADMIN no pudo dejar una etiqueta en el punto descartable', POR_LA_PRUEBA)

        # El punto es del ADMIN y del recinto no operativo: queda desactivado,
        # igual que el recinto que lo contiene. La etiqueta se conserva a
        # proposito — se reusa en la proxima corrida y evita crear una por vez.
        admin.pedir('PATCH', '/admin/checkpoints/%s/active' % punto_ajeno, {'isActive': False})

# El permiso es del SUPERVISOR y de nadie mas: el ADMIN entra por /admin/... y el
# GUARDIA no entra. Y el supervisor sigue SIN poder asignarse recintos, que es la
# puerta que convertiria este permiso en acceso a la empresa entera.
if mio:
    s, _ = admin.pedir('GET', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, mio))
    check('el ADMIN no entra por la puerta del supervisor: la suya es /admin/...', s == 403,
          'HTTP %s' % s)
    s, _ = guardia.pedir('GET', '%s/sites/%s/checkpoints' % (PUNTOS_SUP, mio))
    check('el GUARDIA tampoco entra a administrar puntos', s == 403, 'HTTP %s' % s)
if ajeno:
    s, _ = supervisor.pedir('PATCH', '/admin/users/%s/sites/%s' % (uuid.uuid4(), ajeno),
                            {'assigned': True})
    check('el supervisor NO puede asignarse un recinto a si mismo', s == 403, 'HTTP %s' % s)

print()
print('=' * 72)
print('15a. CIERRE POR ROL — el GUARDIA no entra a nada de administracion')
print('=' * 72)
# QUE PRUEBA ESTA LISTA Y QUE NO.
#
# La unica cuenta que el seed le da a demo-pacifico es un GUARDIA
# (development.ts), y el GUARDIA solo tiene account:sessions:manage,
# patrols:execute e incidents:create (permissions.ts). Todos los endpoints de
# abajo exigen tenant:rules:manage, tenant:audit:read, reports:read o
# patrols:monitor, y el AuthGuard corre ANTES del interceptor de tenant: el 403
# lo pone el ROL y el tenant no llega a importar. El mismo 403 saldria con
# guardia@demo-andina, o sea con un usuario de la MISMA empresa.
#
# Por eso esta lista NO prueba aislamiento entre empresas, y decir que si lo
# hacia era el error. Prueba otra cosa que igual hay que probar: que ninguno de
# los endpoints nuevos se abrio por accidente al rol de terreno. El aislamiento
# de verdad esta en 15b, con endpoints que el GUARDIA SI puede pedir.
comentario = {'comment': 'Intento de la prueba de humo desde otra empresa'}
puertas = [
    ('los modulos contratados de una empresa', 'GET', '/features/admin', None),
    ('cambiar los modulos de una empresa', 'PUT', '/features/admin', {}),
    ('el historial de avisos de una empresa', 'GET', '/consent/policies', None),
    ('publicar un aviso', 'POST', '/consent/policies',
     {'version': 'e2e-fuga-%s' % uuid.uuid4().hex[:8], 'body': texto,
      'privacyPolicyUrl': 'https://example.com/privacidad-sentrycore'}),
    ('el registro de consentimiento de una empresa', 'GET', '/consent/roster', None),
    ('el informe de rastreo fuera de turno', 'GET',
     '/consent/off-shift-audit?from=2026-01-01&to=2026-12-31', None),
    ('la exportacion a Excel', 'GET', '/reports/excel', None),
    ('el registro de correo', 'GET', '/notif/envios', None),
    ('el resumen de caidas', 'GET', '/observability/crash-reports/summary', None),
    ('el tablero en vivo', 'GET', '/supervisor/live', None),
    ('los recintos asignados', 'GET', '/supervisor/sites', None),
]
if SITIO:
    puertas += [
        ('la configuracion de un recinto', 'GET', '/rules/admin/sites/%s' % SITIO, None),
        ('cambiar la configuracion de un recinto', 'PUT',
         '/rules/admin/sites/%s' % SITIO, {}),
        ('la bandeja de alertas de un recinto', 'GET',
         '/supervisor/sites/%s/alerts' % SITIO, None),
    ]
else:
    omitido(['el GUARDIA no entra a la configuracion de un recinto',
             'el GUARDIA no cambia la configuracion de un recinto',
             'el GUARDIA no entra a la bandeja de alertas de un recinto'],
            'no hay recintos', POR_EL_DESPLIEGUE)
if PUNTO:
    puertas += [
        ('la configuracion de un punto', 'GET', '/rules/admin/checkpoints/%s' % PUNTO, None),
        ('cambiar la configuracion de un punto', 'PUT',
         '/rules/admin/checkpoints/%s' % PUNTO, {}),
    ]
else:
    omitido(['el GUARDIA no entra a la configuracion de un punto de control',
             'el GUARDIA no cambia la configuracion de un punto de control'],
            'no hay puntos de control', POR_EL_DESPLIEGUE)
if alerta_id:
    puertas.append(('atender una alerta', 'POST',
                    '/supervisor/alerts/%s/attend' % alerta_id, comentario))
else:
    omitido('el GUARDIA no entra a atender una alerta',
            'no hay ninguna alerta contra la cual probar', POR_EL_DESPLIEGUE)
if patrols:
    puertas.append(('los correos de una ronda', 'GET',
                    '/notif/rondas/%s/envios' % patrols[0]['id'], None))
else:
    omitido('el GUARDIA no entra a los correos de una ronda', 'no hay rondas', POR_EL_DESPLIEGUE)

for descripcion, metodo, ruta, cuerpo in puertas:
    s, d = ses_b.pedir(metodo, ruta, cuerpo)
    check('el GUARDIA no entra a %s' % descripcion, s in (403, 404),
          'HTTP %s — si es 2xx el endpoint se abrio al rol de terreno: %s' % (s, str(d)[:100]))

if SITIO:
    estado, _ = ses_b.abrir_flujo('/supervisor/sites/%s/stream' % SITIO)
    check('el GUARDIA no se engancha al flujo en vivo de un recinto',
          estado in (403, 404), 'HTTP %s — si es 200 se abrio al rol de terreno' % estado)
else:
    omitido('el GUARDIA no se engancha al flujo en vivo de un recinto', 'no hay recintos',
            POR_EL_DESPLIEGUE)

print()
print('=' * 72)
print('15b. AISLAMIENTO ENTRE EMPRESAS — la de al lado pidiendo lo nuestro')
print('=' * 72)
# ACA SI SE PRUEBA AISLAMIENTO POR EMPRESA.
#
# La receta: la sesion de la OTRA empresa demo (guardia@demo-pacifico) pidiendo
# un recurso CONCRETO de la primera (demo-andina), y solo por endpoints que el
# rol GUARDIA tiene permitidos — si el rol ya deniega, el 403 no dice nada del
# tenant. Un identificador inventado tampoco sirve: el 404 de "no existe" y el
# 404 de "no es tuyo" se ven iguales. Los identificadores de abajo son de
# recursos que existen de verdad y son de demo-andina.
if not event_id:
    omitido(['la otra empresa no lee el acuse de una novedad ajena',
             'la otra empresa no cuelga una foto en una novedad ajena'],
            'no se pudo registrar la novedad de demo-andina', POR_LA_PRUEBA)
else:
    s, d = ses_b.pedir('GET', '/guard/events/%s/acuse' % event_id)
    check('la otra empresa no lee el acuse de una novedad ajena', s == 404,
          'HTTP %s — si es 200 hay FUGA: %s' % (s, str(d)[:100]))

    s, d = subir_foto(ses_b, '/evidence/events/%s/photos' % event_id, png_minimo(11))
    check('la otra empresa no cuelga una foto en una novedad ajena', s == 404,
          'HTTP %s — si es 2xx hay FUGA: %s' % (s, str(d)[:100]))

if not patrols:
    omitido('la otra empresa no lee el checklist de una ronda ajena',
            'no hay rondas de demo-andina en el resumen', POR_EL_DESPLIEGUE)
else:
    s, d = ses_b.pedir('GET', '/checklists/patrols/%s/template' % patrols[0]['id'])
    check('la otra empresa no lee el checklist de una ronda ajena', s == 404,
          'HTTP %s — si es 200 hay FUGA: %s' % (s, str(d)[:100]))

# Las otras dos comprobaciones de aislamiento por empresa —la cascada del
# recinto y la del punto de demo-andina vistas por demo-pacifico— viven en la
# seccion 8, no aca: son las unicas que se pueden hacer mientras esos overrides
# estan puestos. Preguntadas aca, despues de restaurar, no habria nada que ver y
# el verde no significaria nada.

# Los endpoints que SI le responden a cualquiera dentro de su empresa no pueden
# dar 403: lo que hay que comprobar ahi es que contesten con SUS datos.
s, sus_modulos = ses_b.pedir('GET', '/features')
check('a la otra empresa le contestan sus propios modulos, no los ajenos',
      s == 200 and isinstance(cuerpo_dict(sus_modulos).get('enabled'), dict),
      'HTTP %s %s' % (s, str(sus_modulos)[:100]))

s, su_aviso = ses_b.pedir('GET', '/consent/policy')
d = cuerpo_dict(su_aviso)
check('el aviso que ve la otra empresa no es el que acabamos de publicar aca',
      s == 200 and (d.get('policy') or {}).get('version') != version,
      'HTTP %s, ve la version %s' % (s, (d.get('policy') or {}).get('version')))

print()
print('=' * 72)
print('16. EL PANEL SE SIRVE CON LAS SECCIONES NUEVAS')
print('=' * 72)
try:
    with urllib.request.urlopen(BASE + '/', timeout=45) as r:
        html = r.read().decode('utf-8', 'replace')
    check('la portada carga', r.status == 200 and '<html' in html.lower(), 'HTTP %s' % r.status)
except Exception as e:
    check('la portada carga', False, type(e).__name__)

print()
print('=' * 72)
cobertura_perdida = [(n, m) for n, m, cuenta in omitidos if cuenta]
toleradas = [(n, m) for n, m, cuenta in omitidos if not cuenta]
print('RESULTADO: %d comprobaciones OK, %d fallas, %d sin poder probar '
      '(%d de ellas cuentan como falla)'
      % (ok, len(fallos), len(omitidos), len(cobertura_perdida)))
if fallos:
    print()
    for n, d in fallos:
        print('  FALLA  %s  %s' % (n, d))
if cobertura_perdida:
    print()
    print('  Esto NO se probo, y no porque el despliegue no diera la condicion: la prueba')
    print('  perdio cobertura. Por eso la corrida sale en rojo aunque no haya fallas.')
    for n, m in cobertura_perdida:
        print('  SIN PROBAR (cuenta)  %s  (%s)' % (n, m))
if toleradas:
    print()
    for n, m in toleradas:
        print('  SIN PROBAR  %s  (%s)' % (n, m))
    print()
    print('  Las %d de arriba no cuentan: ese despliegue no da la condicion. Contra staging'
          % len(toleradas))
    print('  sembrado, donde SI se pueden probar todas, corre con SENTRYCORE_HUMO_ESTRICTO=1.')
print('=' * 72)

# Una comprobacion que no se ejecuto no es una comprobacion que paso.
sys.exit(1 if fallos or cobertura_perdida else 0)
