# -*- coding: utf-8 -*-
"""E2E: una ronda pendiente sale con la ruta VIGENTE, no con la de cuando nacio.

EL CASO QUE ESTO IMPIDE QUE VUELVA
-------------------------------------------------------------------------------
En Janssen el supervisor agrego un punto a una ruta y las rondas ya generadas
siguieron con la lista vieja. El guardia escaneaba la etiqueta del punto nuevo y
el servidor contestaba "El punto escaneado no pertenece a esta ronda" (409). No
habia forma de arreglarlo desde el panel: hubo que editar la base a mano.

Se prueba contra el DESPLIEGUE y no con dobles porque lo que fallaba era la
combinacion de tres piezas —editor de rutas, generador de rondas e inicio de
ronda— y cada una por separado estaba bien.

QUE NO se prueba aca: que una ronda EN CURSO no cambie. Eso vive en las pruebas
unitarias, porque exige un estado que este guion no deberia forzar en un
despliegue compartido.
"""
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = os.environ.get('SENTRYCORE_BASE', '').strip().rstrip('/')
CLAVE = os.environ.get('SENTRYCORE_DEMO_PASSWORD', '')
if not BASE or not CLAVE:
    raise SystemExit(
        'Faltan SENTRYCORE_BASE y/o SENTRYCORE_DEMO_PASSWORD. La clave demo no vive\n'
        'en el repositorio (#295): pasala por entorno o desde el gestor de secretos.'
    )
API = BASE + '/api'
UA_APP = 'SentryCoreAndroid/1.0 (puente 1.3)'
UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

fallas = []


def check(nombre, condicion, detalle=''):
    print('  %-5s %s%s' % ('OK' if condicion else 'FALLA', nombre,
                           '' if condicion else '  <- %s' % detalle))
    if not condicion:
        fallas.append(nombre)


def pedir(metodo, url, carga=None, galletas='', agente=UA_PC):
    datos = json.dumps(carga).encode() if carga is not None else None
    p = urllib.request.Request(url, data=datos, method=metodo)
    p.add_header('Origin', BASE)
    p.add_header('X-SentryCore-Request', 'web')
    p.add_header('User-Agent', agente)
    if datos is not None:
        p.add_header('Content-Type', 'application/json')
    if galletas:
        p.add_header('Cookie', galletas)
    try:
        with urllib.request.urlopen(p, timeout=90) as r:
            return r.status, r.read().decode('utf-8', 'replace'), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), e.headers


def entrar(correo, agente=UA_PC):
    estado, cuerpo, cab = pedir('POST', API + '/auth/login',
                                {'identity': correo, 'password': CLAVE}, agente=agente)
    if estado != 200:
        raise SystemExit('no pude entrar como %s: HTTP %s %s' % (correo, estado, cuerpo[:200]))
    return '; '.join(c.split(';')[0] for c in cab.get_all('Set-Cookie') or [])


def json_de(texto, porDefecto=None):
    try:
        return json.loads(texto)
    except Exception:
        return porDefecto if porDefecto is not None else {}


print('=' * 72)
print('E2E: la ronda toma la ruta vigente al iniciar')
print('=' * 72)

supervisor = entrar('supervisor@demo-andina.test')
guardia = entrar('guardia@demo-andina.test', agente=UA_APP)

# ---------------------------------------------------------------- preparacion
estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites', None, supervisor)
sitios = json_de(cuerpo, [])
if not sitios:
    check('el supervisor tiene un recinto', False, 'HTTP %s' % estado)
    raise SystemExit(1)
sitio = sitios[0]

# Los puntos viven en su propio controlador (`checkpoints/supervisor`), no bajo
# `/supervisor`: son dos modulos distintos con permisos distintos.
estado, cuerpo, _ = pedir(
    'GET', API + '/checkpoints/supervisor/sites/%s/checkpoints' % sitio['id'], None, supervisor)
crudos = json_de(cuerpo, [])
if isinstance(crudos, dict):
    crudos = crudos.get('items') or crudos.get('checkpoints') or []
puntos = [p for p in crudos if isinstance(p, dict) and p.get('isActive') is not False]
estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites/%s/guards' % sitio['id'],
                          None, supervisor)
guardias = json_de(cuerpo, [])
elegido = next((g for g in guardias if 'demo' in (g.get('name') or '').lower()), None)
if not elegido and guardias:
    elegido = guardias[0]

if not elegido:
    check('el recinto tiene un guardia para la prueba', False, 'ninguno')
    raise SystemExit(1)

marca = datetime.now(timezone.utc).strftime('%H%M%S')

# La prueba CREA su propio punto en vez de tomar el tercero que haya: una
# version anterior usaba `puntos[2]` y, como corridas previas dejaban puntos en
# el recinto, ese indice caia sobre un punto ORIGINAL — la comprobacion pasaba
# por casualidad, midiendo lo que no era. El punto agregado tiene que ser uno
# que esta prueba conozca por nombre.
base = [p for p in puntos if isinstance(p, dict) and p.get('id')][:2]
if len(base) < 2:
    check('el recinto tiene al menos 2 puntos de base', False, '%d' % len(base))
    raise SystemExit(1)

NOMBRE_EXTRA = 'e2e punto agregado %s' % marca
estado, cuerpo, _ = pedir(
    'POST', API + '/checkpoints/supervisor/sites/%s/checkpoints' % sitio['id'],
    {'name': NOMBRE_EXTRA, 'kind': 'normal'}, supervisor)
extra = json_de(cuerpo)
check('se crea el punto que se agregara despues', estado in (200, 201) and extra.get('id'),
      'HTTP %s %s' % (estado, cuerpo[:200]))
if not extra.get('id'):
    raise SystemExit(1)

# Ruta propia de la prueba: no se toca ninguna que este en uso.
estado, cuerpo, _ = pedir(
    'POST', API + '/supervisor/sites/%s/routes' % sitio['id'],
    {'name': 'e2e ruta vigente %s' % marca, 'estimatedDurationMin': 30, 'toleranceMin': 15,
     'checkpoints': [{'checkpointId': p['id']} for p in base]},
    supervisor)
ruta = json_de(cuerpo)
check('se crea una ruta con 2 puntos', estado in (200, 201) and ruta.get('id'),
      'HTTP %s %s' % (estado, cuerpo[:200]))
if not ruta.get('id'):
    raise SystemExit(1)

# --------------------------------------------------- ronda ANTES de editar
ahora = datetime.now(timezone.utc)
estado, cuerpo, _ = pedir(
    'POST', API + '/supervisor/routes/%s/patrols' % ruta['id'],
    {'guardId': elegido['id'],
     'scheduledStartAt': (ahora - timedelta(minutes=5)).isoformat(),
     'scheduledEndAt': (ahora + timedelta(hours=4)).isoformat()},
    supervisor)
ronda = json_de(cuerpo)
check('se genera la ronda con la ruta de 2 puntos', estado in (200, 201) and ronda.get('id'),
      'HTTP %s %s' % (estado, cuerpo[:200]))
if not ronda.get('id'):
    raise SystemExit(1)

# --------------------------------- el supervisor agrega un punto DESPUES
estado, cuerpo, _ = pedir(
    'PUT', API + '/supervisor/routes/%s' % ruta['id'],
    {'name': 'e2e ruta vigente %s' % marca, 'estimatedDurationMin': 30, 'toleranceMin': 15,
     'checkpoints': [{'checkpointId': p['id']} for p in base + [extra]]},
    supervisor)
check('el supervisor agrega un 3er punto a la ruta', estado in (200, 204),
      'HTTP %s %s' % (estado, cuerpo[:200]))

# ------------------------------------------------- el guardia inicia la ronda
estado, cuerpo, _ = pedir('POST', API + '/guard/patrols/%s/start' % ronda['id'],
                          {}, guardia, agente=UA_APP)
check('el guardia inicia la ronda', estado in (200, 201),
      'HTTP %s %s' % (estado, cuerpo[:200]))

# ------------------------------------------------------------- la comprobacion
estado, cuerpo, _ = pedir('GET', API + '/guard/home', None, guardia, agente=UA_APP)
home = json_de(cuerpo)
patrulla = (home or {}).get('patrol') or {}
esperados = patrulla.get('checkpoints') or patrulla.get('expectedCheckpoints') or []
nombres = {(c.get('name') or c.get('checkpointName') or '') for c in esperados} if esperados else set()

check('la ronda iniciada incluye los 3 puntos, no los 2 con que nacio',
      len(esperados) >= 3,
      'la ronda quedo con %d punto(s): %s' % (len(esperados), sorted(nombres)))

# La comprobacion que de verdad importa: el punto agregado DESPUES de generar la
# ronda tiene que estar. Se busca por su nombre unico, no por posicion.
check('  y entre ellos esta el punto agregado despues de generarla',
      any(NOMBRE_EXTRA in n for n in nombres),
      'no aparece "%s" en %s' % (NOMBRE_EXTRA, sorted(nombres)))

# ------------------------------------------------------------------ limpieza
# Se da de baja lo que creo la prueba. No se borra: el historial de la ronda que
# quedo tiene que seguir resolviendo. Sin esta limpieza cada corrida acumulaba
# puntos en el recinto demo — y eso fue justo lo que hizo pasar por casualidad a
# una version anterior de esta prueba.
pedir('PATCH', API + '/supervisor/routes/%s/active' % ruta['id'], {'isActive': False}, supervisor)
pedir('PATCH', API + '/checkpoints/supervisor/checkpoints/%s/active' % extra['id'],
      {'isActive': False}, supervisor)

print('=' * 72)
print('RESULTADO: %d fallas' % len(fallas))
for f in fallas:
    print('  FALLA %s' % f)
print('=' * 72)
raise SystemExit(1 if fallas else 0)
