FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PORT=3000

# No external Python dependencies - server.py uses only the standard library.

COPY . .

# BotHost mounts /app/data as a persistent volume at runtime. Preserve the
# image's catalog files outside that mount so legacy/empty volumes can fall
# back to the shipped game content.
RUN mkdir -p /app/default_data && \
    cp /app/data/config.json /app/data/backgrounds.json /app/data/cases.json /app/data/tasks.json /app/default_data/

EXPOSE 3000

CMD ["python", "server.py"]
