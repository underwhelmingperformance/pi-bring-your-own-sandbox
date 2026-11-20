ARG TARGETARCH
ARG NODE_IMAGE=node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgssapi-krb5-2 libicu72 libssl3 && rm -rf /var/lib/apt/lists/*

FROM runtime AS archive-arm64
ADD --checksum=sha256:e59c89776eaa59790d44b3edd14277435225ab08b6e7603763101b89de83d935 https://github.com/PowerShell/PowerShell/releases/download/v7.7.0/powershell-7.7.0-linux-arm64.tar.gz /tmp/powershell.tar.gz

FROM runtime AS archive-amd64
ADD --checksum=sha256:c89d9c682d2c403dfe726f3df948e359675235a5bd6fab535776de69729ca0cb https://github.com/PowerShell/PowerShell/releases/download/v7.7.0/powershell-7.7.0-linux-x64.tar.gz /tmp/powershell.tar.gz

FROM archive-${TARGETARCH} AS unpack
RUN mkdir -p /opt/powershell && tar -xzf /tmp/powershell.tar.gz -C /opt/powershell && chmod 0755 /opt/powershell/pwsh

FROM runtime
ENV POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off
COPY --from=unpack /opt/powershell /opt/powershell
