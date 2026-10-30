#!/bin/sh
set -e

cp -a /opt/hirearchy/repo-template/. /workspace/
python3 /workspace/app.py > /tmp/flask.log 2>&1 &
for attempt in $(seq 1 100); do
    if python3 -c 'from urllib.request import urlopen; urlopen("http://127.0.0.1:8000/health", timeout=0.2)' >/dev/null 2>&1; then
        touch /tmp/scenario_ready
        exec sleep infinity
    fi
    sleep 0.1
done
cat /tmp/flask.log
exit 1
