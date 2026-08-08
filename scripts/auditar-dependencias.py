# -*- coding: utf-8 -*-
"""Auditoria de dependencias que solo se pone roja ante avisos NUEVOS.

`npm audit` a secas es una compuerta que cambia sola: se pone roja porque
alguien publico un aviso anoche, no porque cambiara una linea del repo. Y una
compuerta que esta roja sin motivo propio deja de significar algo — que es
exactamente lo que paso con el check del AAB, once corridas seguidas en rojo
hasta que nadie lo miraba.

Aca los avisos que hoy no tienen salida se anotan UNO A UNO, con el motivo
escrito. Cualquier aviso que no este en la lista pone el check en rojo, que es
para lo que sirve un check.

Uso:  python scripts/auditar-dependencias.py apps/mobile
"""
import json
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

# Avisos sin arreglo posible HOY. La clave es el paquete; el valor, por que.
#
# Los diez son la misma historia: el proyecto usa Expo 57.0.9 y React Native
# 0.86.2, y el "arreglo" que propone npm es bajar a Expo 53.0.27 / RN 0.72.17
# —cuatro SDK atras—, lo que romperia la app entera. No hay version parcheada
# publicada: hay que esperar a que Expo la saque.
#
# Cuando Expo publique, se quitan de aca y el check los exige.
HEREDADOS = {
    'expo': 'sin parche; npm propone bajar a 53.0.27, cuatro SDK atras',
    '@expo/cli': 'arrastrado por expo',
    '@expo/metro': 'arrastrado por expo',
    '@expo/metro-config': 'arrastrado por expo',
    'metro': 'arrastrado por expo',
    'metro-config': 'arrastrado por expo',
    'metro-transform-worker': 'arrastrado por expo',
    'image-size': 'arrastrado por expo',
    'react-native': 'sin parche; npm propone bajar a 0.72.17',
    '@react-native/community-cli-plugin': 'arrastrado por react-native',
    '@react-native/virtualized-lists': 'arrastrado por react-native',
    # Estos dos SI tienen arreglo limpio, pero mover el arbol de dependencias
    # del movil es un cambio que merece su propio PR y su propio APK de prueba,
    # no colarse en uno de otra cosa. Ver el issue de actualizacion.
    'js-yaml': 'tiene arreglo limpio; se hace en su propio PR (issue de deps)',
    'nanoid': 'tiene arreglo limpio; se hace en su propio PR (issue de deps)',
}


def auditar(directorio):
    proceso = subprocess.run(
        ['npm', 'audit', '--omit=dev', '--json'],
        cwd=directorio, capture_output=True, text=True, shell=(sys.platform == 'win32'))
    # `npm audit` sale con 1 cuando encuentra algo: eso no es un fallo del
    # comando, es su forma de contestar. Lo que importa es el JSON.
    salida = proceso.stdout.strip()
    if not salida:
        print('npm audit no devolvio nada:\n%s' % proceso.stderr[:400])
        raise SystemExit(2)
    return json.loads(salida.lstrip('﻿'))


def main():
    directorio = sys.argv[1] if len(sys.argv) > 1 else '.'
    vulnerabilidades = auditar(directorio).get('vulnerabilities', {})

    nuevos = []
    print('AVISOS EN %s' % directorio)
    print('=' * 70)
    for nombre, v in sorted(vulnerabilidades.items()):
        conocido = nombre in HEREDADOS
        print('  %-36s %-8s %s' % (
            nombre, v.get('severity'),
            ('heredado: ' + HEREDADOS[nombre]) if conocido else '*** NUEVO ***'))
        if not conocido:
            nuevos.append(nombre)

    resueltos = [n for n in HEREDADOS if n not in vulnerabilidades]
    if resueltos:
        print()
        print('Ya no aparecen y hay que sacarlos de HEREDADOS (%d):' % len(resueltos))
        for n in sorted(resueltos):
            print('  - %s' % n)

    print()
    if nuevos:
        print('ROJO: %d aviso(s) que nadie ha mirado: %s' % (len(nuevos), ', '.join(nuevos)))
        print('Se arreglan, o se anotan en HEREDADOS con el motivo escrito.')
        return 1
    print('VERDE: %d aviso(s), todos anotados y justificados.' % len(vulnerabilidades))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
