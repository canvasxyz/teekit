# Nginx/Certbot for Gramine SGX

Use the `certbot-launcher.sh` script to automatically obtain Let's
Encrypt certificates, and configure nginx for HTTPS with proxying to
kettle instances.

When running multiple kettles, ports are allocated as follows:

| Kettle | workerd Port | HTTPS Port |
|--------|--------------|------------|
| 0      | 3001         | 443        |
| 1      | 3003         | 444        |
| 2      | 3005         | 445        |
| ...    | ...          | ...        |

## Usage

```
apt update
apt install nginx certbot

HOSTNAME_CONFIG="kettle.example.com" ./scripts/certbot-launcher.sh                  # One hostname
HOSTNAME_CONFIG="app1.example.com,app2.example.com" ./scripts/certbot-launcher.sh   # Multiple hostnames
```

## Troubleshooting

Check nginx configuration:
```
nginx -t
```

View nginx error logs:

```
journalctl -u nginx -f
# or
tail -f /var/log/nginx/error.log
```

Check certificate expiry:

```
certbot certificates
```

Renew certificates:

```
certbot renew
systemctl reload nginx
```
