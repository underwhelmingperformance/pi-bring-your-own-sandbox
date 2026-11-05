FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y python3 systemd-resolved bubblewrap dbus && rm -rf /var/lib/apt/lists/*

COPY probe.py native.py /probe/
ENTRYPOINT ["python3", "/probe/probe.py"]
