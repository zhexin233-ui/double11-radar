import { parentPort } from "node:worker_threads";

/**
 * 固定正则执行线程入口。
 *
 * 规则与文本通过消息传入，不使用用户提供的 eval，也不拼接用户代码。
 * 固定 `iu`（忽略大小写 + Unicode），没有 g/y，因此不依赖 lastIndex。
 * 只负责编译与匹配；超时、终止与回退由父线程的 RegexRunner 负责。
 */

if (!parentPort) {
  throw new Error("matcher.mjs 只能在 worker_threads 中运行");
}

const FLAGS = "iu";

/** @type {string | null} */
let cachedSignature = null;
/** @type {RegExp[]} */
let cachedRules = [];

function compile(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const signature = JSON.stringify(list);
  if (signature === cachedSignature) return cachedRules;
  const compiled = list.map((source) => new RegExp(source, FLAGS));
  cachedSignature = signature;
  cachedRules = compiled;
  return compiled;
}

parentPort.on("message", (message) => {
  const id = message && message.id;
  try {
    if (message && message.type === "validate") {
      compile(message.rules);
      parentPort.postMessage({ id, type: "ok" });
      return;
    }
    if (message && message.type === "match") {
      const rules = compile(message.rules);
      const text = String(message.text ?? "");
      let index = -1;
      for (let position = 0; position < rules.length; position += 1) {
        if (rules[position].test(text)) {
          index = position;
          break;
        }
      }
      parentPort.postMessage({
        id,
        type: "ok",
        matched: index >= 0,
        matchedRuleIndex: index >= 0 ? index : null,
      });
      return;
    }
    parentPort.postMessage({ id, type: "error", error: "未知的正则命令" });
  } catch (error) {
    parentPort.postMessage({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

parentPort.postMessage({ type: "ready" });
