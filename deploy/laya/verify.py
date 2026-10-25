"""验证鉴权、常驻模型和真实中文三态响应；只输出非敏感 JSON。"""

import argparse
import json
import math
from pathlib import Path
import statistics
import sys
import time
import urllib.error
import urllib.request

REVISION = "7b928d828b7b0e022f929d9bd2e44165aa270148"
CRITERIA = {
    "matched": "商品为全新无线蓝牙耳机，最终到手价不超过100元，满足需求。",
    "not_matched": "商品不是全新无线蓝牙耳机，或者最终到手价超过100元，明确不满足需求。",
    "uncertain": "信息不足，无法确定商品是否为全新无线蓝牙耳机或是否不超过100元。",
}
CASES = (
    ("匹配", "全新无线蓝牙耳机，包邮，最终到手价79元。", "matched"),
    ("不匹配", "全新无线蓝牙耳机，包邮，最终到手价299元。", "not_matched"),
    ("缺信息", "无线蓝牙耳机正在促销，具体价格和商品成色未公布。", "uncertain"),
)


class VerificationError(Exception):
    """仅携带本脚本生成的非敏感校验说明。"""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def validate_answer(body):
    require(isinstance(body, dict), "响应不是对象")
    answers = body.get("answers")
    require(isinstance(answers, dict), "缺少 answers")
    answer = answers.get("need")
    require(isinstance(answer, dict), "缺少 need 答案")
    require(answer.get("type") == "choice", "答案类型不是 choice")
    require(answer.get("choice") in CRITERIA, "choice 不是合法三态")
    probabilities = answer.get("probabilities")
    require(isinstance(probabilities, dict) and set(probabilities) == set(CRITERIA), "三态概率不完整")
    require(all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
                for value in probabilities.values()), "概率不是 [0,1] 内的有限数字")
    require(abs(sum(probabilities.values()) - 1) <= 0.001, "概率和不约等于1")
    usage = body.get("usage")
    require(isinstance(usage, dict), "缺少 usage")
    require(all(type(usage.get(name)) is int and usage[name] >= 0
                for name in ("input_tokens", "output_tokens")), "usage 格式无效")
    return {"choice": answer["choice"], "probabilities": probabilities, "usage": usage}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    parser.add_argument("--key-file", type=Path, default=Path("secrets/api_key"))
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    require(args.repeats > 0, "重复次数必须大于0")
    key = args.key_file.read_text(encoding="utf-8-sig").strip()
    require(bool(key), "密钥文件为空")
    # 回环请求不经过主机环境中的 HTTP 代理。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, token=None, payload=None):
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        encoded = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        req = urllib.request.Request(args.base_url.rstrip("/") + path, data=encoded, headers=headers)
        started = time.perf_counter()
        try:
            with opener.open(req, timeout=args.timeout) as response:
                return response.status, json.load(response), round((time.perf_counter() - started) * 1000, 2)
        except urllib.error.HTTPError as error:
            return error.code, None, round((time.perf_counter() - started) * 1000, 2)

    question = {"need": {"type": "choice", "instructions": "需求：购买全新无线蓝牙耳机，最终到手价不超过100元。仅依据信息判断。", "criteria": CRITERIA}}

    def payload(text):
        return {"model": "multilingual", "state": {"body": text}, "questions": question}

    denied = {}
    for label, token in (("无密钥", None), ("错误密钥", key + "-invalid")):
        status, _, _ = request("/v1/systemone", token, payload(CASES[0][1]))
        require(status == 401, label + "未返回401")
        denied[label] = status

    def health():
        status, body, _ = request("/health", key)
        require(status == 200 and isinstance(body, dict), "健康检查失败")
        require(body.get("loaded") == ["multilingual"], "常驻 checkpoint 不是仅 multilingual")
        require(body.get("revisions") == {"multilingual": REVISION}, "实际加载的模型 revision 不一致")
        require(body.get("device") == "cpu", "实际推理设备不是 CPU")
        return {name: body.get(name) for name in ("status", "loaded", "revisions", "device")}

    before = health()
    status, body, warmup_ms = request("/v1/systemone", key, payload(CASES[0][1]))
    require(status == 200, f"暖机请求失败，HTTP {status}")
    validate_answer(body)
    records = []
    for iteration in range(args.repeats):
        for label, text, expected in CASES:
            status, body, elapsed_ms = request("/v1/systemone", key, payload(text))
            require(status == 200, f"真实推理失败，HTTP {status}")
            result = validate_answer(body)
            records.append({"case": label, "iteration": iteration + 1, "reference_choice": expected,
                            "agrees_with_reference": result["choice"] == expected, "elapsed_ms": elapsed_ms, **result})
    elapsed = [record["elapsed_ms"] for record in records]
    print(json.dumps({"ok": True, "auth": denied, "health_before": before, "health_after": health(),
                      "warmup_ms": warmup_ms, "samples": records,
                      "latency_ms": {"min": min(elapsed), "median": statistics.median(elapsed), "max": max(elapsed)},
                      "note": "仅验证协议和实际响应；样例与参考答案一致与否不构成准确率或概率校准证明。"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except VerificationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
    except Exception:
        # 不回显异常对象，避免来自传输层或文件读取的异常包含敏感信息。
        print(json.dumps({"ok": False, "error": "验收失败，请检查健康状态、HTTP状态、模型版本和响应契约。"}, ensure_ascii=False))
        sys.exit(1)
