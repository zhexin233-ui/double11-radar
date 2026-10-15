# 全站重构实施与验收记录

日期：2026-10-15。范围：登录 + 全部七个管理页面、共享导航与样式。

## 环境（隔离，不触碰生产）

- 独立数据目录：`/tmp/11jev-verify/data`（随机临时 SQLite），独立 `APP_ENCRYPTION_KEY`（`openssl rand -base64 32` 现场生成），
  `ADMIN_PASSWORD=verify-admin-pw`（临时口令，非真实凭据）。
- 独立端口 `3311`，**不启动 worker**；不读取仓库 `.env`、不使用生产凭据。
- 隔离运行的原因：主仓库 `.next` 被其它会话的 dev server 共用，且本机 Turbopack dev 的 HMR 握手失败导致客户端不 hydrate。
  因此把源码与 `node_modules`（APFS clone）复制到 `/tmp/11jev-app`，用**生产构建 + `next start`** 验收（与
  `implement.md` 要求的 `pnpm build` 一致）。
- 复现方式（验收脚本与截图运行于临时目录，按收尾决定已清理；下列步骤可在需要时重建）：
  1. `seed.ts`：迁移临时库并写入覆盖 normal/error 的夹具（6 条线报含长标题/长 URL、
     4 种判断状态 + baseline/pending、成功与失败投递、3 条需求、5 个频道含报错与撤下、
     2 个 Jev Key（启用 + 自动禁用）、已知/未知费用调用账本、Jev/推送配置与掩码凭据）。
     仅本地写入，`OFFICIAL_ORIGIN` 等均为离线常量，不发起外部调用。
     经 `pnpm tsx <file>` 在 `DATA_DIR` 指向的临时库上执行。
  2. `app.sh build/start`：把源码 rsync 到 `/tmp/11jev-app`（node_modules 用 APFS clone）构建并 `next start -p 3311`。
  3. `shots.py <label>`：Playwright 登录后按视口截图并度量整页横向溢出（`scrollWidth - clientWidth`）。
  4. `interactions.py`：交互/可访问性矩阵，输出 `interactions-report.json`。
- 下列 Playwright 片段即各脚本核心：

```python
# 登录（等待 hydration，避免原生表单提交）
page.goto(f"{BASE}/login", wait_until="networkidle")
page.wait_for_function("() => { const f=document.querySelector('form');"
                       " return !!f && Object.keys(f).some(k=>k.startsWith('__react')); }")
page.fill("#password", PASSWORD); page.click('button[type="submit"]')
page.wait_for_url(f"{BASE}/status")

# 整页横向溢出
page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")

# 离线响应替身（不发起真实调用）
page.route("**/api/settings/notify/test",
           lambda r: r.fulfill(status=200, content_type="application/json",
                               body='{"ok":true,"data":{"ok":false,"error":"模拟失败"}}'))
```

## 命令结果

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 通过（无输出） |
| `pnpm typecheck` | 通过（无输出） |
| `pnpm test` | 27 个文件 / 201 个测试全部通过 |
| `pnpm build` | 通过；`/api/*` 21 条全部为动态 `ƒ`，`/` 与 `/login` 为静态 `○` |

基线（改动前）同样为 lint/typecheck 通过、201 测试通过，故本任务未引入测试回归。

## 截图（before/after）

截图与脚本运行于临时目录并在收尾时清理（见文末），此处记录采集范围与度量结果。

- `baseline/`：改动前，1440 与 375（各 8 页）。
- 中间集 `p1/`、`p2/`、`p34/`：阶段 1/2/3-4 验收。
- 最终集：`{1440,1024,768,375}/{login,status,bulletins,bulletin-detail,needs,channels,jev,push}.png`，共 32 张，
  每张附 `report.json`（含 `scrollWidth/clientWidth/overflow` 与超宽元素清单）。

整页横向溢出（`documentElement.scrollWidth - clientWidth`）：

| 视口 | 结果 |
| --- | --- |
| 1440px | 全部 8 页 `0` |
| 1024px | 全部 8 页 `0`（Jev 宽表在容器内滚动） |
| 768px | 全部 8 页 `0`（需求/频道/Jev 表局部滚动） |
| 375px | 全部 8 页 `0`（长标题、长 URL、多 Key 均在 `TableScroll` 内滚动） |

改动前基线在 375px 存在整页溢出：记录列表 41px、详情 464px、需求 190px、Jev 264px；重构后全部为 0。

## 交互 / 可访问性矩阵（21/21 通过）

`verify/interactions.py` 输出 `interactions-report.json`：

- 会话：未登录直达 `/needs` → `/login`；登录进入 `/status`；退出回到 `/login`。
- 导航：六个入口的 `aria-current="page"` 全部正确；详情页激活「线报记录」；返回链接存在。
- 键盘：首次 Tab 聚焦「跳至正文」；六个导航链接均可聚焦（无焦点陷阱）。
- 记录：状态筛选生效且显示「处理失败」；自动刷新 `aria-pressed` 切换。
- 需求：修改名称后失焦保存，刷新后持久化（已还原）。
- 频道：切换自定义模式保存显示成功反馈（已还原为默认）。
- Jev：锚点跳转后表单输入不丢失；未知费用显示为「未知模型价格…」而非 `$0.00`；
  自动禁用原因可见；密钥显示掩码 `****`。
- 推送：三处凭据三态（保留/替换/清除）切换「替换」后出现密码输入；掩码状态可见。
- 200% 等效缩放（1440 → 720 CSS px）：七页整页无横向溢出。

### 离线响应替身（不发起真实外部调用）

在浏览器层拦截 `/api/settings/jev/test` 与 `/api/settings/notify/test`：

- 返回失败 → 渲染 `.feedback-error[role="alert"]`（连接测试失败 / 测试发送失败）。
- 返回成功 → 渲染 `.feedback-success`。
- 覆盖了「仅用离线假传输验证调用结果」的要求，未调用真实 Jev/Bark/飞书。

## 只读核验与修复

由只读子代理对照 `git diff` 核验业务语义、规范、组件边界、key 表达式与可访问性，发现并已修复 2 处重构回归：

1. 危险操作按钮配色丢失：`.btn-ghost.danger` 未匹配 `.ghost.danger` 选择器。
   已在 `globals.css` 补齐；实测删除按钮 `color = rgb(179, 38, 30)`。
2. 测试失败提示被渲染成绿色「成功」：推送与 Jev 的连接测试结果统一用了 `Feedback kind="success"`。
   已改为按结果区分 `success` / `error`（错误用 `role="alert"`）；离线替身实测通过。

另修：Jev 刷新失败在已有数据时不可见 → 增加「刷新失败…（下方为上次成功数据）」；清理 `.shell` 死类与注释错字。

## 未验证 / 已知限制

- 未对真实 Jev/Bark/飞书发起任何调用；浏览器测试结果仅通过离线替身覆盖，「真实语义效果」仍待在用户凭据环境验证。
- 轮询竞态（慢请求不叠加、旧响应不覆盖新查询）沿用既有控制器，未在浏览器重测；
  由既有 `tests/components/api-resource.test.ts` 覆盖，本次未改动该链路。
- 「200% 缩放」以缩小等效视口近似，未在真实浏览器缩放会话中逐项点击验证。
- 仓库没有视觉回归基线框架；截图为人工采集产物，未纳入 CI。
- dev 模式（`next dev`）在本机因 HMR 握手失败未做视觉验收；验收基于生产构建产物。
- 仅浅色主题；未做暗色、动效、图片或多主题验证（范围外）。

## 结论

阶段 0–4 的全部交付项已完成；32 张四视口截图与 21/21 交互矩阵构成实屏证据（原始文件按收尾决定清理，度量结果见上）。
`lint`/`typecheck`/`test`/`build` 全绿，API DTO、数据库与后台调度未改动。
