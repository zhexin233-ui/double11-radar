# Git 私有文件保护

`.gitignore` 是文件路径黑名单的唯一来源：私有开发上下文、本地部署资料、环境凭据、数据库、证书私钥及本地备份不应提交。`.env.example` 等示例配置可以提交，但只能使用占位值。

每个新克隆需要启用本仓库的检查钩子：

```sh
git config --local core.hooksPath .githooks
```

- `pre-commit` 检查索引，拦截通过 `git add -f` 加入的被忽略文件。
- `pre-push` 检查实际推送提交的全部祖先，包括合并提交；私有文件即使后来删除，也会被拦截。
- 检查失败时保留本地文件，移除索引或清理待推送历史；不要使用 `--no-verify` 绕过。

可以手动检查：

```sh
node scripts/check-private-files.mjs --staged
node scripts/check-private-files.mjs --history HEAD
```

该检查基于文件路径，不是任意源码中的密钥扫描器。不得在普通源码、测试、提交信息或示例配置中写入真实凭据。`.gitignore` 也不会自动移除已经跟踪的文件或清除旧历史。
