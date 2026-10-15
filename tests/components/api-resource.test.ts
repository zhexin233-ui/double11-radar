import { describe, expect, it } from "vitest";
import {
  ApiResourceController,
  type ResourceState,
} from "@/components/api-resource";

/**
 * 加载控制器的竞态语义（AC8）。
 *
 * 这里不依赖 DOM/React：控制器不导入 React，只从注入的 `fetchOnce` 取数并提交状态，
 * 因此可以在 node 环境离线、确定性地验证「跳过重叠 tick、写入后尾随刷新、
 * 旧 generation 不覆盖新查询、路径变更中止、卸载清理」。
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness<T>() {
  const state: ResourceState<T> = { data: null, error: null, loading: true };
  const patches: Array<Partial<ResourceState<T>>> = [];
  const calls: Array<{
    signal: AbortSignal;
    deferred: Deferred<T>;
  }> = [];
  const controller = new ApiResourceController<T>({
    fetchOnce: (signal) => {
      const pending = deferred<T>();
      calls.push({ signal, deferred: pending });
      return pending.promise;
    },
    onState: (patch) => {
      patches.push(patch);
      Object.assign(state, patch);
    },
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { controller, state, patches, calls };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ApiResourceController（AC8：轮询与刷新的竞态）", () => {
  it("load 清空旧数据并立即发起一次新请求", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();
    expect(harness.calls).toHaveLength(1);
    expect(harness.state.loading).toBe(true);
    expect(harness.state.data).toBeNull();

    harness.calls[0].deferred.resolve("第一页");
    await load;
    expect(harness.state.data).toBe("第一页");
    expect(harness.state.loading).toBe(false);
  });

  it("定时 tick 在同查询请求在途时跳过，不叠加、不排队", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();
    expect(harness.calls).toHaveLength(1);

    // 在途时连续两次 tick：都必须被跳过。
    await harness.controller.refresh();
    await harness.controller.refresh();
    expect(harness.calls).toHaveLength(1);

    harness.calls[0].deferred.resolve("完成");
    await load;

    // 在途结束后再 tick 才发起新请求。
    void harness.controller.refresh();
    expect(harness.calls).toHaveLength(2);
  });

  it("写入后的 reload 会排一次尾随刷新，且旧请求的响应不提交（不串数据）", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();

    // 旧 GET 仍在途时触发 reload（模拟保存配置后刷新）。
    const reloaded = harness.controller.reload();
    expect(harness.calls).toHaveLength(1); // 不并发叠加

    harness.calls[0].deferred.resolve("保存前的旧数据");
    await load;
    await tick();

    // 旧响应被丢弃；尾随刷新已启动。
    expect(harness.state.data).toBeNull();
    expect(harness.calls).toHaveLength(2);

    harness.calls[1].deferred.resolve("保存后的新数据");
    await reloaded;
    expect(harness.state.data).toBe("保存后的新数据");
  });

  it("多次 reload 只合并为一次尾随刷新，且都等到新数据", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();
    const first = harness.controller.reload();
    const second = harness.controller.reload();

    harness.calls[0].deferred.resolve("旧");
    await load;
    await tick();
    expect(harness.calls).toHaveLength(2);

    harness.calls[1].deferred.resolve("新");
    await Promise.all([first, second]);
    expect(harness.state.data).toBe("新");
  });

  it("路径变更中止旧请求，旧响应不覆盖新查询", async () => {
    const harness = createHarness<string>();
    const oldLoad = harness.controller.load();
    const oldCall = harness.calls[0];

    // 模拟 path 变化：同一控制器上重新 load（页面里由 useMemo 换新控制器，
    // 这里直接验证「旧 generation 不提交」的保护）。
    const newLoad = harness.controller.load();
    expect(oldCall.signal.aborted).toBe(true);
    expect(harness.calls).toHaveLength(2);

    oldCall.deferred.resolve("旧筛选的数据");
    await oldLoad;
    expect(harness.state.data).toBeNull();

    harness.calls[1].deferred.resolve("新筛选的数据");
    await newLoad;
    expect(harness.state.data).toBe("新筛选的数据");
  });

  it("刷新失败保留既有列表并显示错误，不丢数据", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();
    harness.calls[0].deferred.resolve("列表");
    await load;
    expect(harness.state.data).toBe("列表");

    void harness.controller.refresh();
    harness.calls[1].deferred.reject(new Error("网络错误"));
    await tick();
    expect(harness.state.data).toBe("列表");
    expect(harness.state.error).toBe("网络错误");
  });

  it("dispose 后中止在途请求并释放等待中的 reload", async () => {
    const harness = createHarness<string>();
    const load = harness.controller.load();
    const reloaded = harness.controller.reload();
    harness.controller.dispose();

    expect(harness.calls[0].signal.aborted).toBe(true);
    await reloaded;
    harness.calls[0].deferred.resolve("迟到的旧数据");
    await load;
    expect(harness.state.data).toBeNull();
  });
});
