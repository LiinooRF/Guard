# -*- coding: utf-8 -*-
"""El loop del producto de punta a punta, contra staging desplegado.

No comprueba que un endpoint responda 200: comprueba que un guardia pueda hacer
su trabajo. Esa es la cadena que el CHECK roto de la URL tenia cortada.

Deja el aviso publicado (no hay forma de despublicarlo) y la ronda como la
encuentre; por eso publica con una version de nombre unico.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding='utf-8')

BASE = os.environ.get('VOXIA_BASE', '').strip().rstrip('/')
CLAVE = os.environ.get('VOXIA_DEMO_PASSWORD', '')
if not BASE or not CLAVE:
    raise SystemExit(
        'define VOXIA_BASE y VOXIA_DEMO_PASSWORD por un canal seguro antes de ejecutar'
    )
API = BASE + '/api'
UA_APP = 'VoxIAAndroid/1.0 (puente 1.3)'
UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

fallas = []


def check(nombre, condicion, detalle=''):
    print('  %-4s %s%s' % ('OK' if condicion else 'FALLA', nombre,
                           '' if condicion else '  <- %s' % detalle))
    if not condicion:
        fallas.append(nombre)


def pedir(metodo, url, carga=None, galletas='', agente=UA_PC):
    datos = json.dumps(carga).encode() if carga is not None else None
    peticion = urllib.request.Request(url, data=datos, method=metodo)
    peticion.add_header('Origin', BASE)
    peticion.add_header('X-Voxia-Request', 'web')
    peticion.add_header('User-Agent', agente)
    if datos is not None:
        peticion.add_header('Content-Type', 'application/json')
    if galletas:
        peticion.add_header('Cookie', galletas)
    try:
        with urllib.request.urlopen(peticion, timeout=90) as respuesta:
            return respuesta.status, respuesta.read().decode('utf-8', 'replace'), respuesta.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode('utf-8', 'replace'), error.headers


def entrar(correo, agente=UA_PC):
    estado, cuerpo, cabeceras = pedir('POST', API + '/auth/login',
                                      {'identity': correo, 'password': CLAVE}, agente=agente)
    if estado != 200:
        raise SystemExit('no pude entrar como %s: HTTP %s %s' % (correo, estado, cuerpo[:200]))
    return '; '.join(c.split(';')[0] for c in cabeceras.get_all('Set-Cookie') or [])


def cuerpo_json(texto):
    try:
        return json.loads(texto)
    except Exception:
        return {}


def cuerpo_json_lista(texto):
    """Una lista, venga suelta o envuelta. Nunca None: el llamador itera."""
    dato = cuerpo_json(texto)
    if isinstance(dato, list):
        return dato
    if isinstance(dato, dict):
        for clave in ('items', 'sites', 'routes', 'guards', 'data'):
            if isinstance(dato.get(clave), list):
                return dato[clave]
    return []


print('=' * 72)
print('EL LOOP DEL PRODUCTO: publicar aviso -> aceptar -> iniciar ronda -> escanear')
print('=' * 72)

admin = entrar('admin@demo-andina.test')
guardia = entrar('guardia@demo-andina.test', UA_APP)
# El SUPERVISOR entra para poder sembrar la ronda si no hay ninguna. Se hace con
# el rol que de verdad la crea —`shifts:manage`— y no por la puerta de atras:
# si el permiso se rompiera, esta prueba tiene que enterarse.
supervisor = entrar('supervisor@demo-andina.test')

# ---------------------------------------------------------------- 1. el aviso
version = 'e2e-%s' % uuid.uuid4().hex[:8]
AVISO = (
    'Aviso de geolocalizacion. Durante tu turno la aplicacion registra la ubicacion del '
    'dispositivo con el unico fin de dejar constancia de la ronda realizada. Fuera del turno no '
    'se registra ubicacion alguna. Puedes revocar tu consentimiento en cualquier momento.')
estado, cuerpo, _ = pedir('POST', API + '/consent/policies', {
    'version': version, 'body': AVISO,
    'privacyPolicyUrl': 'https://voxtilabs.cl/privacidad'}, admin)
check('el admin publica el aviso de geolocalizacion', estado == 201 or estado == 200,
      'HTTP %s %s' % (estado, cuerpo[:200]))
politica = cuerpo_json(cuerpo)

# La URL larga que el CHECK roto nunca pudo validar: ahora tiene que ENTRAR.
larga = 'https://voxtilabs.cl/privacidad/' + ('a' * 300)
estado, cuerpo, _ = pedir('POST', API + '/consent/policies', {
    'version': version + '-larga', 'body': AVISO, 'privacyPolicyUrl': larga}, admin)
check('  una URL de 300+ caracteres se acepta (el limite real son 508)',
      estado in (200, 201), 'HTTP %s %s' % (estado, cuerpo[:160]))

estado, cuerpo, _ = pedir('POST', API + '/consent/policies', {
    'version': version + '-mala', 'body': AVISO, 'privacyPolicyUrl': 'http://sin-tls.test/p'}, admin)
check('  y una URL sin https se sigue rechazando', estado in (400, 409, 422),
      'HTTP %s' % estado)

# ------------------------------------------------------------ 2. el guardia
estado, cuerpo, _ = pedir('GET', API + '/consent/policy', None, guardia, UA_APP)
vista = cuerpo_json(cuerpo)
check('el guardia ve el aviso vigente', estado == 200 and vista.get('hasPolicy') is True,
      'HTTP %s %s' % (estado, str(vista)[:160]))
check('  y se le pide aceptarlo', vista.get('actionRequired') in ('aceptar', 'aceptar_aviso',
                                                                 'reaceptar'),
      str(vista.get('actionRequired')))

vigente = (vista.get('policy') or {}).get('version')
estado, cuerpo, _ = pedir('POST', API + '/geo/consent', {
    'policyVersion': vigente,
    'deviceInfo': 'prueba-e2e / android'}, guardia, UA_APP)
check('el guardia acepta el rastreo', estado in (200, 201),
      'HTTP %s %s' % (estado, cuerpo[:200]))

# El telefono informa como quedo el permiso del sistema operativo. No es un
# tramite del script: la puerta de GPS lo exige aparte del consentimiento
# escrito, porque una cosa es aceptar el aviso y otra que Android deje leer la
# ubicacion de verdad.
estado, cuerpo, _ = pedir('POST', API + '/geo/permission', {
    'status': 'concedido', 'deviceInfo': 'prueba-e2e / android'}, guardia, UA_APP)
check('el telefono confirma el permiso de ubicacion del sistema', estado in (200, 201),
      'HTTP %s %s' % (estado, cuerpo[:200]))

# -------------------------------------------------------------- 3. la ronda
#
# La ronda se SIEMBRA si no hay ninguna, y esto no es comodidad: sin esto la
# prueba solo pasaba porque staging tenia una ronda abierta que nadie cerraba
# nunca. Desde que existe el barrido de rondas vencidas (#270) eso ya no ocurre
# —el recinto demo tiene `maxPatrolDurationMin` en 30— asi que la ronda que deja
# una corrida vence antes de la siguiente y la prueba fallaba con cuatro rojos
# que no eran del producto.
#
# Un guion que depende de un estado que otro dejo no prueba lo que dice probar:
# prueba que alguien paso por ahi antes. Se siembra solo cuando hace falta, para
# no acumular una ronda por corrida.
def sembrar_ronda():
    """Crea una ronda para el guardia demo. Devuelve el motivo si no pudo."""
    estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites', None, supervisor)
    sitios = cuerpo_json_lista(cuerpo)
    if not sitios:
        return 'el supervisor no tiene recintos asignados (HTTP %s)' % estado

    for sitio in sitios:
        estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites/%s/routes' % sitio['id'],
                                  None, supervisor)
        rutas = [r for r in cuerpo_json_lista(cuerpo) if r.get('isActive') is not False]
        estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites/%s/guards' % sitio['id'],
                                  None, supervisor)
        # El endpoint entrega `{id, name}` y NO el correo — a proposito: es una
        # lista para elegir en pantalla, no un directorio. Asi que el guardia se
        # elige por nombre, y si el recinto tiene uno solo, ese es.
        guardias = cuerpo_json_lista(cuerpo)
        elegido = next((g for g in guardias if 'demo' in (g.get('name') or '').lower()), None)
        if not elegido and len(guardias) == 1:
            elegido = guardias[0]
        if not rutas or not elegido:
            continue

        # La ventana arranca cinco minutos ANTES: una ronda que empieza en el
        # futuro exacto es un borde que no interesa probar aca, y arrancarla
        # antes de su hora es justo lo que dejaba rondas raras en staging.
        ahora = datetime.now(timezone.utc)
        estado, cuerpo, _ = pedir(
            'POST', API + '/supervisor/routes/%s/patrols' % rutas[0]['id'],
            {'guardId': elegido['id'],
             'scheduledStartAt': (ahora - timedelta(minutes=5)).isoformat(),
             'scheduledEndAt': (ahora + timedelta(hours=4)).isoformat()},
            supervisor)
        if estado in (200, 201):
            return None
        return 'POST /supervisor/routes/%s/patrols -> HTTP %s %s' % (
            rutas[0]['id'], estado, cuerpo[:160])
    return 'ningun recinto del supervisor tiene ruta activa y guardia demo'


estado, cuerpo, _ = pedir('GET', API + '/guard/home', None, guardia, UA_APP)
casa = cuerpo_json(cuerpo)
ronda = casa.get('patrol') or {}
if not ronda:
    motivo = sembrar_ronda()
    if motivo:
        check('el e2e puede sembrar su ronda', False, motivo)
    else:
        print('  (no habia ronda abierta; el e2e sembro una)')
        estado, cuerpo, _ = pedir('GET', API + '/guard/home', None, guardia, UA_APP)
        casa = cuerpo_json(cuerpo)
        ronda = casa.get('patrol') or {}

check('el guardia ve su ronda', estado == 200 and bool(ronda), 'HTTP %s' % estado)
check('  con la zona horaria del recinto', bool(ronda.get('timezone')), str(ronda.get('timezone')))

if ronda.get('status') == 'pendiente':
    estado, cuerpo, _ = pedir('POST', API + '/guard/patrols/%s/start' % ronda['id'], {},
                              guardia, UA_APP)
    check('EL GUARDIA INICIA LA RONDA', estado in (200, 201),
          'HTTP %s %s' % (estado, cuerpo[:220]))
else:
    check('EL GUARDIA INICIA LA RONDA', True, 'ya estaba en curso')

estado, cuerpo, _ = pedir('GET', API + '/guard/home', None, guardia, UA_APP)
ronda2 = (cuerpo_json(cuerpo).get('patrol') or {})
check('  y la ronda queda en curso', ronda2.get('status') in ('en_curso', 'completada'),
      str(ronda2.get('status')))

"""
El escaneo se FIRMA como lo hace la app.

No es opcional: en cuanto un guardia registra la llave de su telefono real
(paso el 8 de agosto, probando en un moto g35), el servidor rechaza con 403
cualquier escaneo suyo sin firmar — que es exactamente el antifraude de la
firma de dispositivo haciendo su trabajo contra credenciales robadas. Un e2e
que escanea sin firmar prueba un producto que ya no existe.

El algoritmo replica device-signature.service.ts: HMAC-SHA256 de
JSON.stringify([v1, clientScanId, deviceId, uid, method, scannedAt, lat, lng,
accuracyM]) con la llave de 32 bytes registrada. json.dumps con separadores
(',', ':') produce el mismo texto que JSON.stringify.
"""
DISPOSITIVO_E2E = str(uuid.uuid4())
LLAVE_E2E = os.urandom(32)


def firmar_escaneo(payload):
    contenido = json.dumps([
        'v1', payload['clientScanId'], payload['deviceId'], payload['uid'].strip(),
        payload['method'], payload.get('scannedAt'), payload.get('latitude'),
        payload.get('longitude'), payload.get('accuracyM'),
    ], separators=(',', ':'))
    return hmac.new(LLAVE_E2E, contenido.encode('utf-8'), hashlib.sha256).hexdigest()


estado, cuerpo, _ = pedir('POST', API + '/guard/device-signing-key', {
    'deviceId': DISPOSITIVO_E2E,
    'key': base64.b64encode(LLAVE_E2E).decode(),
}, guardia, UA_APP)
check('el e2e registra su propia llave de dispositivo', estado in (200, 201),
      'HTTP %s %s' % (estado, cuerpo[:160]))

puntos = ronda2.get('checkpoints') or []
primero = next((p for p in puntos if (p.get('tagUids') or [])), None)
if primero:
    escaneo = {
        'uid': primero['tagUids'][0], 'method': 'nfc',
        'clientScanId': str(uuid.uuid4()),
        'deviceId': DISPOSITIVO_E2E,
        'latitude': -33.45, 'longitude': -70.66}
    escaneo['signature'] = firmar_escaneo(escaneo)
    estado, cuerpo, _ = pedir('POST', API + '/guard/patrols/%s/scans' % ronda2['id'],
                              escaneo, guardia, UA_APP)
    resultado = cuerpo_json(cuerpo)
    check('el guardia escanea un punto (firmado)', estado in (200, 201),
          'HTTP %s %s' % (estado, cuerpo[:220]))
    check('  y el avance se contabiliza',
          isinstance(resultado.get('progress'), dict), str(resultado.get('progress'))[:120])
else:
    check('el guardia escanea un punto', False, 'ningun punto de la ronda tiene etiqueta')

print('=' * 72)
print('RESULTADO: %d fallas' % len(fallas))
for f in fallas:
    print('  FALLA %s' % f)
print('=' * 72)
raise SystemExit(1 if fallas else 0)
