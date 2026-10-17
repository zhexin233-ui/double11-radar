"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, PasswordInput } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { Feedback } from "@/components/ui/Feedback";

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
    <main className="auth-main">
      <div className="auth-card stack">
        <div>
          <h1>管理员登录</h1>
          <p className="muted">使用部署时配置的 ADMIN_PASSWORD 登录。</p>
        </div>
        <form className="stack" onSubmit={submit}>
          <PasswordInput
            id="password"
            label="密码"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
          />
          {error ? <Feedback kind="error">{error}</Feedback> : null}
          <Button type="submit" loading={busy}>
            登录
          </Button>
        </form>
      </div>
    </main>
  );
}
