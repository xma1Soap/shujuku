/**
 * service/ai/ai-service.ts — AI 调用服务
 *
 * 中转 data/gateways/ai-gateway 的所有方法。
 * presentation 层通过本模块发起 AI 请求，不再直接调用 gateway。
 * 后续可在此层统一添加日志、埋点、请求限流等增值逻辑。
 */

export {
    isGenerateRawAvailable_ACU,
    isConnectionManagerAvailable_ACU,
    isTriggerSlashAvailable_ACU,
    generateRaw_ACU,
    sendConnectionManagerRequest_ACU,
    triggerSlash_ACU,
    getConnectionManagerProfiles_ACU,
    getHostRequestHeaders_ACU,
} from '../../data/gateways/ai-gateway';

import { logDebug_ACU, logError_ACU, logWarn_ACU } from '../../shared/utils';
import { getHostRequestHeaders_ACU } from '../../data/gateways/ai-gateway';

// ============================================================
// 模型列表获取
// ============================================================

export interface FetchModelsResult {
    success: boolean;
    models?: string[];
    error?: string;
}

/**
 * 从自定义 API 端点获取可用模型列表
 *
 * 通过 SillyTavern 后端代理端点 /api/backends/chat-completions/status 获取，
 * 避免浏览器 CORS 限制。后端会根据 chat_completion_source='custom' 转发到用户填写的 custom_url，
 * 并返回 { data: [{id: ...}, ...] } 格式的模型列表。
 *
 * 如果后端代理不可用（如油猴脚本模式），回退到直接 fetch 外部 API。
 */
export async function fetchAvailableModels_ACU(apiUrl: string, apiKey: string): Promise<FetchModelsResult> {
    if (!apiUrl) {
        return { success: false, error: '请输入API基础URL。' };
    }

    const trimmedUrl = (apiUrl || '').trim().replace(/\/+$/, '');
    if (!trimmedUrl) {
        return { success: false, error: '请输入API基础URL。' };
    }

    // 优先尝试通过 SillyTavern 后端代理获取（避免 CORS）
    try {
        const result = await fetchModelsViaBackend_ACU(trimmedUrl, apiKey);
        if (result.success) return result;
        // 后端代理失败，继续尝试直接请求
        logWarn_ACU('[fetchModels] 后端代理获取失败，尝试直接请求:', result.error);
    } catch (e) {
        logWarn_ACU('[fetchModels] 后端代理异常，尝试直接请求:', e);
    }

    // 回退：直接 fetch 外部 API（可能受 CORS 限制）
    return await fetchModelsDirect_ACU(trimmedUrl, apiKey);
}

/**
 * 通过 SillyTavern 后端代理获取模型列表
 */
async function fetchModelsViaBackend_ACU(apiUrl: string, apiKey: string): Promise<FetchModelsResult> {
    const headers = getHostRequestHeaders_ACU();
    if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    const body: Record<string, any> = {
        chat_completion_source: 'custom',
        custom_url: apiUrl,
        custom_api_format: 'openai_compat',
    };

    // API Key 通过 custom_include_headers 传给后端
    if (apiKey) {
        body.custom_include_headers = `Authorization: Bearer ${apiKey}`;
    }

    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-cache',
    });

    if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `后端代理状态检查失败: ${response.status} ${response.statusText}. ${errorText}` };
    }

    const data = await response.json();
    logDebug_ACU('[fetchModels] 后端代理返回:', data);

    // SillyTavern status 端点返回 { data: [{id, ...}, ...], error?: string }
    let modelsList: any[] = [];
    if (data && Array.isArray(data.data)) {
        modelsList = data.data;
    } else if (data && Array.isArray(data.models)) {
        modelsList = data.models;
    } else if (Array.isArray(data)) {
        modelsList = data;
    }

    const modelNames = modelsList
        .map((model: any) => typeof model === 'string' ? model : (model.id || model.name))
        .filter(Boolean);

    if (modelNames.length === 0) {
        const err = data?.error || '未能解析模型数据或列表为空。';
        return { success: false, error: err };
    }

    return { success: true, models: modelNames };
}

/**
 * 直接 fetch 外部 API 获取模型列表（回退方案，可能受 CORS 限制）
 */
async function fetchModelsDirect_ACU(apiUrl: string, apiKey: string): Promise<FetchModelsResult> {
    let modelsUrl = apiUrl;
    // 如果 URL 以 /chat/completions 结尾，替换为 /models
    if (modelsUrl.endsWith('/chat/completions')) {
        modelsUrl = modelsUrl.replace(/\/chat\/completions$/, '/models');
    } else if (modelsUrl.endsWith('/responses')) {
        modelsUrl = modelsUrl.replace(/\/responses$/, '/models');
    } else if (modelsUrl.endsWith('/v1')) {
        modelsUrl = modelsUrl + '/models';
    } else if (!modelsUrl.includes('/v1')) {
        modelsUrl = modelsUrl + '/v1/models';
    } else {
        modelsUrl = modelsUrl + '/models';
    }

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers,
    });

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `API端点状态检查失败: ${response.status} ${response.statusText}.`;
        try {
            const errorJson = JSON.parse(errorText);
            errorMessage += ` 详情: ${errorJson.error || errorJson.message || errorText}`;
        } catch (e) {
            errorMessage += ` 详情: ${errorText}`;
        }
        return { success: false, error: errorMessage };
    }

    const data = await response.json();
    logDebug_ACU('获取到的模型数据:', data);

    let modelsList: any[] = [];
    if (data && data.models && Array.isArray(data.models)) {
        modelsList = data.models;
    } else if (data && data.data && Array.isArray(data.data)) {
        modelsList = data.data;
    } else if (Array.isArray(data)) {
        modelsList = data;
    }

    const modelNames = modelsList
        .map((model: any) => typeof model === 'string' ? model : model.id)
        .filter(Boolean);

    if (modelNames.length === 0) {
        return { success: false, error: '未能解析模型数据或列表为空。' };
    }

    return { success: true, models: modelNames };
}
