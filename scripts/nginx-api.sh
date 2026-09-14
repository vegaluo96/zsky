#!/bin/bash
# 给 nginx 默认站点加 /api 反代（SSE 友好）
set -e
if grep -q "location /api/" /etc/nginx/sites-available/default; then
  echo "API_LOCATION_ALREADY_EXISTS"
else
  python3 - <<'PY'
p = '/etc/nginx/sites-available/default'
s = open(p).read()
old = 'root /home/admin/app;'
new = '''root /home/admin/app;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }'''
assert old in s, 'root line not found'
open(p, 'w').write(s.replace(old, new, 1))
print('API_LOCATION_ADDED')
PY
fi
nginx -t 2>&1 | tail -1
systemctl reload nginx
echo NGINX_OK
