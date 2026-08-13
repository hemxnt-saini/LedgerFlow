# Build the static bundle, then serve it from nginx. The runtime image carries
# no Node and no source - just the compiled assets and a web server.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Where the browser should send API calls.
#
# Empty defaults keep local development working: config.ts falls back to
# http://<hostname>:4000 and :4001, which is right when the services are port
# -mapped on your machine.
#
# Behind a single HTTPS domain those defaults are wrong twice over - the ports
# are not exposed, and a page served over HTTPS is not allowed to call HTTP at
# all. Production builds pass /api/write and /api/read so every request is
# same-origin and the reverse proxy routes it.
ARG VITE_WRITE_URL=""
ARG VITE_READ_URL=""
ENV VITE_WRITE_URL=$VITE_WRITE_URL
ENV VITE_READ_URL=$VITE_READ_URL

COPY tsconfig.json vite.config.ts index.html ./
# public/ holds the favicon. Vite copies it into dist at build time, and
# leaving it out of the image meant the built site had no icon - nginx's SPA
# fallback then served index.html for /favicon.svg, which returns 200 and
# looks fine until you check the content type.
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
