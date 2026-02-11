# Overaicoding - Thinking 双语翻译功能改动记录

> **功能概述**: 在 thinking/reasoning 块流式完成后，自动调用 LLM 翻译为中文，以双语对照形式展示（原文可折叠，翻译突出显示）。
>
> **当前状态**: 仅翻译 ReasoningPart（TextPart 翻译已回退）

---

## 改动文件清单 (5 个文件)

| # | 文件路径 | 改动类型 | 说明 |
|---|---------|---------|------|
| 1 | `packages/opencode/src/config/config.ts` | 修改 | 新增 `thinking_translation` 配置段 + `toggle_translation` 快捷键 |
| 2 | `packages/opencode/src/session/translate.ts` | **新增** | 翻译服务模块（核心逻辑 + 语言检测） |
| 3 | `packages/opencode/src/session/processor.ts` | 修改 | 仅在 `reasoning-end` 后触发异步翻译 |
| 4 | `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | 修改 | ReasoningPart 双语渲染 + toggle 命令（TextPart 无翻译） |
| 5 | `packages/sdk/js/src/v2/gen/types.gen.ts` | 修改 | 补充 `toggle_translation` 快捷键类型 + `thinking_translation` 配置类型 |

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
    "target_language": "zh-CN"
  }
}
```

---

## Step 2: translate.ts — 翻译服务（新增文件）

**文件**: `packages/opencode/src/session/translate.ts`

**当前完整内容**:

```typescript
import { generateText } from "ai"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { Session } from "."
import type { MessageV2 } from "./message-v2"
import { Log } from "../util/log"

export namespace ThinkingTranslation {
  const log = Log.create({ service: "thinking-translation" })

  // 检测文本是否已经主要是目标语言，避免重复翻译
  function isAlreadyInTargetLanguage(text: string, targetLang: string): boolean {
    if (targetLang.startsWith("zh")) {
      const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g)
      const chineseCount = chineseChars?.length ?? 0
      if (chineseCount < 5) return false
      const stripped = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/[\s\n\r\t0-9`\-*#_>|[\](){}.,;:!?'"\/\\@$%^&+=~<>]/g, "")
      if (stripped.length === 0) return false
      return chineseCount / stripped.length > 0.3
    }
    if (targetLang.startsWith("ja")) {
      const jpChars = text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/g)
      const jpCount = jpChars?.length ?? 0
      if (jpCount < 5) return false
      const stripped = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/[\s\n\r\t0-9`\-*#_>|[\](){}.,;:!?'"\/\\@$%^&+=~<>]/g, "")
      if (stripped.length === 0) return false
      return jpCount / stripped.length > 0.3
    }
    if (targetLang.startsWith("ko")) {
      const koChars = text.match(/[\uac00-\ud7af\u1100-\u11ff]/g)
      const koCount = koChars?.length ?? 0
      if (koCount < 5) return false
      const stripped = text
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "")
        .replace(/[\s\n\r\t0-9`\-*#_>|[\](){}.,;:!?'"\/\\@$%^&+=~<>]/g, "")
      if (stripped.length === 0) return false
      return koCount / stripped.length > 0.3
    }
    return false
  }

  let runtimeEnabled: boolean | undefined = undefined

  export function setEnabled(enabled: boolean | undefined) {
    runtimeEnabled = enabled
  }

  export function toggleEnabled() {
    if (runtimeEnabled === undefined) {
      runtimeEnabled = false
    } else {
      runtimeEnabled = !runtimeEnabled
    }
    return runtimeEnabled
  }

  export async function isEnabled(): Promise<boolean> {
    if (runtimeEnabled !== undefined) return runtimeEnabled
    const cfg = await Config.get()
    return cfg.thinking_translation?.enabled ?? false
  }

  async function doTranslate(
    part: MessageV2.ReasoningPart | MessageV2.TextPart,
    text: string,
  ) {
    const cfg = await Config.get()
    const translationCfg = cfg.thinking_translation
    if (!translationCfg?.model) return

    try {
      const { providerID, modelID } = Provider.parseModel(translationCfg.model)
      const model = await Provider.getModel(providerID, modelID)
      const language = await Provider.getLanguage(model)
      const targetLang = translationCfg.target_language ?? "zh-CN"

      const result = await generateText({
        model: language,
        messages: [
          {
            role: "system",
            content: `You are a professional translator. Translate the following text to ${targetLang}. Output ONLY the translation, preserving all technical terms, code snippets, and formatting. Do not add any commentary or explanation.`,
          },
          { role: "user", content: text },
        ],
        maxOutputTokens: Math.min(text.length * 2, 8192),
      })

      part.metadata = {
        ...part.metadata,
        translation: {
          text: result.text,
          language: targetLang,
          timestamp: Date.now(),
        },
      }
      await Session.updatePart(part)
      log.info("translation completed", { partID: part.id, type: part.type, length: result.text.length })
    } catch (e) {
      log.error("translation failed", { partID: part.id, type: part.type, error: e })
    }
  }

  // 翻译 reasoning/thinking 块（唯一启用的翻译入口）
  export async function translate(part: MessageV2.ReasoningPart) {
    const cfg = await Config.get()
    const translationCfg = cfg.thinking_translation
    if (!translationCfg?.enabled && runtimeEnabled !== true) return
    if (runtimeEnabled === false) return
    if (!translationCfg?.model) return

    const text = part.text.replace("[REDACTED]", "").trim()
    if (!text || text.length < 10) return

    const targetLang = translationCfg.target_language ?? "zh-CN"
    if (isAlreadyInTargetLanguage(text, targetLang)) {
      log.info("skipped reasoning translation, text already in target language", {
        partID: part.id,
        targetLang,
      })
      part.metadata = { ...part.metadata, translation_skipped: true }
      await Session.updatePart(part)
      return
    }

    await doTranslate(part, text)
  }
}
```

**关键设计**:
- `isAlreadyInTargetLanguage()` — 通过字符统计检测文本是否已是目标语言（支持 zh/ja/ko）
- `doTranslate()` — 通用翻译核心，调用 LLM 翻译
- `translate()` — reasoning 专用入口，含 `[REDACTED]` 过滤 + 语言检测
- ~~`translateText()` — text 专用（已移除）~~
- 翻译结果存入 `part.metadata.translation`，持久化到数据库
- 跳过翻译时写入 `part.metadata.translation_skipped = true`，通知 UI 不显示 "Translating..."
- 使用 `maxOutputTokens`（**不是** `maxTokens`，这是 AI SDK 的正确参数名）

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

### ~~3.3 text-end 中触发翻译（已移除）~~

TextPart 翻译已回退，`text-end` 处理中不再调用翻译。

**注意**: 不使用 `await`，翻译在后台异步执行。`.catch(() => {})` 防止未处理的 promise rejection。

---

## Step 4: index.tsx — UI 渲染

**文件**: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

### 4.1 ReasoningPart 组件（约第 1358 行）— 双语渲染

```
<Show when={content() && ctx.showThinking()}>
  <box border={["left"]} flexDirection="column">
    {/* 翻译后的内容（突出显示） */}
    <Show when={translation()}>
      <code content={"_Thinking:_ " + translation()!.text} streaming={false} />
    </Show>

    {/* 原文（翻译存在时折叠，无翻译时正常显示） */}
    <Show when={!translation() || showOriginal()}>
      <code content={...} streaming={!translation()} />
    </Show>

    {/* 折叠/展开切换 */}
    <Show when={translation()}>
      <text onMouseDown={toggle}>{showOriginal() ? "▼ Hide original" : "▶ Show original"}</text>
    </Show>

    {/* 翻译中提示（未被跳过时才显示） */}
    <Show when={!translation() && !metadata?.translation_skipped && props.part.time?.end && config.enabled}>
      <text> Translating...</text>
    </Show>
  </box>
</Show>
```

### 4.2 TextPart 组件 — 无翻译（已回退）

TextPart 恢复为原始版本，不包含任何翻译 UI。

### 4.3 Toggle 命令（在命令列表中，`display_thinking` 命令之后）

```typescript
{
  title: "Toggle thinking translation",
  value: "session.toggle.translation",
  keybind: "toggle_translation",
  category: "Session",
  slash: { name: "translate-thinking", aliases: ["toggle-translation"] },
  onSelect: (dialog) => {
    import("@/session/translate").then(({ ThinkingTranslation }) => {
      const enabled = ThinkingTranslation.toggleEnabled()
      toast.show({
        message: enabled ? "Thinking translation enabled" : "Thinking translation disabled",
        variant: "success",
      })
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

### 5.2 Config 类型（在 `experimental` 之后）

```typescript
thinking_translation?: {
  enabled?: boolean
  model?: string
  target_language?: string
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
    │             ├─ isAlreadyInTargetLanguage? → YES → metadata.translation_skipped=true → UI: 无翻译提示
    │             └─ NO → doTranslate() → metadata.translation → UI: 中文翻译 + "▶ Show original"
    │
    ├─ text-delta ──→ UI: 流式显示文本（无翻译）
    │
    └─ text-end ──→ UI: 文本显示完成（无翻译）
```

---

## 遇到的坑和解决方案

| 问题 | 原因 | 解决 |
|------|------|------|
| `thinking_translation` missing in `{}` | `.optional().default({})` 使 output type 中字段变为 required | 移除 `.default({})`，只保留 `.optional()` |
| `maxTokens` does not exist | AI SDK `generateText()` 使用 `maxOutputTokens` | 改为 `maxOutputTokens` |
| 同一 config.ts 的 overload error | 同上原因，`.default({})` 类型不兼容 | 同上修复 |
| "Translating..." 在翻译关闭时也显示 | 缺少配置启用状态检查 | 添加 `ctx.sync.data.config.thinking_translation?.enabled` 条件 |
| 中文 TextPart 被错误翻译 + 折叠到 "Show original" | `translateText` 不检测文本是否已是目标语言 | 添加 `isAlreadyInTargetLanguage` 检测 |
| "Translating..." 永远显示不消失 | 跳过翻译时没通知 UI | 写入 `metadata.translation_skipped = true` |
| `AI_InvalidPromptError: messages must be ModelMessage[]` | TextPart 翻译触发时消息格式不兼容 | **回退方案**: 移除 TextPart 翻译，仅保留 ReasoningPart |

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

## 关键 API 参考

| API | 位置 | 说明 |
|-----|------|------|
| `Provider.parseModel("provider/model-id")` | `provider/provider.ts` | 返回 `{ providerID, modelID }` |
| `Provider.getModel(providerID, modelID)` | `provider/provider.ts` | 返回 `Provider.Model` |
| `Provider.getLanguage(model)` | `provider/provider.ts` | 返回 `LanguageModelV2` |
| `Session.updatePart(part)` | `session/index.ts:418-439` | 持久化 part 并发布 `PartUpdated` bus 事件 |
| `generateText({ model, messages, maxOutputTokens })` | `ai` SDK | 非流式文本生成 |
| `MessageV2.ReasoningPart.metadata` | `message-v2.ts` | `z.record(z.string(), z.any()).optional()` |

---

## 验证清单

- [x] `bun turbo typecheck` — 12/12 全部通过
- [x] 配置验证: `opencode.json` 中配置 `thinking_translation`
- [x] Reasoning 翻译: 触发 thinking 后观察 "Translating..." → 中文翻译
- [x] 双语显示: 中文翻译显示在上方，"▶ Show original" 可展开原文
- [x] 持久化: 退出后重新打开会话，翻译结果从 metadata 恢复
- [x] Toggle 命令: `/translate-thinking` 可运行时切换
- [x] 关闭功能: `enabled: false` 后不触发翻译
- [x] 语言检测: 已是中文的 reasoning 不会重复翻译
- [ ] ~~TextPart 翻译~~ (已回退)
