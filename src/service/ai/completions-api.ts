/**
 * service/ai/completions-api.ts — OpenAI Chat Completions API 适配层
 *
 * 直接调用 /v1/chat/completions 端点，用于不支持 Responses API 的服务端。
 * 与 responses-api.ts 对称，提供相同的调用签名，方便在 api-call.ts 中切换。
 */

import { settings_ACU } from '../runtime/state-manager';
import { logDebug_ACU, logError_ACU } from '../../shared/utils';
import { getHostRequestHeaders_ACU } from '../../data/gateways/ai-gateway';

// ═══ 请求体构建 ═══

/**
 * 构建 Chat Completions API 请求体
 *
 * @param messages 消息数组
 * @param effectiveApiConfig API 配置
 * @param overrides 可选的参数覆盖
 * @returns Chat Completions API 请求体对象
 */
export function buildCompletionsApiRequestBody_ACU(
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

  const body: Record<string, any> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: settings_ACU.streamingEnabled || false,
  };

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
      logDebug_ACU('[Completions API] bodyParams 解析失败，忽略:', e);
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
 * 构建 Chat Completions API 请求头
 */
export function buildCompletionsApiHeaders_ACU(effectiveApiConfig: any): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (effectiveApiConfig.apiKey) {
    headers['Authorization'] = `Bearer ${effectiveApiConfig.apiKey}`;
  }

  if (effectiveApiConfig.requestHeaders) {
    const extra = effectiveApiConfig.requestHeaders.trim();
    if (extra) {
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
 * 根据用户配置的 API URL 构建 Chat Completions 端点
 */
export function buildCompletionsApiUrl_ACU(apiUrl: string): string {
  let base = (apiUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';

  // 已经指向 chat/completions
  if (base.endsWith('/chat/completions')) return base;

  // 如果 URL 以 /responses 结尾，替换为 /chat/completions
  if (base.endsWith('/responses')) {
    return base.replace(/\/responses$/, '/chat/completions');
  }

  // 如果 URL 以 /v1 结尾，追加 /chat/completions
  if (base.endsWith('/v1')) {
    return base + '/chat/completions';
  }

  // 如果 URL 不含 /v1，自动追加
  if (!base.includes('/v1')) {
    return base + '/v1/chat/completions';
  }

  return base + '/chat/completions';
}

// ═══ 响应解析 ═══

/**
 * 从 Chat Completions 非流式响应中提取文本
 */
export function parseCompletionsApiOutput_ACU(data: any): string | null {
  try {
    // Chat Completions 格式
    if (data?.choices?.[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    if (data?.choices?.[0]?.text) {
      return data.choices[0].text;
    }
    if (typeof data?.content === 'string') {
      return data.content;
    }
    // 嵌套 data 字段
    if (data?.data?.choices?.[0]?.message?.content) {
      return data.data.choices[0].message.content;
    }
    // Responses API 格式兼容
    if (data && Array.isArray(data.output)) {
      const texts: string[] = [];
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              texts.push(part.text);
            }
          }
        }
      }
      if (texts.length > 0) return texts.join('');
    }
    if (typeof data?.output_text === 'string' && data.output_text) {
      return data.output_text;
    }
    logError_ACU('[Completions API] 未能从响应中提取文本:', JSON.stringify(data)?.slice(0, 1000));
    return null;
  } catch (e) {
    logError_ACU('[Completions API] 解析响应失败:', e);
    return null;
  }
}

/**
 * 解析 Chat Completions 流式 SSE 响应
 */
export async function streamCompletionsApiToText_ACU(response: any, signal: AbortSignal | null = null): Promise<string> {
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

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) fullContent += delta;

          // 兼容非标准字段
          if (json?.choices?.[0]?.text) {
            fullContent += json.choices[0].text;
          }
        } catch {
          // 忽略 JSON 解析错误
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent;
}

/**
 * 统一处理 Chat Completions API 响应
 */
export async function handleCompletionsApiResponse_ACU(response: any, signal: AbortSignal | null = null): Promise<string | null> {
  if (settings_ACU.streamingEnabled) {
    return await streamCompletionsApiToText_ACU(response, signal);
  } else {
    const data = await response.json();
    logDebug_ACU('[Completions API] 后端代理非流式响应:', JSON.stringify(data)?.slice(0, 500));
    return parseCompletionsApiOutput_ACU(data);
  }
}

// ═══ 完整调用函数 ═══

/**
 * 直接调用 OpenAI Chat Completions API
 *
 * 通过 SillyTavern 后端代理 /api/backends/chat-completions/generate 发送请求，
 * 避免浏览器 CORS 限制。与 callResponsesApiDirect_ACU 签名完全一致。
 */
export async function callCompletionsApiDirect_ACU(
  messages: Array<{ role: string; content: string }>,
  effectiveApiConfig: any,
  overrides?: { maxTokens?: number; temperature?: number; topP?: number; stripModelPrefix?: boolean },
  signal: AbortSignal | null = null,
): Promise<string> {
  if (!effectiveApiConfig.url || !effectiveApiConfig.model) {
    throw new Error('自定义API的URL或模型未配置。');
  }

  const opts = overrides || {};
  const model = opts.stripModelPrefix !== false
    ? (effectiveApiConfig.model || '').replace(/^models\//, '')
    : (effectiveApiConfig.model || '');
  const maxTokens = opts.maxTokens ?? effectiveApiConfig.max_tokens ?? effectiveApiConfig.maxTokens ?? 20000;
  const temperature = opts.temperature ?? effectiveApiConfig.temperature ?? 1.0;
  const topP = opts.topP ?? effectiveApiConfig.top_p ?? effectiveApiConfig.topP ?? 0.95;

  // 构建发往后端代理的请求体
  const generateBody: Record<string, any> = {
    messages,
    model,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    stream: settings_ACU.streamingEnabled || false,
    chat_completion_source: 'custom',
    custom_url: effectiveApiConfig.url,
    custom_api_format: 'openai_compat',
    include_reasoning: false,
    reasoning_effort: 'medium',
    enable_web_search: false,
    request_images: false,
    custom_prompt_post_processing: 'strict',
    reverse_proxy: '',
    proxy_password: '',
    group_names: [],
  };

  // API key 通过 custom_include_headers 传给后端
  let includeHeaders = '';
  if (effectiveApiConfig.apiKey) {
    includeHeaders = `Authorization: Bearer ${effectiveApiConfig.apiKey}`;
  }
  // 追加用户自定义请求头
  if (effectiveApiConfig.requestHeaders) {
    const extra = effectiveApiConfig.requestHeaders.trim();
    if (extra) {
      includeHeaders = includeHeaders ? `${includeHeaders}\n${extra}` : extra;
    }
  }
  if (includeHeaders) {
    generateBody.custom_include_headers = includeHeaders;
  }

  // 附加 body 参数
  if (effectiveApiConfig.bodyParams) {
    generateBody.custom_include_body = effectiveApiConfig.bodyParams;
  }
  if (effectiveApiConfig.excludeBodyParams) {
    generateBody.custom_exclude_body = effectiveApiConfig.excludeBodyParams;
  }

  const headers = getHostRequestHeaders_ACU();
  if (!headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  logDebug_ACU('[Completions API] 通过后端代理调用, Model:', effectiveApiConfig.model);

  const response = await fetch('/api/backends/chat-completions/generate', {
    method: 'POST',
    headers,
    body: JSON.stringify(generateBody),
    signal,
  });

  if (!response.ok) {
    const errTxt = await response.text();
    throw new Error(`API请求失败: ${response.status} ${errTxt}`);
  }

  const content = await handleCompletionsApiResponse_ACU(response, signal);
  if (content) {
    return content.trim();
  }

  throw new Error('API响应格式不正确或内容为空。');
}