# -*- coding: utf-8 -*-
"""
Prueba end-to-end contra un despliegue REAL. No mockea nada.

    python scripts/humo-e2e.py                       # contra staging
    VOXIA_BASE=https://otro.dominio python scripts/humo-e2e.py

Variables: VOXIA_BASE (por defecto staging) y VOXIA_DEMO_PASSWORD (la misma
DEMO_PASSWORD con que se sembraron las cuentas demo).

POR QUE EXISTE: dos bugs llegaron a produccion con CI en verde y 729 tests
pasando —un SELECT de una columna que no existe y un volumen que el proceso no
podia escribir—. Ninguno de los dos es detectable con mocks: el primero pasaba
porque el mock devolvia una columna inventada, y el segundo solo aparece con el
contenedor y su volumen de verdad. Esta prueba habla con la API desplegada.

Necesita las cuentas demo (RUN_DEMO_SEED=true). No correr contra produccion con
datos de clientes: escribe novedades y sube fotos de prueba.
"""
import os
import sys, json, http.cookiejar, urllib.request, urllib.error, uuid, io

sys.stdout.reconfigure(encoding='utf-8')

BASE = os.environ.get('VOXIA_BASE', 'https://test-sentrycore.voxtilabs.cl')
API = BASE + '/api'
CLAVE = os.environ.get('VOXIA_DEMO_PASSWORD', 'DemoGuardia2026!')

ok = 0
fallos = []


def check(nombre, condicion, detalle=''):
    global ok
    if condicion:
        ok += 1
        print('  OK   %s' % nombre)
    else:
        fallos.append((nombre, detalle))
        print('  FALLA %s  %s' % (nombre, detalle))


class Sesion:
    def __init__(self, etiqueta):
        self.etiqueta = etiqueta
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

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
                if crudo:
                    return r.status, b
                return r.status, (json.loads(b.decode()) if b.strip() else None)
        except urllib.error.HTTPError as e:
            b = e.read()
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

s, d = Sesion('malo').login('admin@demo-andina.test.no-existe')
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
for nombre in ['compliance-by-site', 'evolution', 'missed-checkpoints', 'guard-ranking']:
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
lista_sitios = sitios if isinstance(sitios, list) else (sitios or {}).get('sites', [])
check('el admin lista sus recintos', s == 200 and len(lista_sitios) > 0,
      'HTTP %s, %d' % (s, len(lista_sitios)))

if lista_sitios:
    site_ajeno = lista_sitios[0].get('id')
    s, _ = ses_b.pedir('GET', '/supervisor/sites/%s/events' % site_ajeno)
    check('un usuario de OTRA empresa no lee un recinto ajeno', s in (403, 404),
          'HTTP %s — si es 200 hay FUGA' % s)

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
    lim = '----voxiae2e%s' % uuid.uuid4().hex
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


foto_id = None
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

if foto_id:
    s, enlace = admin.pedir('GET', '/evidence/photos/%s/link' % foto_id)
    check('el admin obtiene el enlace firmado', s == 200 and 'url' in (enlace or {}),
          'HTTP %s %s' % (s, str(enlace)[:100]))
    url = (enlace or {}).get('url', '')
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
    print('  (sin rondas en el resumen: no se pudo probar el PDF de ronda)')

print()
print('=' * 72)
print('8. EL PANEL SE SIRVE CON LAS SECCIONES NUEVAS')
print('=' * 72)
try:
    with urllib.request.urlopen(BASE + '/', timeout=45) as r:
        html = r.read().decode('utf-8', 'replace')
    check('la portada carga', r.status == 200 and '<html' in html.lower(), 'HTTP %s' % r.status)
except Exception as e:
    check('la portada carga', False, type(e).__name__)

print()
print('=' * 72)
print('RESULTADO: %d comprobaciones OK, %d fallas' % (ok, len(fallos)))
if fallos:
    print()
    for n, d in fallos:
        print('  FALLA  %s  %s' % (n, d))
print('=' * 72)

sys.exit(1 if fallos else 0)
