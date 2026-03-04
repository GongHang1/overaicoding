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

### ⚠️ Rebase 后必须清理 TypeScript 缓存

**已知问题**：`git rebase` 后直接运行 `bun turbo typecheck` 会因 tsgo 增量编译缓存（`.tsbuildinfo`）过期导致假阳性类型错误。SDK 包的 `composite: true` 配置会产生 `.tsbuildinfo` 文件，rebase 后这些文件与新源码不一致。

**解决方法**：rebase 后使用 `typecheck:clean` 代替普通 `typecheck`：

```bash
# rebase 后验证类型（自动清理 tsbuildinfo + 强制重跑）
bun run typecheck:clean

# 等价于：
# find . -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete && bun turbo typecheck --force
```

**注意**：pre-push hook 调用的是 `bun turbo typecheck`（不带 `--force`），如果 rebase 后首次 push 被 hook 拦截，先手动跑一次 `bun run typecheck:clean`，之后 turbo 缓存会更新为正确状态，后续普通 typecheck 和 push 就不会再报错。

### 关键注意事项

| 事项 | 说明 |
|------|------|
| 合并策略 | dev 分支用 `merge`（保持与上游一致），功能分支用 `rebase`（保持线性历史） |
| force push | 仅对功能分支使用 `--force-with-lease`，**绝对禁止** force push `dev` 分支 |
| 冲突高发文件 | `packages/opencode/package.json`（版本号 + 项目名冲突）、`packages/sdk/js/src/v2/gen/types.gen.ts`（生成文件） |
| 冲突解决原则 | 版本号取上游最新值，项目名保留 `overaicoding`，功能代码保留我方实现 |
| typecheck | 每次 push 会触发 pre-push hook 执行全量 typecheck，必须 12/12 通过 |

### 上游同步历史

| 日期 | 上游版本 | 本地分支 | 主要变更 | 冲突文件 | 备注 |
|------|---------|---------|---------|---------|------|
| 2026-03-04 | v1.2.11 → v1.2.16 | my_dev | Workspace 重构、keybinds 去 leader 前缀、opentui 升级到 0.1.86 | `config.ts`（快捷键冲突）、`package.json`（版本号）、`message-v2.ts`（stripMedia 移除）、`bun.lock` | `session_child_list` 快捷键从 `<leader>down` 改为 `<leader>l` 以避免与上游 `session_child_first` 冲突 |

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
| `packages/opencode/src/config/config.ts` | 修改 | 新增 `session_child_list` 快捷键（`<leader>l`，原为 `<leader>down` 但与上游 `session_child_first` 冲突后调整） |
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

3. **构建验证**: 本地修改后先运行 `bun turbo typecheck` 确认类型无误，再提交。pre-push hook 会自动检查，失败则推送被阻止。**rebase 后必须用 `bun run typecheck:clean` 代替**（详见「上游同步流程」的缓存说明）。

4. **Zod schema 陷阱**: `z.object({...}).optional().default({})` 会使 output type 中字段变为 required，导致与空对象合并冲突。如果配置段整体可选，只用 `.optional()` 不加 `.default({})`。

5. **AI SDK 参数**: `generateText()` 的 token 限制参数是 `maxOutputTokens`（不是 `maxTokens`）。

---

## 自定义功能: Thinking 双语翻译

**状态**: 仅 ReasoningPart 翻译（TextPart 翻译已回退）
**详细改动记录**: `.claude/context/thinking-translation-changes.md`

**改动文件** (5 个):

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/opencode/src/config/config.ts` | 修改 | `thinking_translation` 配置段（含 `max_output_tokens`）+ `toggle_translation` 快捷键 |
| `packages/opencode/src/session/translate.ts` | 新增 | 翻译服务（`doTranslate` 核心 + `translate` reasoning 翻译 + `isAlreadyInTargetLanguage` 语言检测 + `bestEffortUpdatePart` 安全写入 + `markSkipped` 幂等标记） |
| `packages/opencode/src/session/processor.ts` | 修改 | 仅 `reasoning-end` 后异步触发翻译（`text-end` 翻译已移除） |
| `.../routes/session/index.tsx` | 修改 | ReasoningPart 双语渲染 + toggle 命令 + hover 高亮按钮（TextPart 保持原始无翻译） |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | 修改 | 类型同步（含 `max_output_tokens`） |

**TextPart 翻译回退原因**:
1. 已是目标语言的中文文本被错误翻译，原文被折叠到 "Show original" 后面
2. 添加 `isAlreadyInTargetLanguage` 语言检测 + `translation_skipped` 标记后，"Translating..." 仍永远显示
3. 最终出现 `AI_InvalidPromptError: Invalid prompt: The messages must be a ModelMessage[]` 报错

**已修复的 Bug（2026-02-12）**:

| Bug | 严重性 | 修复 |
|-----|-------|------|
| `toggleEnabled()` 首次 toggle 无法正确取反 config 默认值 | P0 | 改为 async，首次调用读取 config 并取反 |
| 旧会话 / 翻译禁用时 "Translating..." 永驻 | P0 | 所有早退路径写入 `translation_skipped` + UI 加回 config 兜底条件 |
| 翻译失败后 "Translating..." 永驻 | P0 | catch 块写入 `translation_skipped` + `translation_error` |
| 长 thinking 块翻译截断 | P0 | `text.length` 被当作 token 数导致 maxOutputTokens 不足；默认值 8192→16384，硬上限 32768→65536，增加分块翻译机制 |
| `maxOutputTokens` 对小模型不安全 | P0（已修复） | 默认 8192→16384，新增 `max_output_tokens` 配置项（256-65536），分块翻译兜底 |
| 早退路径 `updatePart` 无 `.catch()` 可中断主流程 | P0 | 提取 `bestEffortUpdatePart()` 方法 |
| 禁用时每个 part 多一次写入（写放大） | P1 | 提取 `markSkipped()` 幂等方法，已有标记不重复写 |
| toggle Promise 链无 `.catch()` | P2 | 添加 `.catch()` + error toast |
| 翻译失败丢失原因 | P2 | catch 块额外写入 `translation_error` |
| "Show original" 点击时选中周围文字 | UI | `onMouseDown` 改为 `onMouseUp` + selection 检查 |
| "Show original" 无 hover 反馈 | UI | 添加 `onMouseOver`/`onMouseOut` + 高亮 + 粗体 |

**已知未修复问题**:
- `isAlreadyInTargetLanguage` 不支持非 CJK 目标语言（低优先级）
- `TRANSLATION_META_KEYS` 中 `translation_error` 已在使用（之前标记为 dead code，现已修复）
- config.ts 中 `global()` 与项目配置的 `.json`/`.jsonc` 优先级相反（极低概率触发，涉及上游代码结构）

**配置示例** (`opencode.jsonc`):
```jsonc
{
  "thinking_translation": {
    "enabled": true,
    "model": "google/antigravity-gemini-3-flash",
    "target_language": "zh-CN",
    "max_output_tokens": 16384  // 可选，默认 16384，最大 65536
  }
}
```
