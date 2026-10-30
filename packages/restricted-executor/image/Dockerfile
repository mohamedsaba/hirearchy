FROM python@sha256:d657ab0ade19f404a6ccc883ab399540de667aff751748ce23c07330c5a89e64
LABEL org.opencontainers.image.source="https://github.com/mohamedsaba/hirearchy"
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
    && python3 -m pip uninstall -y pip setuptools wheel \
    && rm -rf /usr/local/lib/python3.12/ensurepip /tmp/requirements.txt \
    && rm -f /usr/local/bin/pip* /usr/local/bin/easy_install*
WORKDIR /workspace
USER 65534:65534
