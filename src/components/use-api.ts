"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, errorMessage } from "@/components/api-client";
import {
  ApiResourceController,
  type ResourceState,
} from "@/components/api-resource";

/**
 * 统一的管理页数据加载 hook。
 *
 * 这是唯一允许在 effect 内触发加载的地方：管理页需要在挂载后从受会话保护的
 * `/api/*` 读取数据，并可按固定间隔轮询。竞态语义（跳过重叠 tick、写入后尾随刷新、
 * 旧 generation 不覆盖新查询、路径变更中止）集中在 `api-resource.ts` 的控制器里，
 * 便于离线单测；本 hook 只负责把控制器接到 React 状态。
 */

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** 手动/写入后刷新：保证在调用之后至少发起一次新请求。 */
  reload: () => Promise<void>;
}

export function useApiResource<T>(
  path: string,
  options: { refreshMs?: number } = {},
): ApiResource<T> {
  const { refreshMs } = options;
  const [state, setState] = useState<ResourceState<T>>({
    data: null,
    error: null,
    loading: true,
  });

  // path 变化会重建控制器：新查询不会展示旧查询的数据。
  const controller = useMemo(
    () =>
      new ApiResourceController<T>({
        fetchOnce: (signal) => apiGet<T>(path, { signal }),
        onState: (patch) =>
          setState((previous) => ({ ...previous, ...patch })),
        errorMessage,
      }),
    [path],
  );

  const reload = useCallback(() => controller.reload(), [controller]);

  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      void controller.refresh();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [controller, refreshMs]);

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    reload,
  };
}
