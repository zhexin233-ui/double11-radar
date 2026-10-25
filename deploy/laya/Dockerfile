ARG PYTHON_IMAGE=python:3.11-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    USE_TF=0 \
    USE_TORCH=1 \
    TOKENIZERS_PARALLELISM=false \
    TORCH_DISABLE_NATIVE_JIT=1 \
    HF_HOME=/cache/huggingface

WORKDIR /opt/laya
COPY requirements.txt ./
RUN python -m pip install 'torch==2.10.0+cpu' --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install -r requirements.txt \
    && python -m pip check \
    && python -c "import torch; assert torch.version.cuda is None; assert torch.__version__ == '2.10.0+cpu'" \
    && python -m pip freeze > /opt/laya/installed-packages.txt

COPY entrypoint.py ./
ENTRYPOINT ["python", "/opt/laya/entrypoint.py"]
CMD ["laya-serve"]
