"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, PasswordInput } from "@mantine/core";
import { apiSend, errorMessage } from "@/components/api-client";
import { Feedback } from "@/components/ui/Feedback";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandMarkIcon } from "@/components/ui/Icons";

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
      <div className="auth-corner">
        <ThemeToggle variant="compact" />
      </div>

      <div className="auth-card stack">
        <div>
          <div className="auth-brand">
            <span className="brand-mark" aria-hidden="true">
              <BrandMarkIcon />
            </span>
            <span className="brand-text">
              <span className="brand-title">线报需求匹配</span>
              <span className="brand-sub">LOCAL MONITOR</span>
            </span>
          </div>
          <h1>管理员登录</h1>
          <p className="auth-subtitle">使用部署时配置的 ADMIN_PASSWORD 登录。</p>
        </div>

        <form className="stack" onSubmit={submit}>
          <PasswordInput
            id="password"
            label="管理密码"
            placeholder="请输入部署密码"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
          />
          {error ? <Feedback kind="error">{error}</Feedback> : null}
          <Button type="submit" fullWidth loading={busy}>
            进入控制台
          </Button>
        </form>
      </div>

      <p className="auth-footer">本地自托管 · 线报语义匹配与推送服务</p>
    </main>
  );
}
