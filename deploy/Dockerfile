# Build from the repo root:  docker build -f deploy/Dockerfile -t pitboss .
# web/data/data.json is committed, so the image needs no dataset. Keys are passed at run time
# with --env-file .env and are never copied into the image (see .dockerignore).
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir fastapi==0.162.2 "uvicorn[standard]==0.54.0" httpx==0.28.1 pymongo "psycopg[binary]"
COPY server ./server
COPY web ./web
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn server.app:app --host 0.0.0.0 --port ${PORT}"]
