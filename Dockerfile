FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PORT=3000

# No external Python dependencies - server.py uses only the standard library.

COPY . .

EXPOSE 3000

CMD ["python", "server.py"]