# 联想服务器 Laya CPU 服务

目标目录 `/home/yang/laya`，独立 Compose 项目 `laya`，API 为 `http://127.0.0.1:18080/v1/systemone`。仅使用 multilingual 322M，4 推理线程、同时接纳1个请求，限制4 CPU和6GiB内存。当前11jev已按用户后续授权接入此服务，接入与回滚说明见文末。

## 固定版本与依据

- PyPI `laya[serve]==0.4.15`；发布 wheel SHA256：`f51301738464677cb650159684537eb267de47d33f3db4d8897f1502a9570e6e`。
- 核对的上游源码提交：`7a77439b0923d6efe00052d50a7f787840bfce98`（2026-10-25）；实际安装对象为上述发布包。
- 模型仓库 `convaiinnovations/laya`，revision `7b928d828b7b0e022f929d9bd2e44165aa270148`，子目录 `multilingual`，仅下载5个文件。
- `torch==2.10.0+cpu` 来自 PyTorch CPU 索引；`transformers==5.0.0` 对应所固定 encoder 配置的 `transformers_version`，`huggingface-hub==1.3.5` 符合其 `>=1.3,<2` 要求。其余直接依赖见 `requirements.txt`。
- 镜像构建执行 `pip check` 并检查无 CUDA。完整传递依赖记录保存在 `/opt/laya/installed-packages.txt`；直接依赖已固定，传递依赖尚非独立锁文件。保留构建镜像及其 ID，后续复用同一镜像；重建前应比较实际依赖记录。
- 本次基础镜像：`docker.m.daocloud.io/library/python@sha256:d1e9ca7c4e78d1e8ecadb5d44bfc8e956e7a65b659a9950f569f243d72b326d0`。
- 基础镜像可使用远端已有 `python:3.11-slim` 的镜像名，通过 `.env` 的 `PYTHON_IMAGE` 指定；部署记录应补充实际 RepoDigest/镜像ID。

来源：[Laya源码](https://github.com/NandhaKishorM/laya)、[PyPI 0.4.15](https://pypi.org/project/laya/0.4.15/)、[固定模型](https://huggingface.co/convaiinnovations/laya/tree/7b928d828b7b0e022f929d9bd2e44165aa270148/multilingual)。已直接核对发布 wheel 中 `serve.py` 的 `build_router`、`create_app` 与 `/health`，`router.py` 的 `DEFAULT_MODELS`，以及 `agent.py` 的固定 revision 下载流程。

## 首次部署

以下命令在服务器 `/home/yang/laya` 执行。先确认该目录可用于本次部署，`18080` 没有监听，并记录已有容器状态。只上传本目录非敏感文件，不上传本机 `.env`、缓存或凭据。

```sh
cd /home/yang/laya
umask 077
mkdir -p secrets cache/huggingface
python3 - <<'PY'
import os
from pathlib import Path
import secrets
path = Path('secrets/api_key')
with path.open('x', encoding='utf-8') as output:
    output.write(secrets.token_urlsafe(48) + '\n')
path.chmod(0o600)
Path('.env').write_text(f'LAYA_UID={os.getuid()}\nLAYA_GID={os.getgid()}\nPYTHON_IMAGE=python:3.11-slim\n', encoding='utf-8')
PY
```

密钥使用排他创建；已有文件时先判断是否属于此次部署，勿覆盖。密钥不进入命令行参数、Git或工具输出。容器通过宿主 yang 的 UID/GID 读取0600文件，缓存也归该用户所有。Compose 同时设置 `USER=laya`、`HOME=/cache` 与 `TORCHINDUCTOR_CACHE_DIR=/cache/torchinductor`，避免数字 UID 未注册于容器 passwd 时 PyTorch 的 getpass 查询失败。不要使用 `cat secrets/api_key` 或输出容器完整环境。

模型先通过主机已有出站代理下载；无需改变现有代理或网络服务：

```sh
python3 prefetch.py --proxy socks5h://127.0.0.1:10808
docker compose config --quiet
docker compose build laya
docker compose up -d --wait --wait-timeout 600 laya
docker compose ps
```

直连可用时省略 `--proxy`。缓存位于 `cache/huggingface/`；下载清单及SHA256在 `download-manifest.json`，部署记录保留此清单。构建依赖走远端既有网络；构建容器内 `127.0.0.1` 并非宿主代理地址，不能直接套用同一个代理URL。若基础镜像需复用已有镜像，先修改 `.env` 的非敏感 `PYTHON_IMAGE`。

运行时启用 `HF_HUB_OFFLINE=1`，只使用已下载的固定 snapshot，不会在线下载其他 checkpoint。`LAYA_MODELS` 是预加载列表而非白名单；客户端每个请求仍必须显式传 `"model":"multilingual"`。请求其他模型会因缺少离线缓存而失败，不应把这类请求当作正确用法。

`LAYA_API_KEY_FILE` 由本目录 `entrypoint.py` 读入进程内的 `LAYA_API_KEY` 后替换为上游 `laya-serve`；缺少或无效密钥时拒绝启动。上游 `serve.py` 不直接读取 `_FILE`，不可绕过此入口。

## 真实验收与记录

```sh
python3 verify.py > results-before-restart.json
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' "$(docker compose ps -q laya)"
docker compose restart laya
docker compose up -d --wait --wait-timeout 600 laya
python3 verify.py > results-after-restart.json
docker compose ps
docker compose images
docker compose exec -T laya cat /opt/laya/installed-packages.txt > installed-packages.txt
```

验收脚本从文件读取密钥，仅用于 Header；分别验证无密钥和错误密钥的401、预加载模型名称及revision、CPU设备、暖机后6条中文真实请求。三种样例涵盖匹配、不匹配和缺信息，检查 `answers.need` 的 `choice`、完整三态有限概率及概率和、`usage`。输出实际结果、参考答案一致性及最小/中位/最大耗时；参考答案不一致会被记录，但不会被伪装为协议错误或修改模型输出。少量样例不能证明准确率、置信度校准或与 Jev 等效。

健康探针只验证进程，不能代替真实推理。重启前后均须运行验收；失败时看脚本JSON和服务状态，不输出 Header、完整环境或密钥文件。资源采样尽量在暖机后及推理过程中各记录一次，并与部署前已有容器状态比较。6GiB是初始资源上限，若发生OOM，记录结果后仅停止本服务，调整预算需由主会话评估。

## 运维与回滚

```sh
cd /home/yang/laya
docker compose ps
docker compose logs --tail 100 laya
docker compose stop laya
docker compose up -d --wait --wait-timeout 600 laya
```

日志默认不含请求体和鉴权 Header；查日志时不要开启调试输出或手动记录密钥。自动重启策略为 `unless-stopped`；Docker守护进程需由服务器现有开机服务管理。需要回滚时仅执行 `docker compose stop laya`，保留缓存与配置，不执行删卷、全局清理或停止其他项目。模型服务的停止回滚与11jev提供商回滚是两步；当前已接入11jev时应先按文末恢复应用提供商。0.8业务阈值保持不变。

## 2026-10-25 联想服务器实测

已部署 Laya 0.4.15，CPU 推理，固定上述 multilingual revision。镜像ID：`sha256:a0cab7fa03ab6d0ec7b1868dcc42fc46de653362c04503f5b42eca61eda88fac`。暖机后约129输入Token、1个三态问题的保存的重启前6次耗时为202–269ms，中位数225ms；空闲暖机后内存约2.14GiB（Docker stats）。这些结果只代表短样例，不代表真实多需求长线报吞吐。

**模型效果未达到生产筛选要求。** 3个不同样例中只有79元耳机符合参考标签；299元超预算、缺价格/成色均误判 matched（各重复两次）。匹配概率分别约0.6013、0.7186、0.6474，均未达到现有11jev的0.8确认门槛。初次验收只完成独立部署；用户后续明确授权接入后已切换，仍不将服务可用描述为业务准确率达标。

## 已接入当前 11jev（用户后续授权）

2026-10-25 用户明确要求配置到当前11jev，已通过其正常管理员登录和设置API完成：baseUrl=`http://127.0.0.1:18080`、model=`multilingual`、concurrency=1；Key池仅启用“Laya 本地多语言”，原有1个Key保持禁用且保留。保留 timeoutMs=20000、jobsPerRound=10、evaluationMode=batch_gate，其余业务策略与0.8门槛不变。

运行文件 `/home/yang/apps/11jev/compose.lenovo.yml` 使用 `runtime.conf`。因为专用 `JEV_PROXY_URL` 对回环地址也生效，已在备份后仅清空该应用变量，并重建web/worker，使两进程直连本机模型；代理服务本身未修改。

正常登录API使用容器既有管理员环境，Laya密钥由远端文件经docker exec标准输入送入内存，未打印或下载。连接测试成功；对1个现有需求的dry-run成功返回not_matched、error=null。后台心跳已恢复。状态页整体processingHealthy仍为false，当前有176个dead任务；近期历史错误包含旧Key不可用，worker最近错误另有飞书限流，未重置历史任务或通知配置。

回滚材料只在远端：`/home/yang/laya/11jev-before-switch.json` 保存原基础配置及Key启用状态；`runtime-before-laya.conf` 保存原运行配置（含敏感项，0600，仅远端保留，不能上传到Git）。恢复时暂停worker，先通过设置API恢复原地址/模型/并发及原Key状态，再恢复原专用代理配置并重建web/worker；不得直接把云端Key与Laya地址混用。
