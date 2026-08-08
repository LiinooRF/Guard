# -*- coding: utf-8 -*-
"""Manda un `hello` BIEN FORMADO al shell y mide cuanto tarda en contestar.

El sobre tiene que ser exactamente el de `armarSobre()` en protocol.ts:

    { p: 'voxia.bridge', v: 1, id, type, payload, ts }

La version anterior de este guion mandaba `{ protocolo, type, id, payload }` —
nombre de campo equivocado y sin `v` ni `ts`—, asi que `leerMensajePortal` lo
descartaba por invalido y el shell no contestaba NUNCA. El "no contesto" era del
guion, no de la app. Si vuelves a tocar esto, copia los campos del codigo.
"""
import json
import sys
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')
from websocket import create_connection  # type: ignore

ESPERA_S = 40

GUION_ENVIAR = """
(function () {
  if (!window.__voxiaPuente) return 'SIN PUENTE';
  window.__respuestas = [];
  window.__t0 = Date.now();
  window.__voxiaPuente.suscribir(function (json) {
    window.__respuestas.push({ ms: Date.now() - window.__t0, json: String(json).slice(0, 240) });
  });
  window.__voxiaPuente.enviar(JSON.stringify({
    p: 'voxia.bridge',
    v: 1,
    id: 'medicion-' + Date.now(),
    type: 'hello',
    payload: { portalBuild: 'medicion-diagnostico', requiere: { major: 1, minMinor: 0 } },
    ts: new Date().toISOString()
  }));
  return 'saludo enviado (sobre correcto)';
})();
"""

GUION_ESPERAR = """
new Promise(function (resolver) {
  var intentos = 0;
  var t = setInterval(function () {
    intentos += 1;
    if (window.__respuestas && window.__respuestas.length) {
      clearInterval(t);
      resolver(JSON.stringify(window.__respuestas));
    } else if (intentos > %d) {
      clearInterval(t);
      resolver('NO CONTESTO en %d segundos');
    }
  }, 500);
})
""" % (ESPERA_S * 2, ESPERA_S)


def pagina():
    with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=20) as r:
        for p in json.loads(r.read().decode()):
            if p.get('webSocketDebuggerUrl'):
                return p
    return None


contador = [0]


def ev(ws, expresion):
    contador[0] += 1
    ws.send(json.dumps({'id': contador[0], 'method': 'Runtime.evaluate', 'params': {
        'expression': expresion, 'returnByValue': True, 'awaitPromise': True}}))
    while True:
        r = json.loads(ws.recv())
        if r.get('id') == contador[0]:
            if 'exceptionDetails' in r.get('result', {}):
                return 'EXCEPCION: %s' % r['result']['exceptionDetails'].get('text')
            return r.get('result', {}).get('result', {}).get('value')


p = pagina()
if not p:
    print('no hay WebView inspeccionable')
    raise SystemExit(1)
ws = create_connection(p['webSocketDebuggerUrl'], timeout=ESPERA_S + 25, suppress_origin=True)
print('url:', ev(ws, 'location.href'))
print(ev(ws, GUION_ENVIAR))
print('respuesta:', ev(ws, GUION_ESPERAR))
ws.close()
