import { execFileSync, spawnSync } from "node:child_process";

// 使用 Git 自己的忽略规则，不维护第二份容易失步的黑名单。
const [mode = "--staged", revision = "HEAD"] = process.argv.slice(2);
if (mode !== "--staged" && mode !== "--history") {
  console.error("用法：node scripts/check-private-files.mjs [--staged | --history 提交哈希]");
  process.exit(2);
}

const output = execFileSync(
  "git",
  mode === "--history"
    ? ["log", "-m", "--full-history", "--root", "--format=", "--name-only", "--no-renames", "-z", revision, "--"]
    : ["ls-files", "--cached", "-z"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const paths = [...new Set(output.split("\0").filter(Boolean))];
if (!paths.length) process.exit(0);

const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
  input: `${paths.join("\0")}\0`,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (result.error || (result.status !== 0 && result.status !== 1)) {
  console.error("无法完成 Git 私有文件检查，已阻止操作。");
  process.exit(2);
}
const blocked = result.stdout.split("\0").filter(Boolean);
if (blocked.length) {
  console.error("已阻止操作：以下文件被 Git 忽略规则列为本地资料，不得提交或推送：");
  for (const path of blocked) console.error(`  ${JSON.stringify(path)}`);
  console.error("请从 Git 索引或待推送历史中移除，保留本地文件；不要使用 --no-verify 绕过。");
  process.exit(1);
}
