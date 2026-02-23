FROM node:20-slim

# Instalar ffmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código
COPY . .

# Crear directorios de storage
RUN mkdir -p storage/db storage/audio

EXPOSE 3000

CMD ["node", "backend/server.js"]
