FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install system dependencies needed by install.sh / runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        alsa-utils \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Pre-install Python dependencies so the container is ready for pytest
COPY requirements.txt requirements.txt
COPY requirements-dev.txt requirements-dev.txt
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements-dev.txt

CMD ["pytest", "-v", "--maxfail=1", "--disable-warnings"]
