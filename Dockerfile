FROM node:22

WORKDIR /app

RUN apt-get update && \
    apt-get install -y moreutils

COPY package*.json ./

RUN npm install

COPY . .

CMD ["node", "server.js"]
