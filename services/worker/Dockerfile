# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODEL_DIR=/models \
    WHISPER_MODEL=tiny.en \
    HF_HUB_OFFLINE=1

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

# Bake the Whisper model (~75 MB) into the image so pods start without
# reaching Hugging Face and every replica runs the exact same weights.
RUN HF_HUB_OFFLINE=0 python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8', download_root='${MODEL_DIR}')" \
 && chmod -R a+rX ${MODEL_DIR}

COPY worker ./worker

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
USER 10001

EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/healthz', timeout=2)" || exit 1

CMD ["python", "-m", "worker.main"]
