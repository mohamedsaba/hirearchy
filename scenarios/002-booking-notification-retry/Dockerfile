FROM hirearchy-scenario-001:latest

USER root
RUN rm -rf /opt/hirearchy/repo-template
COPY repository /opt/hirearchy/repo-template
COPY start_services.sh /usr/local/bin/start_services.sh
RUN chown -R hirearchy:hirearchy /opt/hirearchy/repo-template && \
    cd /opt/hirearchy/repo-template && \
    su hirearchy -c "git init && git add . && git commit -m 'baseline scenario state'" && \
    chmod +x /usr/local/bin/start_services.sh

USER hirearchy
WORKDIR /workspace
ENV PYTHONPATH=/workspace
CMD ["/usr/local/bin/start_services.sh"]
