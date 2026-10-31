# Internal staging only. Rebuild and review package versions before promotion.
FROM postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
RUN apk add --no-cache python3=3.14.10-r1 py3-cryptography=47.0.0-r0 \
    && python3 -c 'from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey'
