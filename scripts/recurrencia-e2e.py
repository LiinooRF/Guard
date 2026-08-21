# -*- coding: utf-8 -*-
"""E2E: una regla recurrente materializa el turno sola, sin cargarlo cada semana.

QUE RESUELVE
-------------------------------------------------------------------------------
Asignar era por FECHA: una llamada por dia. El calendario del panel dejaba
marcar varios dias, pero cada semana habia que rehacer el mismo trabajo. En un
rubro de turnos fijos eso es teclear lo mismo cincuenta veces al año por guardia.

Ahora se declara la REGLA una vez —guardia, turno, dias— y al generar las rondas
del dia la regla se expande a la asignacion concreta.

Se prueba contra el DESPLIEGUE porque lo que importa es la cadena completa:
crear la regla, generar el dia, y que el turno aparezca. Cada pieza por separado
ya tiene sus pruebas unitarias.
"""
import json
import os
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

BASE = os.environ.get('SENTRYCORE_BASE', '').strip().rstrip('/')
CLAVE = os.environ.get('SENTRYCORE_DEMO_PASSWORD', '')
if not BASE or not CLAVE:
    raise SystemExit('Faltan SENTRYCORE_BASE y/o SENTRYCORE_DEMO_PASSWORD (#295).')
API = BASE + '/api'
UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

fallas = []


def check(nombre, condicion, detalle=''):
    print('  %-5s %s%s' % ('OK' if condicion else 'FALLA', nombre,
                           '' if condicion else '  <- %s' % detalle))
    if not condicion:
        fallas.append(nombre)


def pedir(metodo, url, carga=None, galletas=''):
    datos = json.dumps(carga).encode() if carga is not None else None
    p = urllib.request.Request(url, data=datos, method=metodo)
    p.add_header('Origin', BASE)
    p.add_header('X-SentryCore-Request', 'web')
    p.add_header('User-Agent', UA_PC)
    if datos is not None:
        p.add_header('Content-Type', 'application/json')
    if galletas:
        p.add_header('Cookie', galletas)
    try:
        with urllib.request.urlopen(p, timeout=90) as r:
            return r.status, r.read().decode('utf-8', 'replace'), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), e.headers


def entrar(correo):
    estado, cuerpo, cab = pedir('POST', API + '/auth/login',
                                {'identity': correo, 'password': CLAVE})
    if estado != 200:
        raise SystemExit('no pude entrar como %s: HTTP %s %s' % (correo, estado, cuerpo[:200]))
    return '; '.join(c.split(';')[0] for c in cab.get_all('Set-Cookie') or [])


def json_de(texto, porDefecto=None):
    try:
        return json.loads(texto)
    except Exception:
        return porDefecto if porDefecto is not None else {}


print('=' * 72)
print('E2E: asignacion recurrente por empleado')
print('=' * 72)

supervisor = entrar('supervisor@demo-andina.test')
marca = datetime.now(timezone.utc).strftime('%H%M%S')

estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites', None, supervisor)
sitios = json_de(cuerpo, [])
if not sitios:
    check('el supervisor tiene un recinto', False, 'HTTP %s' % estado)
    raise SystemExit(1)
sitio = sitios[0]

estado, cuerpo, _ = pedir('GET', API + '/supervisor/sites/%s/guards' % sitio['id'], None, supervisor)
guardias = json_de(cuerpo, [])
guardia = next((g for g in guardias if 'demo' in (g.get('name') or '').lower()), None) or (
    guardias[0] if guardias else None)
if not guardia:
    check('el recinto tiene un guardia', False, 'ninguno')
    raise SystemExit(1)

# La fecha objetivo: el proximo lunes. Se elige un dia FUTURO y concreto para
# que la prueba no dependa de que hoy sea el dia correcto.
hoy = date.today()
objetivo = hoy + timedelta(days=(7 - hoy.weekday()) % 7 or 7)  # proximo lunes
dow = (objetivo.weekday() + 1) % 7  # python: lunes=0 ; postgres/DOW: domingo=0

# Turno propio de la prueba, activo ese dia de la semana.
estado, cuerpo, _ = pedir(
    'POST', API + '/supervisor/sites/%s/shifts' % sitio['id'],
    {'name': 'e2e turno recurrente %s' % marca, 'startsAt': '08:00', 'endsAt': '16:00',
     'weekdays': [dow]},
    supervisor)
turno = json_de(cuerpo)
check('se crea un turno para ese dia de la semana', estado in (200, 201) and turno.get('id'),
      'HTTP %s %s' % (estado, cuerpo[:220]))
if not turno.get('id'):
    raise SystemExit(1)

# --------------------------------------------------------------- la regla
estado, cuerpo, _ = pedir(
    'POST', API + '/scheduling/shifts/%s/recurrences' % turno['id'],
    {'guardId': guardia['id'], 'weekdays': [dow], 'startsOn': hoy.isoformat()},
    supervisor)
regla = json_de(cuerpo)
check('se crea la regla recurrente', estado in (200, 201) and regla.get('id'),
      'HTTP %s %s' % (estado, cuerpo[:220]))

estado, cuerpo, _ = pedir(
    'POST', API + '/scheduling/shifts/%s/recurrences' % turno['id'],
    {'guardId': guardia['id'], 'weekdays': [dow], 'startsOn': hoy.isoformat()},
    supervisor)
check('  y no se puede crear una segunda regla activa para el mismo guardia',
      estado == 409, 'HTTP %s %s' % (estado, cuerpo[:160]))

# ------------------------------------------- generar el dia expande la regla
estado, cuerpo, _ = pedir(
    'POST', API + '/scheduling/generate',
    {'serviceDate': objetivo.isoformat(), 'siteId': sitio['id']}, supervisor)
gen = json_de(cuerpo)
check('generar ese dia expande la regla a un turno concreto',
      estado in (200, 201) and gen.get('assignmentsFromRecurrences', 0) >= 1,
      'HTTP %s -> %s' % (estado, str(gen)[:220]))

# Correr de nuevo NO puede duplicar: es la garantia de idempotencia.
estado, cuerpo, _ = pedir(
    'POST', API + '/scheduling/generate',
    {'serviceDate': objetivo.isoformat(), 'siteId': sitio['id']}, supervisor)
gen2 = json_de(cuerpo)
check('  y correrlo otra vez no duplica el turno',
      estado in (200, 201) and gen2.get('assignmentsFromRecurrences', 0) == 0,
      'la segunda corrida creo %s' % gen2.get('assignmentsFromRecurrences'))

# ------------------------------------------------------- listar y dar de baja
estado, cuerpo, _ = pedir('GET', API + '/scheduling/shifts/%s/recurrences' % turno['id'],
                          None, supervisor)
listado = json_de(cuerpo, [])
mia = next((r for r in listado if r.get('id') == regla.get('id')), None)
check('la regla aparece en el listado con sus turnos materializados',
      bool(mia) and mia.get('assignmentsCreated', 0) >= 1,
      str(listado)[:220])

estado, cuerpo, _ = pedir(
    'PATCH', API + '/scheduling/recurrences/%s/active' % regla.get('id'),
    {'isActive': False}, supervisor)
check('se puede dar de baja la regla', estado in (200, 204),
      'HTTP %s %s' % (estado, cuerpo[:160]))

# Dada de baja, un dia nuevo ya no se expande.
otro = objetivo + timedelta(days=7)
estado, cuerpo, _ = pedir(
    'POST', API + '/scheduling/generate',
    {'serviceDate': otro.isoformat(), 'siteId': sitio['id']}, supervisor)
gen3 = json_de(cuerpo)
check('  y despues de la baja deja de crear turnos',
      estado in (200, 201) and gen3.get('assignmentsFromRecurrences', 0) == 0,
      'creo %s' % gen3.get('assignmentsFromRecurrences'))

print('=' * 72)
print('RESULTADO: %d fallas' % len(fallas))
for f in fallas:
    print('  FALLA %s' % f)
print('=' * 72)
raise SystemExit(1 if fallas else 0)
