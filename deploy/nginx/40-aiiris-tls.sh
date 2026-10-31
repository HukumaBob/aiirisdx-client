#!/bin/sh
# Enable the HTTPS server (8443) only when a certificate is mounted at /etc/nginx/certs, and
# decide what plain HTTP (8080) serves (conf.d/aiiris-http.inc, included by default.conf):
# - certs present: 308 redirect to https://<host>:${AIIRIS_HTTPS_PUBLIC_PORT}<uri> for
#   everything except /nginx-health (the container healthcheck); set AIIRIS_HTTP_REDIRECT=0
#   to keep serving plain HTTP as well (not recommended with stand tokens)
# - no certs: the full site over HTTP (on-prem LAN)
set -eu
HTTP_INC=/etc/nginx/conf.d/aiiris-http.inc
if [ -s /etc/nginx/certs/tls.crt ] && [ -s /etc/nginx/certs/tls.key ]; then
    envsubst '${AIIRIS_SERVER_NAME} ${AIIRIS_BACKEND_UPSTREAM}' < /etc/nginx/aiiris/tls.conf.template > /etc/nginx/conf.d/tls.conf
    echo "aiiris: TLS enabled on 8443"
    if [ "${AIIRIS_HTTP_REDIRECT:-1}" = "0" ]; then
        echo 'include /etc/nginx/aiiris/common.conf;' > "$HTTP_INC"
        echo "aiiris: WARNING plain HTTP on 8080 still serves the site (AIIRIS_HTTP_REDIRECT=0)"
    else
        port="${AIIRIS_HTTPS_PUBLIC_PORT:-8443}"
        if [ "$port" = "443" ]; then target='https://$host$request_uri'; else target="https://\$host:${port}\$request_uri"; fi
        cat > "$HTTP_INC" <<INC
location = /nginx-health {
    access_log off;
    default_type text/plain;
    return 200 "ok\n";
}
location / {
    return 308 ${target};
}
INC
        echo "aiiris: plain HTTP on 8080 redirects to HTTPS (port ${port})"
    fi
else
    rm -f /etc/nginx/conf.d/tls.conf
    echo 'include /etc/nginx/aiiris/common.conf;' > "$HTTP_INC"
    echo "aiiris: no certificate in /etc/nginx/certs -- HTTP only (camera needs HTTPS or localhost)"
fi
