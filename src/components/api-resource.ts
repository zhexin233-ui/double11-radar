/**
 * 受保护资源的加载编排（不依赖 React，便于离线单测竞态语义）。
 *
 * 解决的问题（见任务 design.md 第 8 节 / AC8）：
 * - 定时刷新在**同查询请求在途时跳过**，不叠加请求；
 * - 手动刷新/写入后刷新必须保证「在本次调用之后至少启动一次新请求」，
 *   在途时排一次尾随刷新并等待它，而不是只合并到保存前的旧 GET；
 * - 旧 generation 的响应一律不提交，避免慢响应/切换筛选后旧数据覆盖新结果；
 * - 路径变更或卸载时中止在途请求并停止后续提交。
 */

export interface ResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export interface ApiResourceControllerDeps<T> {
  /** 执行一次请求；必须响应 `signal` 以便中止。 */
  fetchOnce: (signal: AbortSignal) => Promise<T>;
  /** 提交状态补丁。 */
  onState: (patch: Partial<ResourceState<T>>) => void;
  /** 把异常转成展示用文案；缺省用 `String(error)`。 */
  errorMessage?: (error: unknown) => string;
}

export class ApiResourceController<T> {
  private generation = 0;
  private inFlight: Promise<void> | null = null;
  private abortCurrent: AbortController | null = null;
  private trailingWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly deps: ApiResourceControllerDeps<T>) {}

  /**
   * 首次加载或路径变更：清空旧查询的数据（新查询绝不能展示旧结果），
   * 中止在途请求并立即发起一次新请求。
   */
  load(): Promise<void> {
    // StrictMode 下会有「卸载→重新挂载」，这里允许复活，避免开发环境永久卡在未加载状态。
    this.disposed = false;
    this.deps.onState({ data: null, error: null, loading: true });
    this.abortInFlight();
    return this.start();
  }

  /**
   * 定时 tick：同查询在途时本次 tick 直接丢弃（不叠加、不排队），
   * 返回已在途后立即解析，不阻塞下一次定时。
   */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return Promise.resolve();
    return this.start();
  }

  /**
   * 手动刷新 / 写入后刷新：保证在本次调用之后至少启动一次新请求。
   * 已有在途请求时，先作废其响应，再排队一次尾随刷新（不并发叠加）。
   */
  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.inFlight) return this.start();
    // 让在途响应过期：它可能比本次 reload 更早开始，不能代表最新数据。
    this.generation += 1;
    return new Promise<void>((resolve) => {
      this.trailingWaiters.push(resolve);
    });
  }

  /** 卸载：中止在途请求、停止提交，并释放等待中的 reload。 */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abortInFlight();
    this.flushTrailing();
  }

  private abortInFlight(): void {
    if (this.abortCurrent) {
      this.abortCurrent.abort();
      this.abortCurrent = null;
    }
  }

  private start(): Promise<void> {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortCurrent = controller;
    const promise = this.run(generation, controller.signal).finally(() => {
      if (this.inFlight === promise) {
        this.inFlight = null;
        this.abortCurrent = null;
      }
      this.flushTrailing();
    });
    this.inFlight = promise;
    return promise;
  }

  /** 在途请求结束后，若有排队的 reload，串行启动一次尾随刷新并唤醒等待者。 */
  private flushTrailing(): void {
    if (this.trailingWaiters.length === 0) return;
    if (this.disposed) {
      const waiters = this.trailingWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
      return;
    }
    if (this.inFlight) return;
    const waiters = this.trailingWaiters.splice(0);
    void this.start().then(
      () => waiters.forEach((resolve) => resolve()),
      () => waiters.forEach((resolve) => resolve()),
    );
  }

  private async run(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.deps.fetchOnce(signal);
      if (!this.shouldCommit(generation, signal)) return;
      this.deps.onState({ data: result, error: null, loading: false });
    } catch (error) {
      if (!this.shouldCommit(generation, signal)) return;
      const message = this.deps.errorMessage
        ? this.deps.errorMessage(error)
        : String(error);
      // 同查询刷新失败保留既有列表；只有新查询（load）才会先清空数据。
      this.deps.onState({ error: message, loading: false });
    }
  }

  private shouldCommit(generation: number, signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && generation === this.generation;
  }
}
