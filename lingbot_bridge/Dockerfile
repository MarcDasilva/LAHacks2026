# GX10 = Grace Blackwell (ARM64 + Blackwell sm_100). Use NVIDIA NGC PyTorch
# for arm64-sbsa; the public pytorch.org cu128 wheels are x86_64 only.
# Tag pinned to a known-Blackwell-ready release; bump as newer NGC images ship.
FROM nvcr.io/nvidia/pytorch:25.01-py3

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        git git-lfs ffmpeg libgl1 libglib2.0-0 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && git lfs install

WORKDIR /opt/bridge

# Bridge deps first (cache-friendly).
COPY requirements.txt /opt/bridge/requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

# LingBot-Map source is fetched at build time so the image is self-contained.
# scripts/setup.sh on the host populates ./vendor/lingbot-map; we copy it in.
COPY vendor/lingbot-map /opt/lingbot-map
RUN if [ -f /opt/lingbot-map/pyproject.toml ] || [ -f /opt/lingbot-map/setup.py ]; then \
        pip install -e /opt/lingbot-map ; \
    else \
        echo "WARNING: vendor/lingbot-map missing — run scripts/setup.sh on host before docker build" ; \
        exit 1 ; \
    fi

# FlashInfer is optional — try the prebuilt wheel, fall back to SDPA at runtime.
RUN pip install flashinfer-python -i https://flashinfer.ai/whl/cu128/torch2.9/ \
    || echo "FlashInfer wheel unavailable on this arch — runner will use SDPA fallback"

COPY bridge /opt/bridge/bridge
COPY scripts /opt/bridge/scripts

EXPOSE 8001
CMD ["bash", "/opt/bridge/scripts/entrypoint.sh"]
