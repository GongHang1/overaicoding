# Overaicoding 项目配置

> Fork 自 [anomalyco/opencode](https://github.com/anomalyco/opencode)，重命名为 overaicoding，添加自定义功能。

---

## 项目基本信息

| 项 | 值 |
|---|---|
| 仓库 | `git@github.com:GongHang1/opencode.git`（GitHub 显示为 `GongHang1/overaicoding`） |
| 上游 | `https://github.com/anomalyco/opencode.git` |
| 主分支 | `dev`（跟随上游 dev） |
| 技术栈 | SolidJS + OpenTUI (终端 UI)、TypeScript、Bun |
| 构建 | `bun run build`（turbo monorepo） |
| 类型检查 | `bun turbo typecheck`（pre-push hook 强制执行） |
| 包管理 | bun (bun.lock) |

---

## Git 远程配置

```
origin    git@github.com:GongHang1/opencode.git   (SSH, 你的 fork)
upstream  https://github.com/anomalyco/opencode.git (HTTPS, 源项目)
```

- `origin` 必须使用 SSH 协议（HTTPS 推送在当前环境不可用）
- 如果 origin 是 HTTPS，先执行: `git remote set-url origin git@github.com:GongHang1/opencode.git`

---

## 上游同步流程

当源项目 (anomalyco/opencode) 有更新时，按以下步骤同步：

### 完整命令

```bash
# 1. 拉取上游最新代码
git fetch upstream

# 2. 更新本地 dev 分支（fast-forward 合并）
git checkout dev
git merge upstream/dev
git push origin dev

# 3. Rebase 功能分支到最新 dev
git checkout feature/subagent-toolbar
git rebase dev

# 4. 如有冲突 → 解决 → 继续
#    git add <冲突文件>
#    git rebase --continue

# 5. 强制推送（rebase 改写了历史）
git push origin feature/subagent-toolbar --force-with-lease
```

### 关键注意事项

| 事项 | 说明 |
|------|------|
| 合并策略 | dev 分支用 `merge`（保持与上游一致），功能分支用 `rebase`（保持线性历史） |
| force push | 仅对功能分支使用 `--force-with-lease`，**绝对禁止** force push `dev` 分支 |
| 冲突高发文件 | `packages/opencode/package.json`（版本号 + 项目名冲突）、`packages/sdk/js/src/v2/gen/types.gen.ts`（生成文件） |
| 冲突解决原则 | 版本号取上游最新值，项目名保留 `overaicoding`，功能代码保留我方实现 |
| typecheck | 每次 push 会触发 pre-push hook 执行全量 typecheck，必须 12/12 通过 |

---

## 自定义功能分支

### feature/subagent-toolbar

**状态**: 已完成并推送

**改动文件** (14 个):

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `package.json` | 修改 | 项目重命名为 overaicoding |
| `packages/opencode/package.json` | 修改 | 包名重命名 + bin 入口 |
| `packages/opencode/bin/overaicoding` | 新增 | 可执行文件入口 |
| `packages/opencode/script/build.ts` | 修改 | 构建输出重命名 |
| `packages/web/package.json` | 修改 | 依赖名同步 |
| `packages/opencode/src/config/config.ts` | 修改 | 新增 `session_child_list` 快捷键 |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | 修改 | KeybindsConfig 补充 `session_child_list` 字段 |
| `.../routes/session/index.tsx` | 修改 | sidebar 在子会话中保持可见、Header 在子会话中显示 |
| `.../routes/session/header.tsx` | 重写 | 紧凑单行布局 + 子会话导航按钮 + 版本号显示 |
| `.../routes/session/sidebar.tsx` | 重写 | 根会话锚定防闪烁、hover 悬停导航、可折叠 Subagents 区域 |
| `.../routes/session/dialog-subagent.tsx` | 修改 | 增强子会话对话框 |
| `.../component/dialog-child-session-list.tsx` | 新增 | 子会话列表对话框组件 |
| `.../lib/session-tree.ts` | 新增 | 会话树构建工具 |
| `.../lib/child-session-picker.ts` | 新增 | 子会话选择器工具 |

**核心设计决策**:

1. **根会话锚定 (Root Session Anchoring)**: sidebar 的数据源始终锚定到 `tree().rootID`，而不是当前浏览的 `sessionID`。这样在子会话间 hover 切换时，sidebar 本身不会重新渲染，从根本上消除闪烁。

2. **Parent 链接始终渲染**: 不使用 `<Show when={isInSubagent()}>` 包裹 Parent 链接，而是始终渲染，通过 `isInSubagent()` 控制样式。避免了 hover → DOM 消失 → 元素位移 → 触发新 hover 的无限循环。

3. **Hover-to-Navigate**: `onMouseOver` 直接调用 `route.navigate()`，实现鼠标悬停即切换显示对应子会话内容。

---

## 项目结构（关键路径）

```
packages/
├── opencode/                          # 主包（TUI 终端界面）
│   ├── bin/overaicoding               # CLI 入口
│   ├── script/build.ts                # 构建脚本
│   └── src/
│       ├── config/config.ts           # 配置 + 快捷键定义（Zod schema）
│       ├── installation.ts            # 版本号等安装信息
│       └── cli/cmd/tui/
│           ├── routes/session/        # 会话路由（核心 UI）
│           │   ├── index.tsx          # 主布局（sidebar + content）
│           │   ├── header.tsx         # 顶部导航栏
│           │   ├── sidebar.tsx        # 侧边栏（会话列表 + 子会话）
│           │   ├── dialog-subagent.tsx # 子会话选择对话框
│           │   └── ...
│           ├── component/             # 通用组件
│           ├── context/               # SolidJS 上下文（route, sync, theme, keybind）
│           └── lib/                   # 工具库（session-tree, child-session-picker）
├── sdk/                               # SDK 包
│   └── js/src/v2/gen/types.gen.ts     # 生成的类型定义（KeybindsConfig 等）
├── app/                               # Web/Desktop 前端
└── web/                               # 官网
```

---

## 开发注意事项

1. **类型一致性**: 在 `config.ts` 中通过 Zod schema 新增字段时，必须同步更新 `packages/sdk/js/src/v2/gen/types.gen.ts` 中的对应类型，否则 typecheck 会失败。

2. **SolidJS 响应性**: 使用 `createMemo` / `createSignal` 时注意依赖追踪。避免在 `<Show>` 条件和 DOM 事件之间产生循环依赖（参见 Parent 链接闪烁问题）。

3. **构建验证**: 本地修改后先运行 `bun turbo typecheck` 确认类型无误，再提交。pre-push hook 会自动检查，失败则推送被阻止。
