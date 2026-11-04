FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y python3 systemd-resolved bubblewrap dbus && rm -rf /var/lib/apt/lists/*

COPY probe.py native.py /probe/
ENTRYPOINT ["python3", "/probe/probe.py"]
