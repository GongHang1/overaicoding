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
      // 统计中文字符数量（CJK统一汉字）
      const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g)
      const chineseCount = chineseChars?.length ?? 0
      // 如果中文字符少于5个，认为不是中文内容
      if (chineseCount < 5) return false
      // 提取纯文本字符（去掉代码块、空白、标点、数字、markdown语法）
      const stripped = text
        .replace(/```[\s\S]*?```/g, "") // 去掉代码块
        .replace(/`[^`]*`/g, "") // 去掉行内代码
        .replace(/[\s\n\r\t0-9`\-*#_>|[\](){}.,;:!?'"\/\\@$%^&+=~<>]/g, "")
      if (stripped.length === 0) return false
      // 如果中文字符占纯文本字符的30%以上，认为已经是中文
      return chineseCount / stripped.length > 0.3
    }
    if (targetLang.startsWith("ja")) {
      // 日文：检测平假名、片假名、汉字
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
      // 韩文：检测韩文字符
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

  // 运行时开关，用于 toggle 命令
  let runtimeEnabled: boolean | undefined = undefined

  export function setEnabled(enabled: boolean | undefined) {
    runtimeEnabled = enabled
  }

  export async function toggleEnabled() {
    if (runtimeEnabled === undefined) {
      // 首次 toggle 时读取配置值并取反
      const cfg = await Config.get()
      const currentlyEnabled = cfg.thinking_translation?.enabled ?? false
      runtimeEnabled = !currentlyEnabled
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

  // maxOutputTokens 默认上限，可通过配置覆盖
  // 8192 对长 thinking 块翻译远远不够（英文→中文 token 膨胀约 1.5-2x）
  const DEFAULT_MAX_OUTPUT_TOKENS = 16384

  // best-effort 写入 part metadata，失败不抛错
  async function bestEffortUpdatePart(part: MessageV2.ReasoningPart | MessageV2.TextPart) {
    try {
      await Session.updatePart(part)
    } catch (e) {
      log.error("failed to update part metadata", { partID: part.id, error: e })
    }
  }

  const SYSTEM_PROMPT_SINGLE = (targetLang: string) =>
    `You are a professional translator. Translate the following text to ${targetLang}. Output ONLY the translation, preserving all technical terms, code snippets, and formatting. Do not add any commentary or explanation.`

  const SYSTEM_PROMPT_CHUNKED = (targetLang: string) =>
    `You are a professional translator. Translate the following text to ${targetLang}. Output ONLY the translation, preserving all technical terms, code snippets, and formatting. Do not add any commentary or explanation. This is part of a larger text being translated in segments — maintain consistent terminology and style.`

  // 将长文本按段落/句子边界分割成块
  function splitIntoChunks(text: string, maxCharsPerChunk: number): string[] {
    if (text.length <= maxCharsPerChunk) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxCharsPerChunk) {
        chunks.push(remaining)
        break
      }

      // 优先在段落边界（双换行）分割
      let splitAt = remaining.lastIndexOf("\n\n", maxCharsPerChunk)
      // 退而在单换行处分割
      if (splitAt < maxCharsPerChunk * 0.3) {
        splitAt = remaining.lastIndexOf("\n", maxCharsPerChunk)
      }
      // 再退在句号处分割
      if (splitAt < maxCharsPerChunk * 0.3) {
        splitAt = remaining.lastIndexOf(". ", maxCharsPerChunk)
        if (splitAt > 0) splitAt += 1 // 包含句号
      }
      // 最后直接在字符位置截断
      if (splitAt < maxCharsPerChunk * 0.3) {
        splitAt = maxCharsPerChunk
      }

      chunks.push(remaining.slice(0, splitAt).trimEnd())
      remaining = remaining.slice(splitAt).trimStart()
    }

    return chunks
  }

  // 通用翻译核心逻辑（支持分块翻译长文本）
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
      // maxOutputTokens 上限：优先使用配置值，默认 16384，最高不超过 65536
      const maxTokensCap = Math.min(translationCfg.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 65536)

      // 估算翻译输出所需 token 数：
      // 英文约 4 字符/token → 源文本约 text.length/4 个 token 的语义内容
      // 中文翻译后每个中文字符消耗 2-3 token → 输出 token ≈ 源语义量 × 2
      // 安全估算：text.length × 0.5（= text.length/4 × 2）
      const estimatedTokens = Math.ceil(text.length * 0.5)

      let translatedText: string

      if (estimatedTokens <= maxTokensCap) {
        // 单次翻译：直接使用 maxTokensCap 作为输出上限（不用 text.length 裁剪）
        const result = await generateText({
          model: language,
          system: SYSTEM_PROMPT_SINGLE(targetLang),
          prompt: text,
          maxOutputTokens: maxTokensCap,
        })

        if (result.finishReason === "length") {
          log.warn("translation may be truncated (single-shot)", {
            partID: part.id,
            textLength: text.length,
            maxOutputTokens: maxTokensCap,
            estimatedTokens,
          })
        }

        translatedText = result.text
      } else {
        // 分块翻译：文本太长，单次翻译会截断
        // 每块最大字符数 = maxTokensCap / 0.5 = maxTokensCap × 2
        const maxCharsPerChunk = maxTokensCap * 2
        const chunks = splitIntoChunks(text, maxCharsPerChunk)

        log.info("translating in chunks", {
          partID: part.id,
          textLength: text.length,
          chunks: chunks.length,
          maxTokensCap,
        })

        const translatedChunks: string[] = []
        for (const chunk of chunks) {
          const result = await generateText({
            model: language,
            system: SYSTEM_PROMPT_CHUNKED(targetLang),
            prompt: chunk,
            maxOutputTokens: maxTokensCap,
          })

          if (result.finishReason === "length") {
            log.warn("translation chunk may be truncated", {
              partID: part.id,
              chunkIndex: translatedChunks.length,
              chunkLength: chunk.length,
              maxOutputTokens: maxTokensCap,
            })
          }

          translatedChunks.push(result.text)
        }

        translatedText = translatedChunks.join("\n\n")
      }

      // 将翻译结果写入 part.metadata
      part.metadata = {
        ...part.metadata,
        translation: {
          text: translatedText,
          language: targetLang,
          timestamp: Date.now(),
        },
      }
      await Session.updatePart(part)
      log.info("translation completed", {
        partID: part.id,
        type: part.type,
        sourceLength: text.length,
        translatedLength: translatedText.length,
        chunked: estimatedTokens > maxTokensCap,
      })
    } catch (e) {
      // 翻译失败不影响主流程，记录错误原因并标记，避免 UI 永久显示 "Translating..."
      const errorMsg = e instanceof Error ? e.message : String(e)
      log.error("translation failed", { partID: part.id, type: part.type, error: e })
      part.metadata = {
        ...part.metadata,
        translation_skipped: true,
        translation_error: errorMsg,
      }
      await bestEffortUpdatePart(part)
    }
  }

  // 标记为跳过翻译（幂等：已有标记时不重复写）
  async function markSkipped(part: MessageV2.ReasoningPart) {
    if (part.metadata?.translation_skipped || part.metadata?.translation) return
    part.metadata = { ...part.metadata, translation_skipped: true }
    await bestEffortUpdatePart(part)
  }

  // 翻译 reasoning/thinking 块
  export async function translate(part: MessageV2.ReasoningPart) {
    const cfg = await Config.get()
    const translationCfg = cfg.thinking_translation
    if (!translationCfg?.enabled && runtimeEnabled !== true) {
      await markSkipped(part)
      return
    }
    if (runtimeEnabled === false) {
      await markSkipped(part)
      return
    }
    if (!translationCfg?.model) {
      await markSkipped(part)
      return
    }

    const text = part.text.replace("[REDACTED]", "").trim()
    // 过短的 thinking 不翻译
    if (!text || text.length < 10) {
      await markSkipped(part)
      return
    }

    const targetLang = translationCfg.target_language ?? "zh-CN"
    // 如果文本已经是目标语言，跳过翻译，写入标记通知 UI
    if (isAlreadyInTargetLanguage(text, targetLang)) {
      log.info("skipped reasoning translation, text already in target language", {
        partID: part.id,
        targetLang,
      })
      await markSkipped(part)
      return
    }

    await doTranslate(part, text)
  }
}
