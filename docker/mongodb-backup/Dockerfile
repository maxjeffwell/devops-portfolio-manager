FROM mongo:7
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip && \
    pip3 install awscli && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
