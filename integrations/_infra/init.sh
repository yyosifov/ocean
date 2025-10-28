if test -e /usr/local/share/ca-certificates/cert.crt; then
  update-ca-certificates

  # install openssl - test change
  apk add --no-cache openssl 
fi

ocean sail
