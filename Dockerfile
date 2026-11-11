# Render icin Arduino (UNO / Nano / Mega...) derleme sunucusu
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

# arduino-cli kurulumu
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh

ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/staging

# AVR cekirdegi + Servo kutuphanesi (imaj olusurken bir kez kurulur, derleme sirasinda internet gerekmez)
RUN arduino-cli core update-index \
 && arduino-cli core install arduino:avr \
 && arduino-cli lib update-index \
 && arduino-cli lib install "Servo"

# Senin kutuphane paketin (GitHub deposundaki libraries/library.zip ile ayni dosya)
COPY libraries/library.zip /tmp/library.zip
RUN mkdir -p "$ARDUINO_DIRECTORIES_USER/libraries" \
 && unzip -oq /tmp/library.zip -d "$ARDUINO_DIRECTORIES_USER/libraries/" \
 && rm /tmp/library.zip

WORKDIR /app
COPY package.json server.js ./

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
