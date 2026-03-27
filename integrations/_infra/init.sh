if test -e /usr/local/share/ca-certificates/cert.crt; then
  if [ "$(id -u)" -eq 0 ]; then
    update-ca-certificates
  else
    echo "Non-root user detected; skipping update-ca-certificates"
  fi
fi

ocean sail
