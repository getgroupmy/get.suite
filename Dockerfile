ARG NODE_IMAGE=node:22-alpine
# ---- build the web app ----
FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- runtime ----
FROM ${NODE_IMAGE}
# Fonts for PDFs with text beyond Western European letters (Greek, Cyrillic, Chinese, Japanese, Korean, Thai, Tamil,
# Hindi…): drawn from these, cut down to what each PDF uses. TrueType outlines only (not CFF Noto CJK). Change the
# list with --build-arg PDF_FONTS="…"; a package this Alpine doesn't have is skipped, not a failed build.
ARG PDF_FONTS="font-dejavu font-wqy-zenhei font-noto-thai font-noto-tamil font-noto-devanagari"
RUN for p in $PDF_FONTS; do apk add --no-cache "$p" >/dev/null 2>&1 || echo "(no $p here: PDFs show ? for its script)"; done
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src ./src
COPY --from=web /web/dist /app/public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/index.js"]
