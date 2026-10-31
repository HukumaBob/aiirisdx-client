#!/bin/sh
# Enable the HTTPS server (8443) only when a certificate is mounted at /etc/nginx/certs.
set -eu
if [ -s /etc/nginx/certs/tls.crt ] && [ -s /etc/nginx/certs/tls.key ]; then
    envsubst '${AIIRIS_SERVER_NAME} ${AIIRIS_BACKEND_UPSTREAM}' < /etc/nginx/aiiris/tls.conf.template > /etc/nginx/conf.d/tls.conf
    echo "aiiris: TLS enabled on 8443"
else
    rm -f /etc/nginx/conf.d/tls.conf
    echo "aiiris: no certificate in /etc/nginx/certs -- HTTP only (camera needs HTTPS or localhost)"
fi
