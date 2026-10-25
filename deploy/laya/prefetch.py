"""在主机预下载固定 revision 的五个文件，供容器完全离线加载。"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148"
FILES = (
    "multilingual/encoder/config.json",
    "multilingual/model.safetensors",
    "multilingual/rl_agent_config.json",
    "multilingual/tokenizer/tokenizer.json",
    "multilingual/tokenizer/tokenizer_config.json",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=Path("cache/huggingface"))
    parser.add_argument("--proxy", help="已有下载代理，例如 socks5h://127.0.0.1:10808")
    args = parser.parse_args()
    snapshot = args.cache / "hub/models--convaiinnovations--laya/snapshots" / REVISION
    records = []
    for filename in FILES:
        target = snapshot / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".part")
        command = ["curl", "--fail", "--location", "--silent", "--show-error",
                   "--retry", "3", "--connect-timeout", "30", "--max-time", "1800"]
        if args.proxy:
            command.extend(["--proxy", args.proxy])
        command.extend(["--output", str(temporary),
                        f"https://huggingface.co/convaiinnovations/laya/resolve/{REVISION}/{filename}"])
        subprocess.run(command, check=True)
        temporary.replace(target)
        digest = hashlib.sha256()
        with target.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        record = {"file": filename, "bytes": target.stat().st_size, "sha256": digest.hexdigest()}
        records.append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
    manifest = {"repository": "convaiinnovations/laya", "revision": REVISION, "files": records}
    (args.cache / "download-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
