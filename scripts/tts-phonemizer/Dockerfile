FROM emscripten/emsdk@sha256:3977e19edd48f8370b1fe43bfe0368439d3521f0bbe0d96e6d018fc076241491
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf=2.71-2 automake=1:1.16.5-1.3 libtool=2.4.6-15build2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
