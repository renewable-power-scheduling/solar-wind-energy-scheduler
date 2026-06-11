FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask==3.0.3

# App
COPY email_work/app.py ./app.py
COPY email_work/index.html ./index.html

# Canonical scheduler data used by the dashboard metadata endpoint.
COPY data/email_scheduler/scheduler_data.db ./scheduler_data.db
COPY data/email_scheduler/mail_templates.json ./mail_templates.json

EXPOSE 5000

CMD ["python", "app.py"]
