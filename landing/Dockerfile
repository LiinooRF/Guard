# Landing publica de SentryCore. Solo archivos estaticos: no hay build, no hay
# Node en la imagen final, y el contenedor arranca en menos de un segundo.
FROM nginx:1.29-alpine

# La configuracion propia reemplaza a la default. Va antes que el contenido
# para que un cambio de texto en la landing no invalide esta capa.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY . /usr/share/nginx/html/
# El Dockerfile y la config se copian con el resto —COPY . es todo el
# directorio— y no tienen nada que hacer en la raiz publica.
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/nginx.conf

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/robots.txt >/dev/null 2>&1 || exit 1
