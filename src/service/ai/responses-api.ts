/**
 * service/ai/responses-api.ts — OpenAI Responses API 适配层
 *
 * 将原 Chat Completions 调用方式替换为直接调用 OpenAI Responses API（/v1/responses）。
 * 仅用于 custom 模式；tavern 模式仍走酒馆内部接口。
 */

import { settings_ACU } from '../runtime/state-manager';
import { logDebug_ACU, logError_ACU } from '../../shared/utils';

// ═══ 请求体构建 ═══

/**
 * 将 Chat Completions 的 messages 数组转换为 Responses API 的 input + instructions。
 *
 * - role === 'system' 的消息会被提取合并到顶层 instructions。
 * - 其余消息保持 { role, content } 结构，作为 input 数组。
 *
 * @param messages Chat Completions 格式的消息数组
 * @returns { instructions, input }
 */
export function convertMessagesToResponsesInput_ACU(
  messages: Array<{ role: string; content: string }>,
): { instructions: string; input: Array<{ role: string; content: string }> } {
  const systemMessages: string[] = [];
  const input: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      if (msg.content) systemMessages.push(msg.content);
    } else {
      input.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    instructions: systemMessages.join('\n\n'),
    input,
  };
}

/**
 * 构建 Responses API 请求体
 *
 * @param messages Chat Completions 格式的消息数组
 * @param effectiveApiConfig API 配置（url, model, apiKey, max_tokens, temperature, top_p 等）
 * @param overrides 可选的参数覆盖
 * @returns Responses API 请求体对象
 */
export function buildResponsesApiRequestBody_ACU(
  messages: Array<{ role: string; content: string }>,
  effectiveApiConfig: any,
  overrides?: { maxTokens?: number; temperature?: number; topP?: number; stripModelPrefix?: boolean },
): Record<string, any> {
  const opts = overrides || {};
  const model = opts.stripModelPrefix !== false
    ? (effectiveApiConfig.model || '').replace(/^models\//, '')
    : (effectiveApiConfig.model || '');
  const maxTokens = opts.maxTokens ?? effectiveApiConfig.max_tokens ?? effectiveApiConfig.maxTokens ?? 20000;
  const temperature = opts.temperature ?? effectiveApiConfig.temperature ?? 1.0;
  const topP = opts.topP ?? effectiveApiConfig.top_p ?? effectiveApiConfig.topP ?? 0.95;

  const { instructions, input } = convertMessagesToResponsesInput_ACU(messages);

  const body: Record<string, any> = {
    model,
    input,
    max_output_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: settings_ACU.streamingEnabled || false,
  };

  if (instructions) {
    body.instructions = instructions;
  }

  // reasoning 配置（如果配置中有）
  if (effectiveApiConfig.reasoning_effort) {
    body.reasoning = {
      effort: effectiveApiConfig.reasoning_effort,
      summary: effectiveApiConfig.reasoning_summary ?? 'auto',
    };
  }

  // 用户自定义 body 参数透传（bodyParams）
  if (effectiveApiConfig.bodyParams) {
    try {
      const extra = typeof effectiveApiConfig.bodyParams === 'string'
        ? JSON.parse(effectiveApiConfig.bodyParams)
        : effectiveApiConfig.bodyParams;
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        Object.assign(body, extra);
      }
    } catch (e) {
      logDebug_ACU('[Responses API] bodyParams 解析失败，忽略:', e);
    }
  }

  // 排除指定字段（excludeBodyParams）
  if (effectiveApiConfig.excludeBodyParams) {
    const excludeRaw = typeof effectiveApiConfig.excludeBodyParams === 'string'
      ? effectiveApiConfig.excludeBodyParams
      : '';
    if (excludeRaw) {
      const keys = excludeRaw.split(/[,\n]/).map((s: string) => s.trim().replace(/^-\s*/, '')).filter(Boolean);
      for (const key of keys) {
        delete body[key];
      }
    }
  }

  return body;
}

// ═══ 请求头构建 ═══

/**
 * 构建 Responses API 请求头（含认证 + 自定义请求头）
 *
 * @param effectiveApiConfig API 配置
 * @returns HTTP 请求头对象
 */
export function buildResponsesApiHeaders_ACU(effectiveApiConfig: any): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Authorization
  if (effectiveApiConfig.apiKey) {
    headers['Authorization'] = `Bearer ${effectiveApiConfig.apiKey}`;
  }

  // 用户自定义请求头
  if (effectiveApiConfig.requestHeaders) {
    const extra = effectiveApiConfig.requestHeaders.trim();
    if (extra) {
      // 按行解析 "Key: Value" 格式
      for (const line of extra.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim();
          headers[key] = value;
        }
      }
    }
  }

  return headers;
}

// ═══ 端点 URL 构建 ═══

/**
 * 根据用户配置的 API URL 构建 Responses API 端点
 *
 * @param apiUrl 用户配置的基础 URL，如 "https://api.openai.com/v1" 或 "https://api.openai.com"
 * @returns 完整的 Responses API 端点 URL
 */
export function buildResponsesApiUrl_ACU(apiUrl: string): string {
  let base = (apiUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';

  // 如果 URL 已经以 /responses 结尾，直接使用
  if (base.endsWith('/responses')) return base;

  // 如果 URL 以 /chat/completions 结尾，替换为 /responses
  if (base.endsWith('/chat/completions')) {
    return base.replace(/\/chat\/completions$/, '/responses');
  }

  // 如果 URL 以 /v1 结尾，追加 /responses
  if (base.endsWith('/v1')) {
    return base + '/responses';
  }

  // 如果 URL 不含 /v1，自动追加 /v1/responses
  // 常见情况：https://api.openai.com → https://api.openai.com/v1/responses
  if (!base.includes('/v1')) {
    return base + '/v1/responses';
  }

  // 其他情况直接追加 /responses
  return base + '/responses';
}

// ═══ 响应解析 ═══

/**
 * 从 Responses API 非流式响应中提取文本内容
 *
 * 遍历 output 数组，找到 type === "message" 的 item，
 * 再从其 content 数组中提取 type === "output_text" 的 text 字段。
 *
 * @param data Responses API 响应 JSON
 * @returns 提取的文本，失败返回 null
 */
export function parseResponsesApiOutput_ACU(data: any): string | null {
  try {
    if (!data || !Array.isArray(data.output)) {
      logError_ACU('[Responses API] 响应中缺少 output 数组:', data);
      return null;
    }

    const texts: string[] = [];
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            texts.push(part.text);
          }
          // 兼容 refusal
          if (part.type === 'refusal' && typeof part.refusal === 'string') {
            texts.push(part.refusal);
          }
        }
      }
    }

    if (texts.length > 0) {
      return texts.join('');
    }

    // 兜底：尝试 data.output_text（SDK convenience field）
    if (typeof data.output_text === 'string' && data.output_text) {
      return data.output_text;
    }

    logError_ACU('[Responses API] 未能从响应中提取文本:', data);
    return null;
  } catch (e) {
    logError_ACU('[Responses API] 解析响应失败:', e);
    return null;
  }
}

/**
 * 解析 Responses API 流式 SSE 响应，提取完整文本
 *
 * Responses API 流式格式为 typed SSE events：
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"Hello",...}
 *
 * 终止事件：
 *   response.completed / response.failed / response.incomplete / error
 *
 * @param response fetch Response 对象
 * @param signal AbortSignal
 * @returns 完整文本
 */
export async function streamResponsesApiToText_ACU(response: any, signal: AbortSignal | null = null): Promise<string> {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEventType = '';

      for (const line of lines) {
        const trimmed = line.trim();

        // SSE event 行
        if (trimmed.startsWith('event: ')) {
          currentEventType = trimmed.slice(7).trim();
          continue;
        }

        // SSE data 行
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);

          if (data === '[DONE]') {
            continue;
          }

          try {
            const json = JSON.parse(data);

            // 文本增量
            if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') {
              fullContent += json.delta;
            }

            // 拒绝增量
            if (json.type === 'response.refusal.delta' && typeof json.delta === 'string') {
              fullContent += json.delta;
            }

            // 错误事件
            if (json.type === 'error' || json.type === 'response.failed') {
              const errMsg = json.message || json.error?.message || JSON.stringify(json);
              logError_ACU('[Responses API] 流式响应错误事件:', errMsg);
              throw new Error(`API 流式响应错误: ${errMsg}`);
            }

            // 不完整
            if (json.type === 'response.incomplete') {
              const reason = json.response?.incomplete_details?.reason || 'unknown';
              logDebug_ACU('[Responses API] 响应不完整，原因:', reason);
              break;
            }
          } catch (e) {
            // 如果是我们自己 throw 的错误，向上传播
            if (e instanceof Error && e.message.startsWith('API 流式响应错误')) {
              throw e;
            }
            // 忽略 JSON 解析错误
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent;
}

/**
 * 统一处理 Responses API 响应（流式 / 非流式）
 *
 * @param response fetch Response 对象
 * @param signal AbortSignal
 * @returns 提取的文本内容
 */
export async function handleResponsesApiResponse_ACU(response: any, signal: AbortSignal | null = null): Promise<string | null> {
  if (settings_ACU.streamingEnabled) {
    return await streamResponsesApiToText_ACU(response, signal);
  } else {
    const data = await response.json();
    return parseResponsesApiOutput_ACU(data);
  }
}

// ═══ 完整调用函数 ═══

/**
 * 直接调用 OpenAI Responses API
 *
 * 完整封装：构建请求 → 发送 → 解析响应，返回文本。
 * 供各调用点使用，替代原 fetch('/api/backends/chat-completions/generate') + handleApiResponse_ACU。
 *
 * @param messages Chat Completions 格式的消息数组
 * @param effectiveApiConfig API 配置（必须包含 url 和 model）
 * @param overrides 可选的参数覆盖
 * @param signal AbortSignal
 * @returns AI 响应文本
 * @throws 如果 URL/模型未配置、请求失败或响应无效
 */
export async function callResponsesApiDirect_ACU(
  messages: Array<{ role: string; content: string }>,
  effectiveApiConfig: any,
  overrides?: { maxTokens?: number; temperature?: number; topP?: number; stripModelPrefix?: boolean },
  signal: AbortSignal | null = null,
): Promise<string> {
  if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
    throw new Error('自定义API的URL或模型未配置。');
  }

  const url = buildResponsesApiUrl_ACU(effectiveApiConfig.url);
  const headers = buildResponsesApiHeaders_ACU(effectiveApiConfig);
  const body = JSON.stringify(buildResponsesApiRequestBody_ACU(messages, effectiveApiConfig, overrides));

  logDebug_ACU('[Responses API] 直接调用:', url, 'Model:', effectiveApiConfig.model);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal,
  });

  if (!response.ok) {
    const errTxt = await response.text();
    throw new Error(`API请求失败: ${response.status} ${errTxt}`);
  }

  const content = await handleResponsesApiResponse_ACU(response, signal);
  if (content) {
    return content.trim();
  }

  throw new Error('API响应格式不正确或内容为空。');
}