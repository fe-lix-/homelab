FROM node:22-bookworm-slim

# Build mp4decrypt from source (no arm64 binary release from Bento4)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      cmake \
      g++ \
      make \
      git \
      ca-certificates \
    && git clone --depth 1 https://github.com/axiomatic-systems/Bento4.git /tmp/bento4 \
    && cmake -S /tmp/bento4 -B /tmp/bento4/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/bento4/build --target mp4decrypt -j$(nproc) \
    && cp /tmp/bento4/build/mp4decrypt /usr/local/bin/mp4decrypt \
    && chmod +x /usr/local/bin/mp4decrypt \
    && rm -rf /tmp/bento4 \
    && apt-get remove -y cmake g++ make git \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/app.js"]
