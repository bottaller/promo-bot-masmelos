# Imagen con Node (el bot) + Python (el motor de arqueo) juntos.
# Railway: apuntar el "Root Directory" a promo-bot/ y el Builder a Dockerfile.
FROM node:20-slim

# Python para el motor de arqueo (pandas/numpy/openpyxl vienen como wheels, no compilan).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias Node (capa cacheable).
COPY package*.json ./
RUN npm ci --omit=dev

# Dependencias Python del arqueo (capa cacheable).
COPY arqueo/requirements.txt ./arqueo/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r arqueo/requirements.txt

# Resto del código.
COPY . .

CMD ["node", "src/index.js"]
