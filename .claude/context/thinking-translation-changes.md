# Overaicoding - Thinking 双语翻译功能改动记录

> **功能概述**: 在 thinking/reasoning 块流式完成后，自动调用 LLM 翻译为中文，以双语对照形式展示（原文可折叠，翻译突出显示）。
>
> **当前状态**: 仅翻译 ReasoningPart（TextPart 翻译已回退）
>
> **最后更新**: 2026-02-12（Bug 修复轮 + UI hover 改进）

---

## 改动文件清单 (5 个文件)

| # | 文件路径 | 改动类型 | 说明 |
|---|---------|---------|------|
| 1 | `packages/opencode/src/config/config.ts` | 修改 | 新增 `thinking_translation` 配置段（含 `max_output_tokens`）+ `toggle_translation` 快捷键 |
| 2 | `packages/opencode/src/session/translate.ts` | **新增** | 翻译服务模块（核心逻辑 + 语言检测 + 安全写入 + 幂等标记） |
| 3 | `packages/opencode/src/session/processor.ts` | 修改 | 仅在 `reasoning-end` 后触发异步翻译 |
| 4 | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | 修改 | ReasoningPart 双语渲染 + toggle 命令 + hover 高亮按钮（TextPart 无翻译） |
| 5 | `packages/sdk/js/src/v2/gen/types.gen.ts` | 修改 | 补充 `toggle_translation` 快捷键类型 + `thinking_translation` 配置类型（含 `max_output_tokens`） |

---

## Step 1: config.ts — 配置层

**文件**: `packages/opencode/src/config/config.ts`

### 1.1 新增快捷键（在 `display_thinking` 之后）

```typescript
display_thinking: z.string().optional().default("none").describe("Toggle thinking blocks visibility"),
toggle_translation: z
  .string()
  .optional()
  .default("none")
  .describe("Toggle thinking translation visibility"),
```

### 1.2 新增配置段（在 `experimental` 之前）

```typescript
thinking_translation: z
  .object({
    enabled: z.boolean().optional().default(false).describe("Enable automatic translation of thinking/reasoning content"),
    model: z
      .string()
      .optional()
      .describe("Model to use for translation, format: provider/model-id, e.g. anthropic/claude-haiku-4-0"),
    target_language: z
      .string()
      .optional()
      .default("zh-CN")
      .describe("Target language for translation"),
    max_output_tokens: z
      .number()
      .int()
      .min(256)
      .max(32768)
      .optional()
      .describe("Max output tokens for translation model (default 8192, max 32768)"),
  })
  .optional(),
```

**⚠️ 关键注意**: 只用 `.optional()`，**不能**用 `.optional().default({})`，否则会导致类型错误（output type 中字段变为 required，与空对象 `{}` 合并冲突）。

### 用户配置示例 (`~/.config/opencode/opencode.jsonc`)

```jsonc
{
  "thinking_translation": {
    "enabled": true,
    "model": "google/antigravity-gemini-3-flash",
    "target_language": "zh-CN",
    "max_output_tokens": 16384  // 可选，默认 8192，最大 32768
  }
}
```

---

## Step 2: translate.ts — 翻译服务

**文件**: `packages/opencode/src/session/translate.ts`

### 架构概览

```
ThinkingTranslation namespace
├── isAlreadyInTargetLanguage()  — 字符统计语言检测（zh/ja/ko）
├── runtimeEnabled / setEnabled / toggleEnabled / isEnabled  — 运行时开关
├── DEFAULT_MAX_OUTPUT_TOKENS = 8192  — token 上限默认值
├── bestEffortUpdatePart()  — 安全写入（try-catch，失败仅记录不抛错）
├── doTranslate()  — 通用翻译核心（调 LLM + 写 metadata）
├── markSkipped()  — 幂等跳过标记（已有标记则不重复写）
└── translate()  — reasoning 翻译入口（检查开关 → 过滤 → 语言检测 → 翻译）
```

### 关键函数说明

**`bestEffortUpdatePart()`** — 安全写入，解决 P0-3（早退路径 updatePart 失败不应中断主流程）
```typescript
async function bestEffortUpdatePart(part: MessageV2.ReasoningPart | MessageV2.TextPart) {
  try {
    await Session.updatePart(part)
  } catch (e) {
    log.error("failed to update part metadata", { partID: part.id, error: e })
  }
}
```

**`markSkipped()`** — 幂等标记，解决 P1-5（禁用状态下减少写放大）
```typescript
async function markSkipped(part: MessageV2.ReasoningPart) {
  if (part.metadata?.translation_skipped || part.metadata?.translation) return
  part.metadata = { ...part.metadata, translation_skipped: true }
  await bestEffortUpdatePart(part)
}
```

**`doTranslate()`** — 翻译核心，关键改动：
- `maxOutputTokens` 使用可配置上限：`Math.min(translationCfg.max_output_tokens ?? 8192, 32768)`
- catch 块记录 `translation_error` 失败原因（P2-8）

**`toggleEnabled()`** — 异步版本，解决 P0-1（首次 toggle 读取 config 取反）
```typescript
export async function toggleEnabled() {
  if (runtimeEnabled === undefined) {
    const cfg = await Config.get()
    const currentlyEnabled = cfg.thinking_translation?.enabled ?? false
    runtimeEnabled = !currentlyEnabled
  } else {
    runtimeEnabled = !runtimeEnabled
  }
  return runtimeEnabled
}
```

**`translate()`** — 所有早退路径调用 `markSkipped()`，确保 UI 永远能得到终态标记。

---

## Step 3: processor.ts — 处理器钩子

**文件**: `packages/opencode/src/session/processor.ts`

### 3.1 导入（文件顶部第 18 行）

```typescript
import { ThinkingTranslation } from "./translate"
```

### 3.2 reasoning-end 中触发翻译（约第 99 行之后）

```typescript
await Session.updatePart(part)

// 异步触发翻译（不阻塞主流程）
ThinkingTranslation.translate(part).catch(() => {})
```

**注意**: 不使用 `await`，翻译在后台异步执行。`.catch(() => {})` 防止未处理的 promise rejection。

---

## Step 4: index.tsx — UI 渲染

**文件**: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

### 4.1 ReasoningPart 组件 — 双语渲染 + hover 高亮

```tsx
// hover 状态
const [toggleHover, setToggleHover] = createSignal(false)
const renderer = useRenderer()

// ...

{/* 翻译后的内容（突出显示） */}
<Show when={translation()}>
  <code content={"_Thinking:_ " + translation()!.text} streaming={false} />
</Show>

{/* 原文（翻译存在时折叠，无翻译时正常显示） */}
<Show when={!translation() || showOriginal()}>
  <code content={...} streaming={!translation()} />
</Show>

{/* 折叠/展开切换 — hover 高亮 + onMouseUp 避免选中文字 */}
<Show when={translation()}>
  <text
    fg={toggleHover() ? theme.text : theme.textMuted}
    onMouseOver={() => setToggleHover(true)}
    onMouseOut={() => setToggleHover(false)}
    onMouseUp={() => {
      if (renderer.getSelection()?.getSelectedText()) return
      setShowOriginal((prev) => !prev)
    }}
  >
    {toggleHover()
      ? <span style={{ bold: true }}>{showOriginal() ? "▼ Hide original" : "▶ Show original"}</span>
      : (showOriginal() ? "▼ Hide original" : "▶ Show original")}
  </text>
</Show>

{/* "Translating..." 提示 — 加回 config 兜底条件防止旧会话永驻 */}
<Show when={
  !translation()
  && !props.part.metadata?.translation_skipped
  && props.part.time?.end
  && (ctx.sync.data.config.thinking_translation?.enabled || ctx.sync.data.config.thinking_translation?.model)
}>
  <text fg={theme.textMuted}> Translating...</text>
</Show>
```

**UI 交互模式说明**:
- 使用 `onMouseUp`（不是 `onMouseDown`）避免触发终端文字选择
- `renderer.getSelection()?.getSelectedText()` 检查：如果用户在拖选文字，不触发切换
- hover 时文字颜色从 `textMuted` → `text`，并加粗
- 与项目中 `BlockTool` 组件的交互模式一致

### 4.2 Toggle 命令 — 异步 + 错误处理

```typescript
{
  title: "Toggle thinking translation",
  value: "session.toggle.translation",
  keybind: "toggle_translation",
  slash: { name: "translate-thinking", aliases: ["toggle-translation"] },
  onSelect: (dialog) => {
    import("@/session/translate").then(async ({ ThinkingTranslation }) => {
      const enabled = await ThinkingTranslation.toggleEnabled()
      toast.show({
        message: enabled ? "Thinking translation enabled" : "Thinking translation disabled",
        variant: "success",
      })
    }).catch((e) => {
      toast.show({ message: "Failed to toggle translation", variant: "error" })
    })
    dialog.clear()
  },
},
```

---

## Step 5: types.gen.ts — 类型同步

**文件**: `packages/sdk/js/src/v2/gen/types.gen.ts`

### 5.1 KeybindsConfig 类型（在 `display_thinking` 之后）

```typescript
/**
 * Toggle thinking translation visibility
 */
toggle_translation?: string
```

### 5.2 Config 类型（在 `experimental` 之前）

```typescript
thinking_translation?: {
  enabled?: boolean
  model?: string
  target_language?: string
  max_output_tokens?: number
}
```

---

## 数据流全景

```
LLM API 响应
    │
    ├─ reasoning-delta ──→ UI: 流式显示英文原文
    │
    ├─ reasoning-end
    │   ├──→ Session.updatePart(part)
    │   └──→ ThinkingTranslation.translate(part) (后台异步)
    │             ├─ 已禁用/无模型/过短? → markSkipped() [幂等] → UI: 无翻译提示
    │             ├─ isAlreadyInTargetLanguage? → markSkipped() → UI: 无翻译提示
    │             └─ doTranslate()
    │                  ├─ 成功 → metadata.translation → UI: 中文翻译 + "▶ Show original"
    │                  └─ 失败 → metadata.translation_skipped + translation_error → UI: 无翻译提示
    │
    ├─ text-delta ──→ UI: 流式显示文本（无翻译）
    │
    └─ text-end ──→ UI: 文本显示完成（无翻译）

UI "Translating..." 显示条件:
  !translation && !translation_skipped && part.time.end && (config.enabled || config.model)
```

---

## Bug 修复记录（2026-02-12）

### P0 级修复

| # | Bug | 根因 | 修复 | 文件 |
|---|-----|------|------|------|
| 1 | `toggleEnabled()` 首次 toggle 总是 false | 同步函数未读 config，`undefined` 直接设 false | 改为 async，首次调用时 `await Config.get()` 读取当前值并取反 | translate.ts:62-72 |
| 2 | 旧会话 "Translating..." 永驻 | UI 仅依赖 `translation_skipped`，历史 part 无此字段 | 所有早退路径写 `translation_skipped` + UI 加回 `config.enabled \|\| config.model` 兜底 | translate.ts + index.tsx |
| 3 | 翻译失败 "Translating..." 永驻 | catch 块未写任何 metadata 标记 | catch 块写入 `translation_skipped: true` + `translation_error: errorMsg` | translate.ts:130-140 |
| 4 | `maxOutputTokens: 32768` 对小模型不安全 | 硬编码大值，部分 provider 会 400 | 默认 8192，新增 `max_output_tokens` 配置项，硬上限 32768 | translate.ts:81,108 + config.ts + types.gen.ts |
| 5 | 早退路径 `updatePart` 无 `.catch()` | `await Session.updatePart(part)` 失败会抛错 | 提取 `bestEffortUpdatePart()` 方法，try-catch 包裹 | translate.ts:83-90 |

### P1/P2 级修复

| # | Bug | 修复 | 文件 |
|---|-----|------|------|
| 6 | 禁用时写放大 | `markSkipped()` 幂等：已有 `translation_skipped` 或 `translation` 则不写 | translate.ts:143-148 |
| 7 | toggle Promise 无 `.catch()` | 添加 `.catch()` + error toast | index.tsx:582-584 |
| 8 | 翻译失败丢失原因 | catch 块写入 `translation_error: errorMsg` | translate.ts:137 |

### UI 修复

| # | Bug | 修复 | 文件 |
|---|-----|------|------|
| 9 | 点击 "Show original" 选中周围文字 | `onMouseDown` → `onMouseUp` + `renderer.getSelection()?.getSelectedText()` 检查 | index.tsx:1427-1431 |
| 10 | "Show original" 无 hover 反馈 | 添加 `toggleHover` signal + `onMouseOver`/`onMouseOut` + 高亮粗体 | index.tsx:1419-1436 |

---

## 遇到的坑和解决方案

| 问题 | 原因 | 解决 |
|------|------|------|
| `thinking_translation` missing in `{}` | `.optional().default({})` 使 output type 中字段变为 required | 移除 `.default({})`，只保留 `.optional()` |
| `maxTokens` does not exist | AI SDK `generateText()` 使用 `maxOutputTokens` | 改为 `maxOutputTokens` |
| "Translating..." 在翻译关闭时也显示 | 缺少配置启用状态检查 | 添加 config 兜底条件 |
| 中文 TextPart 被错误翻译 | `translateText` 不检测文本是否已是目标语言 | 添加 `isAlreadyInTargetLanguage` 检测 |
| "Translating..." 永远显示不消失 | 跳过/失败时没通知 UI | 所有路径写入 `translation_skipped` + `translation_error` |
| `AI_InvalidPromptError` | TextPart 翻译时消息格式不兼容 | **回退方案**: 移除 TextPart 翻译 |
| `<text style={{ bold: true }}>` 类型错误 | OpenTUI `<text>` 无 `style.bold` | 用 `<span style={{ bold: true }}>` 包裹内容 |
| `onMouseDown` 导致文字选中 | 终端中 mousedown 启动选择操作 | 改为 `onMouseUp` + selection 检查（与 `BlockTool` 一致） |

---

## TextPart 翻译回退记录

### 尝试过的方案

1. **v1**: 直接翻译所有 TextPart → 中文内容被重复翻译，原文被折叠
2. **v2**: 添加 `isAlreadyInTargetLanguage` 语言检测 → 中文跳过，但 "Translating..." 永远显示
3. **v3**: 添加 `translation_skipped` metadata 标记 → 修复了 "Translating..." 但出现 `AI_InvalidPromptError`
4. **最终**: 回退到仅翻译 ReasoningPart

### 未来若要重新实现 TextPart 翻译，需注意

- `isAlreadyInTargetLanguage` 检测逻辑已保留在 translate.ts 中，可复用
- `translation_skipped` UI 逻辑在 ReasoningPart 中有参考实现
- 需排查 `AI_InvalidPromptError` 的根因（可能与特定 provider 的消息格式要求有关）
- 考虑仅翻译英文占比高的 TextPart，而非所有

---

## 已知未修复问题

| 问题 | 严重性 | 原因 |
|------|--------|------|
| `isAlreadyInTargetLanguage` 不支持非 CJK 目标语言（如 fr/de/es） | 低 | 目前仅支持 zh/ja/ko 检测，其他语言直接返回 false（会翻译） |
| config.ts `global()` 与项目配置的 `.json`/`.jsonc` 加载优先级相反 | 极低 | `global()` 中 `.jsonc` 后加载=更高优先级，项目配置 `for` 循环中 `.jsonc` 先加载=更低优先级。仅在同时存在两份同名不同后缀的配置文件时才会触发，涉及上游代码结构暂不修改 |

---

## 关键 API 参考

| API | 位置 | 说明 |
|-----|------|------|
| `Provider.parseModel("provider/model-id")` | `provider/provider.ts` | 返回 `{ providerID, modelID }` |
| `Provider.getModel(providerID, modelID)` | `provider/provider.ts` | 返回 `Provider.Model` |
| `Provider.getLanguage(model)` | `provider/provider.ts` | 返回 `LanguageModelV2` |
| `Session.updatePart(part)` | `session/index.ts:418-439` | 持久化 part 并发布 `PartUpdated` bus 事件 |
| `generateText({ model, system, prompt, maxOutputTokens })` | `ai` SDK | 非流式文本生成 |
| `MessageV2.ReasoningPart.metadata` | `message-v2.ts` | `z.record(z.string(), z.any()).optional()` |
| `renderer.getSelection()?.getSelectedText()` | `@opentui/solid` | 获取终端当前选中文本 |

---

## 验证清单

- [x] `bun turbo typecheck` — 12/12 全部通过
- [x] 配置验证: `opencode.json` 中配置 `thinking_translation`（含 `max_output_tokens`）
- [x] Reasoning 翻译: 触发 thinking 后观察 "Translating..." → 中文翻译
- [x] 双语显示: 中文翻译显示在上方，"▶ Show original" 可展开原文
- [x] 持久化: 退出后重新打开会话，翻译结果从 metadata 恢复
- [x] Toggle 命令: `/translate-thinking` 可运行时切换（异步 + 错误处理）
- [x] 关闭功能: `enabled: false` 后不触发翻译
- [x] 语言检测: 已是中文的 reasoning 不会重复翻译
- [x] Hover 高亮: "Show original" 鼠标悬停时高亮加粗
- [x] 无文字选中: 点击 "Show original" 不会选中周围文字
- [x] 旧会话兼容: 无 `translation_skipped` 字段的历史 part 不显示 "Translating..."
- [x] 翻译失败: 失败后不永驻 "Translating..."，错误原因记录在 `translation_error`
- [ ] ~~TextPart 翻译~~ (已回退)
