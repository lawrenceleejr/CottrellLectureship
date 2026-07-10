# Hugo (extended) for building/serving a static site.
FROM debian:bookworm-slim

ARG HUGO_VERSION=0.140.0
ARG TARGETARCH=amd64

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fSL \
      "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${TARGETARCH}.tar.gz" \
      -o /tmp/hugo.tgz \
    && tar -xzf /tmp/hugo.tgz -C /usr/local/bin hugo \
    && rm /tmp/hugo.tgz \
    && hugo version

WORKDIR /site
EXPOSE 1313
ENTRYPOINT ["hugo"]
