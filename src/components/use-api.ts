"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, errorMessage } from "@/components/api-client";

/**
 * 统一的管理页数据加载 hook。
 *
 * 这是唯一允许在 effect 内触发 setState 的地方：管理页需要在挂载后从
 * 受会话保护的 `/api/*` 读取数据，并可按固定间隔轮询。
 * 通过把这段副作用集中在一个模块，页面本身不需要在 effect 内写 setState。
 */

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useApiResource<T>(
  path: string,
  options: { refreshMs?: number } = {},
): ApiResource<T> {
  const { refreshMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const result = await apiGet<T>(path);
      setData(result);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后加载受保护资源并按需轮询
    void reload();
    if (!refreshMs) return undefined;
    const timer = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(timer);
  }, [reload, refreshMs]);

  return { data, error, loading, reload };
}
