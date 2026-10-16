import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  MAX_REGEX_COMMAND_INPUT,
  MAX_REGEX_TEXT_LENGTH,
  REGEX_COMMAND_TIMEOUT_MS,
  REGEX_IDLE_WAIT_MS,
  REGEX_READY_TIMEOUT_MS,
} from "@/lib/domain/constants";

/**
 * 全局正则执行线程的父侧管理器。
 *
 * - 固定 `matcher.mjs` 线程入口，`execArgv: []`；规则与文本通过消息传入；
 * - 一个 runner 实例最多一个活跃线程，命令串行，避免堆叠线程；
 * - 启动到显式 `ready`、单命令编译+匹配都有预算；超时先结算 fallback 再终止线程；
 * - 语法/执行/协议/资源异常一律 fallback（绝不当作 filtered）；
 * - 线程无法退出时进入 disabled，后续正则执行直接回退逐条。
 *
 * 该 runner 既可注入（测试用 fake），也可由后台进程与保存预检复用。
 */

export type RegexValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export type RegexMatchOutcome =
  | { ok: true; matched: true; matchedRuleIndex: number }
  | { ok: true; matched: false; matchedRuleIndex: null }
  | { ok: false; fallback: true; error: string };

export interface RegexRunner {
  validate(rules: readonly string[]): Promise<RegexValidationResult>;
  match(rules: readonly string[], text: string): Promise<RegexMatchOutcome>;
  dispose(): void;
}

interface WorkerMessage {
  id?: string;
  type?: string;
  error?: string;
  matched?: boolean;
  matchedRuleIndex?: number | null;
}

class RegexUnavailableError extends Error {}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 定位固定线程入口。
 *
 * 优先 `import.meta.url` 相邻路径（`tsx` 后台进程与源码运行，
 * 即 `src/lib/regex/matcher.mjs`），其次项目根的同一文件（Next 打包后的
 * route handler，容器运行时保留完整 `src/`）。
 */
export function resolveMatcherPath(): string {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("../regex/matcher.mjs", import.meta.url)));
  } catch {
    // import.meta.url 在非常规打包环境下可能不可用，忽略该候选。
  }
  candidates.push(path.join(process.cwd(), "src/lib/regex/matcher.mjs"));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  return candidates[candidates.length - 1];
}

class WorkerRegexRunner implements RegexRunner {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private pending = new Map<string, (message: WorkerMessage) => void>();
  private disabledReason: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private fail(reason: string): void {
    this.disabledReason = reason;
    for (const resolve of this.pending.values()) {
      resolve({ type: "error", error: reason });
    }
    this.pending.clear();
  }

  private ensureWorker(): Promise<boolean> {
    if (this.disabledReason) return Promise.resolve(false);
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let worker: Worker;
      try {
        worker = new Worker(resolveMatcherPath(), {
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: 32,
            maxYoungGenerationSizeMb: 8,
            stackSizeMb: 4,
          },
        });
      } catch (error) {
        this.fail(`正则线程无法启动：${describeError(error)}`);
        settle(false);
        return;
      }
      this.worker = worker;
      const timer = setTimeout(() => {
        this.fail("正则线程启动超时");
        settle(false);
      }, REGEX_READY_TIMEOUT_MS);

      worker.on("message", (message: WorkerMessage) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          settle(true);
          return;
        }
        const id = message?.id;
        const resolvePending = id ? this.pending.get(id) : undefined;
        if (id && resolvePending) {
          this.pending.delete(id);
          resolvePending(message);
        }
      });
      worker.on("error", (error) => {
        clearTimeout(timer);
        this.fail(`正则线程异常：${describeError(error)}`);
        settle(false);
      });
      worker.on("exit", () => {
        clearTimeout(timer);
        this.worker = null;
        this.ready = null;
        settle(false);
      });
    });
    return this.ready;
  }

  private async send(
    message: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<WorkerMessage> {
    const ready = await this.ensureWorker();
    if (!ready || !this.worker) {
      throw new RegexUnavailableError(this.disabledReason ?? "正则线程不可用");
    }
    const worker = this.worker;
    const id = randomUUID();
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RegexUnavailableError("正则命令执行超时"));
      }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      worker.postMessage({ id, ...message });
    });
  }

  /**
   * 终止当前线程并等待其退出（最多 `REGEX_IDLE_WAIT_MS`）。
   * `terminate()` 失败时进入 disabled，后续正则执行全部回退逐条。
   */
  private async kill(reason: string): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (!worker) return;
    await delay(REGEX_IDLE_WAIT_MS);
    try {
      await worker.terminate();
    } catch (error) {
      this.fail(`${reason}，且线程无法退出：${describeError(error)}`);
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  validate(rules: readonly string[]): Promise<RegexValidationResult> {
    return this.runExclusive(async () => {
      if (this.disabledReason) {
        return { ok: false, error: this.disabledReason };
      }
      try {
        const response = await this.send(
          { type: "validate", rules: [...rules] },
          REGEX_COMMAND_TIMEOUT_MS,
        );
        if (response.type === "ok") return { ok: true };
        return { ok: false, error: response.error ?? "正则校验失败" };
      } catch (error) {
        await this.kill("正则校验执行异常");
        return { ok: false, error: describeError(error) };
      }
    });
  }

  match(rules: readonly string[], text: string): Promise<RegexMatchOutcome> {
    return this.runExclusive(async () => {
      if (text.length > MAX_REGEX_TEXT_LENGTH) {
        return {
          ok: false,
          fallback: true,
          error: `待匹配文本超过 ${MAX_REGEX_TEXT_LENGTH} 单元上限`,
        };
      }
      const inputLength = text.length + rules.reduce((sum, rule) => sum + rule.length, 0);
      if (inputLength > MAX_REGEX_COMMAND_INPUT) {
        return {
          ok: false,
          fallback: true,
          error: `正则命令输入超过 ${MAX_REGEX_COMMAND_INPUT} 单元上限`,
        };
      }
      if (this.disabledReason) {
        return { ok: false, fallback: true, error: this.disabledReason };
      }
      try {
        const response = await this.send(
          { type: "match", rules: [...rules], text },
          REGEX_COMMAND_TIMEOUT_MS,
        );
        if (response.type !== "ok") {
          await this.kill("正则匹配返回错误");
          return {
            ok: false,
            fallback: true,
            error: response.error ?? "正则匹配失败",
          };
        }
        if (response.matched) {
          return {
            ok: true,
            matched: true,
            matchedRuleIndex: response.matchedRuleIndex ?? 0,
          };
        }
        return { ok: true, matched: false, matchedRuleIndex: null };
      } catch (error) {
        await this.kill("正则匹配执行异常");
        return { ok: false, fallback: true, error: describeError(error) };
      }
    });
  }

  dispose(): void {
    void this.kill("正则线程已释放");
  }
}

/** 创建一个独立 runner（保存预检等一次性场景）。 */
export function createRegexRunner(): RegexRunner {
  return new WorkerRegexRunner();
}

let shared: RegexRunner | null = null;

/** 后台进程复用的单例 runner（最多一个活跃线程）。 */
export function getSharedRegexRunner(): RegexRunner {
  if (!shared) shared = new WorkerRegexRunner();
  return shared;
}

/** 进程退出时释放共享线程。 */
export function disposeSharedRegexRunner(): void {
  shared?.dispose();
  shared = null;
}
