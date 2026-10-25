"""读取文件密钥后启动上游服务，不将密钥放进命令行或日志。"""

import os
from pathlib import Path
import sys


def main():
    filename = os.environ.pop("LAYA_API_KEY_FILE", "")
    try:
        value = Path(filename).read_text(encoding="utf-8-sig").strip() if filename else ""
    except (OSError, UnicodeError, ValueError):
        sys.exit("无法读取 Laya 密钥文件")
    if not value or any(character.isspace() for character in value) or "\0" in value:
        sys.exit("Laya 密钥文件为空或格式无效")
    os.environ["LAYA_API_KEY"] = value
    if len(sys.argv) < 2:
        sys.exit("缺少服务启动命令")
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
