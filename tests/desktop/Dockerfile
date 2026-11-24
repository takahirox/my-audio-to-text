FROM node:22-bookworm@sha256:ea8bd080e29e91159a41a0dc04672bebac17a3871030c3bae087cbd2922c1850
RUN apt-get update && apt-get install -y --no-install-recommends \
    at-spi2-core dbus-x11 gir1.2-atspi-2.0 gir1.2-gtk-3.0 libasound2 libgbm1 libnss3 libx11-xcb1 \
    openbox pulseaudio pulseaudio-utils python3-gi python3-xlib \
    trayer xauth xdotool xvfb && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://archive.mozilla.org/pub/firefox/releases/162.0b1/linux-aarch64/en-US/firefox-162.0b1.tar.xz -o /tmp/firefox.tar.xz \
    && echo '1d23e7d03429b48697cde948a514b2c5ed0607eb1b63feeba7b2ec05844a5b78  /tmp/firefox.tar.xz' | sha256sum -c - \
    && tar -xJf /tmp/firefox.tar.xz -C /opt && rm /tmp/firefox.tar.xz \
    && ln -s /opt/firefox/firefox /usr/local/bin/firefox
RUN mkdir /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
