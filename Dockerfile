# Imagem oficial do Playwright (Ubuntu Jammy) — já traz Chromium + todas as
# libs de sistema necessárias para rodar o browser headless (scraping do Carbon).
# Versão fixada na mesma do pacote npm "playwright" (1.60.0).
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Timezone
RUN ln -snf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime \
 && echo "America/Sao_Paulo" > /etc/timezone

ENV TZ=America/Sao_Paulo

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
