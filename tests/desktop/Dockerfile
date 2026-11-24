FROM node:22-bookworm@sha256:ea8bd080e29e91159a41a0dc04672bebac17a3871030c3bae087cbd2922c1850
RUN apt-get update && apt-get install -y --no-install-recommends \
    at-spi2-core chromium dbus-x11 gir1.2-atspi-2.0 gir1.2-gtk-3.0 libasound2 libgbm1 libnss3 libx11-xcb1 \
    openbox pulseaudio pulseaudio-utils python3-gi python3-xlib \
    trayer xauth xdotool xvfb && rm -rf /var/lib/apt/lists/*
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
