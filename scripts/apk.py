# -*- coding: utf-8 -*-
"""Construye el APK de prueba en EAS, de principio a fin.

    python apk.py            -> comprueba, lanza el build y espera el enlace
    python apk.py --revisar  -> solo las comprobaciones previas, no construye
    python apk.py --estado   -> mira en que va el ultimo build, sin lanzar otro

Comprueba ANTES de encolar porque la cola gratuita tarda entre 10 y 25 minutos:
descubrir alli que faltaba un dato cuesta media hora, y el 90% de los fallos son
de configuracion, no de codigo.
"""
import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

AQUI = os.path.dirname(os.path.abspath(__file__))
MOVIL = os.path.join(AQUI, '..', 'apps', 'mobile')
REPO = os.path.join(AQUI, '..')
PERFIL = 'preview'


def correr(argumentos, cwd=MOVIL, timeout=900):
    hecho = subprocess.run(argumentos, cwd=cwd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', shell=True, timeout=timeout)
    return hecho.returncode, (hecho.stdout or '') + (hecho.stderr or '')


def paso(nombre, ok, detalle=''):
    print('  %-4s %s%s' % ('OK' if ok else 'FALLA', nombre, '' if ok else '\n        %s' % detalle))
    return ok


# ---------------------------------------------------------------- comprobaciones
def revisar():
    print('=' * 68)
    print('COMPROBACIONES PREVIAS')
    print('=' * 68)
    todo = True

    codigo, salida = correr('npx eas-cli whoami')
    cuentas = [l.strip('• ').split(' ')[0] for l in salida.splitlines() if l.strip().startswith('•')]
    todo &= paso('sesion de Expo iniciada (%s)' % ', '.join(cuentas) if cuentas else 'sesion de Expo',
                 codigo == 0, 'corre `npx eas-cli login` en una terminal con teclado')

    codigo, salida = correr('git status --porcelain', cwd=REPO)
    sucios = [l for l in salida.splitlines() if l.strip()]
    todo &= paso('arbol de git limpio', not sucios,
                 'eas.json tiene requireCommit: true. Sin commitear:\n        ' +
                 '\n        '.join(sucios[:5]))

    codigo, salida = correr('npx expo config --type public')
    dueno = re.search(r"owner:\s*\x1b?\[?[0-9;]*m?'([^']+)'", salida)
    proyecto = re.search(r"projectId:\s*\x1b?\[?[0-9;]*m?'([^']+)'", salida)
    todo &= paso('app.config.ts declara owner y projectId',
                 bool(dueno and proyecto),
                 'falta owner o extra.eas.projectId en app.config.ts')
    if dueno and proyecto:
        print('        owner=%s  projectId=%s' % (dueno.group(1), proyecto.group(1)))
        # El error que ya nos costo un intento: el owner tiene que ser el dueño
        # REAL del projectId, y EAS aborta el build si no coinciden.
        todo &= paso('  el owner esta entre las cuentas de la sesion',
                     not cuentas or dueno.group(1) in cuentas,
                     'owner=%s no esta en %s' % (dueno.group(1), cuentas))

    # EAS exige que el slug de app.config.ts sea EL MISMO que el del proyecto
    # dueño del projectId, y lo comprueba recien al encolar. Ya nos costo un
    # intento: el proyecto se llamaba `pruebas` y el config decia `voxia-control`.
    codigo, salida = correr('npx eas-cli project:info')
    desajuste = re.search(r'Slug for project identified by[^(]*\(([^)]+)\)[^(]*\(([^)]+)\)', salida)
    todo &= paso('el slug del proyecto en EAS coincide con el del config',
                 codigo == 0,
                 ('el proyecto en Expo se llama %r y app.config.ts dice %r.\n'
                  '        Renombralo en expo.dev -> Settings, o usa el projectId del\n'
                  '        proyecto correcto. Ojo: ese proyecto sera el dueño del keystore.'
                  % (desajuste.group(1), desajuste.group(2))) if desajuste
                 else salida.strip()[:200])

    perfiles = json.load(open(os.path.join(MOVIL, 'eas.json'), encoding='utf-8'))['build']
    destino = (perfiles.get(PERFIL, {}).get('env') or {}).get('EXPO_PUBLIC_WEB_URL', '')
    todo &= paso('el perfil %s apunta a un portal https' % PERFIL,
                 destino.startswith('https://'), 'apunta a %r' % destino)
    print('        -> %s' % destino)

    faltan = [a for a in ('icon.png', 'splash-icon.png', 'adaptive-icon-foreground.png',
                          'adaptive-icon-monochrome.png')
              if not os.path.exists(os.path.join(MOVIL, 'assets', a))]
    todo &= paso('los iconos y el splash estan commiteados', not faltan, 'faltan: %s' % faltan)

    return todo


# ---------------------------------------------------------------- el build
def ultimo_build():
    codigo, salida = correr(
        'npx eas-cli build:list --platform android --limit 1 --json --non-interactive')
    inicio = salida.find('[')
    if inicio == -1:
        return None
    try:
        lista = json.loads(salida[inicio:salida.rfind(']') + 1])
    except json.JSONDecodeError:
        return None
    return lista[0] if lista else None


def esperar(minutos=45):
    print()
    print('=' * 68)
    print('ESPERANDO A EAS  (la cola gratuita tarda entre 10 y 25 minutos)')
    print('=' * 68)
    visto = None
    for i in range(minutos * 4):
        build = ultimo_build()
        if not build:
            time.sleep(15)
            continue
        estado = build.get('status')
        if estado != visto:
            print('  [%4d min] %s' % (i // 4, estado))
            visto = estado
        if estado == 'FINISHED':
            print()
            print('=' * 68)
            print('APK LISTO')
            print('=' * 68)
            print('  Instalar:  %s' % build.get('artifacts', {}).get('buildUrl', '(sin url)'))
            print('  Detalle:   %s' % build.get('buildUrl', ''))
            print()
            print('  AHORA, sin dejarlo para despues:')
            print('    npx eas-cli credentials -p android    # descarga el keystore')
            print('  Guardalo FUERA de Expo. Es lo unico del proyecto que no se')
            print('  puede rehacer: sin el no se puede volver a actualizar la app')
            print('  publicada, nunca.')
            print()
            print('  Credenciales demo: obtenerlas del gestor de secretos del equipo.')
            return 0
        if estado in ('ERRORED', 'CANCELED'):
            print('\n  El build termino en %s. Detalle: %s' % (estado, build.get('buildUrl', '')))
            return 1
        time.sleep(15)
    print('\n  Se acabo la espera. Mira el estado con:  python apk.py --estado')
    return 1


if __name__ == '__main__':
    if '--apk' in sys.argv or '--estado' in sys.argv:
        build = ultimo_build()
        if not build:
            print('no hay builds todavia')
            raise SystemExit(0)
        descarga = (build.get('artifacts') or {}).get('buildUrl')
        print('estado:  %s' % build.get('status'))
        print('pagina:  %s' % (build.get('buildUrl') or ''))
        print('APK:     %s' % (descarga or '(sale cuando el estado sea FINISHED)'))
        if descarga:
            print()
            print('  Abre esa URL DENTRO de LDPlayer y se instala solo,')
            print('  o descargala aca y arrastra el .apk a la ventana del emulador.')
        raise SystemExit(0)

    if not revisar():
        print('\nHay comprobaciones en rojo: se arreglan antes de encolar, que la cola tarda.')
        raise SystemExit(1)

    if '--revisar' in sys.argv:
        print('\nTodo listo. Corre `python apk.py` para construir.')
        raise SystemExit(0)

    print()
    print('=' * 68)
    print('ENCOLANDO EL BUILD  (perfil %s, APK instalable)' % PERFIL)
    print('=' * 68)
    codigo, salida = correr(
        'npx eas-cli build --platform android --profile %s --non-interactive --no-wait' % PERFIL,
        timeout=1800)
    for linea in salida.splitlines():
        if any(x in linea for x in ('http', 'Keystore', 'error', 'Error', 'Build details')):
            print('  ' + linea.strip()[:160])
    if codigo != 0:
        print('\n  EAS rechazo el build (codigo %d). Lo de arriba dice por que.' % codigo)
        raise SystemExit(1)

    raise SystemExit(esperar())
