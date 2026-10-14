"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiSend, errorMessage } from "@/components/api-client";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend("/api/auth/login", "POST", { password });
      router.push("/status");
      router.refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>管理员登录</h1>
      <p className="muted">使用部署时配置的 ADMIN_PASSWORD 登录。</p>
      <form className="card stack" onSubmit={submit}>
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
