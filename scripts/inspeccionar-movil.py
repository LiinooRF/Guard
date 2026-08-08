# -*- coding: utf-8 -*-
"""Le pregunta cosas al portal que corre DENTRO de la app, por DevTools.

Requiere el reenvio del socket ya hecho:
    adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_<pid>

Existe porque diagnosticar un WebView desde fuera es adivinar: hoy cuatro bugs
costaron un build de 25 minutos cada uno por no tener esto.
"""
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')

try:
    from websocket import create_connection  # type: ignore
except ImportError:
    print('falta websocket-client: pip install websocket-client')
    raise SystemExit(1)


def pagina():
    with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=20) as r:
        for p in json.loads(r.read().decode()):
            if p.get('webSocketDebuggerUrl'):
                return p
    return None


def evaluar(ws, expresion, numero):
    ws.send(json.dumps({
        'id': numero,
        'method': 'Runtime.evaluate',
        'params': {'expression': expresion, 'returnByValue': True, 'awaitPromise': True},
    }))
    while True:
        respuesta = json.loads(ws.recv())
        if respuesta.get('id') == numero:
            resultado = respuesta.get('result', {}).get('result', {})
            if 'exceptionDetails' in respuesta.get('result', {}):
                return 'EXCEPCION: %s' % respuesta['result']['exceptionDetails'].get('text')
            return resultado.get('value')


PREGUNTAS = [
    ('url', 'location.href'),
    ('¿existe el puente nativo?', 'typeof window.__voxiaPuente'),
    ('version del protocolo', 'window.__voxiaPuente ? window.__voxiaPuente.major + "." + window.__voxiaPuente.minor : "sin puente"'),
    ('¿hay ReactNativeWebView?', 'typeof window.ReactNativeWebView'),
    ('inputs de archivo en la pantalla',
     'JSON.stringify([].slice.call(document.querySelectorAll("input[type=file]")).map(function(i){'
     'return {capture: i.getAttribute("capture"), accept: i.accept, oculto: i.offsetParent === null, deshabilitado: i.disabled};}))'),
    ('botones visibles',
     'JSON.stringify([].slice.call(document.querySelectorAll("button")).slice(0,12).map(function(b){'
     'return b.textContent.trim().slice(0,34);}))'),
    ('errores registrados', 'JSON.stringify(window.__erroresVoxia || [])'),
    ('texto de la pantalla',
     r'document.body.innerText.replace(/\s+/g," ").slice(0, 420)'),
]

p = pagina()
if not p:
    print('no hay pagina inspeccionable')
    raise SystemExit(1)
print('inspeccionando: %s\n' % p['url'])
# suppress_origin: Chrome rechaza el WebSocket si llega con una cabecera
# Origin que no autorizo (403 "Rejected an incoming WebSocket connection").
ws = create_connection(p['webSocketDebuggerUrl'], timeout=25, suppress_origin=True)
# Se capturan los errores que ocurran de aqui en adelante.
evaluar(ws, 'window.__erroresVoxia = window.__erroresVoxia || []; '
            'window.addEventListener("error", function(e){ window.__erroresVoxia.push(String(e.message)); }); '
            'window.addEventListener("unhandledrejection", function(e){ window.__erroresVoxia.push("promesa: " + e.reason); }); '
            '"ok"', 900)
for i, (etiqueta, expresion) in enumerate(PREGUNTAS, start=1):
    print('%-34s %s' % (etiqueta + ':', evaluar(ws, expresion, i)))
ws.close()
