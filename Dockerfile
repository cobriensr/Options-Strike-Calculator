# ---- Build stage ----
FROM node:24-alpine AS build

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN apk update && apk upgrade --no-cache && npm ci

# Copy source and build
COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:1.28-alpine-slim AS production

RUN apk update && apk upgrade --no-cache

# Copy custom nginx config for SPA routing
COPY --from=build /app/dist /usr/share/nginx/html

# SPA fallback: serve index.html for all routes
RUN printf 'server {\n\
    listen 80;\n\
    listen [::]:80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
\n\
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {\n\
        expires 1y;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
\n\
    gzip on;\n\
    gzip_types text/plain text/css application/json application/javascript text/xml;\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
