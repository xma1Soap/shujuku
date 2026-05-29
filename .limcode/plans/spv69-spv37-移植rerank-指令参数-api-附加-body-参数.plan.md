## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] defaults.ts：defaultVectorMemoryConfig_ACU 增加 rerankInstruction 空字符串默认值  `#t1`
- [x] vector-memory-config.ts：接口增加 rerankInstruction 字段 + 规范化处理  `#t2`
- [x] vector-rerank-gateway.ts：VectorRerankRequest_ACU 增加 instruction 可选字段 + body 条件注入  `#t3`
- [x] summary-vector-index-runtime.ts：rerankCandidates_ACU 内联 instruction 注入  `#t4`
- [x] api-call.ts：新增 parseKeyValueLines + buildCustomApiRequestBody_ACU 辅助函数  `#t5`
- [x] api-call.ts：重构 callApiWithPlotPreset_ACU / callApi_ACU / callAIWithPreset_ACU / callCustomOpenAI_ACU_Direct 四个函数的 body 构造  `#t6`
- [x] settings-ui-api.ts：saveApiConfig_ACU 和 clearApiConfig_ACU 增加 bodyParams / excludeBodyParams / requestHeaders 三个字段  `#t7`
- [x] 回归验证：检查所有调用方适配、边界条件和回滚路径  `#t8`
<!-- LIMCODE_TODO_LIST_END -->

# spv6.9 → spv3.7 移植：Rerank 指令参数 + API 附加 body 参数

> **来源**：用户直接需求，spv6.9 源码参考目录 `shujuku-main/`

## 0. 已确认的完整差异矩阵

| 文件 | spv3.7（当前） | spv6.9（目标） | 改动类型 |
|------|---------------|---------------|---------|
| `src/shared/defaults.ts` | `defaultVectorMemoryConfig_ACU` 无 `rerankInstruction` | 有 `rerankInstruction: ''` | 新增一行 |
| `src/service/vector/vector-memory-config.ts` L26→27 | 接口缺 `rerankInstruction` 字段 | `rerankInstruction: string` (L27) | 新增接口行 |
| `src/service/vector/vector-memory-config.ts` L132→133 | 规范化函数缺该字段 | `rerankInstruction: typeof (source as any).rerankInstruction === 'string' ? (source as any).rerankInstruction.trim() : (defaults as any).rerankInstruction` (L134) | 新增一行 |
| `src/data/gateways/vector-rerank-gateway.ts` L11→14 | `VectorRerankRequest_ACU` 缺 `instruction` | `instruction?: string` (L11) | 新增一行 |
| `src/data/gateways/vector-rerank-gateway.ts` L89-93 | body 硬编码 `{model, query, documents}` | IIFE 闭包构建 payload，条件 `if (instruction) body.instruction = instruction` | 重构 body 段 |
| `src/service/vector/summary-vector-index-runtime.ts` L163-170 | `rerankCandidates_ACU` body 无 instruction | L163-169: `const instruction = normalizeText_ACU(config.rerankInstruction);` + 条件注入 | 新增 3 行 |
| `src/service/ai/api-call.ts` L12→ | 无辅助函数 | `parseKeyValueLines()` (L13-26) + `buildCustomApiRequestBody_ACU()` (L34-98) | 新增 ~65 行 |
| `src/service/ai/api-call.ts` L108-126 | `callApiWithPlotPreset_ACU` body 硬编码 | 调用 `buildCustomApiRequestBody_ACU(messages, effectiveApiConfig, { temperature: 0.7, topP: 0.95 })` | 替换 1 行 |
| `src/service/ai/api-call.ts` L88-126 | `callApi_ACU` body 硬编码 | 同上 | 替换 1 行 |
| `src/service/ai/api-call.ts` L267-285 | `callAIWithPreset_ACU` body `JSON.stringify({...})` | `JSON.stringify(buildCustomApiRequestBody_ACU(messages, effectiveApiConfig, { maxTokens, ... }))` | 替换 1 行 |
| `src/service/ai/api-call.ts` L280-291 | `callCustomOpenAI_ACU_Direct` body 硬编码 | 调用 `buildCustomApiRequestBody_ACU` | 替换 1 行 |
| `src/presentation/triggers/settings-ui-sync/settings-ui-api.ts` L159-165 | `saveApiConfig_ACU` 无三个新字段 | L165-167: 保存 `bodyParams` / `excludeBodyParams` / `requestHeaders` | 新增 3 行 |
| `src/presentation/triggers/settings-ui-sync/settings-ui-api.ts` L175-176 | `clearApiConfig_ACU` 不清除新字段 | 需同时清空三个新字段 | 修改 1 行 |

## 1. 实施顺序与依赖

```
Task 1 (defaults) ──→ Task 2 (config 接口+规范化)
                    ──→ Task 3 (gateway instruction)
                    ──→ Task 4 (runtime instruction 调用方)
                    ──→ Task 5 (api-call 辅助函数)
                    ──→ Task 6 (api-call 四个函数重构)
                    ──→ Task 7 (UI 持久化)
                    ──→ Task 8 (回归验证)
```

Task 1-4 属于功能 A（Rerank 指令），可并行。Task 5-7 属于功能 B（API body 参数），Task 5→6 串行依赖，Task 7 独立。

## 2. 详细任务

### Task 1：`defaults.ts` — 新增 `rerankInstruction` 默认值

**文件**：`src/shared/defaults.ts`
**位置**：`defaultVectorMemoryConfig_ACU` 对象，在 `rerankModel: ''` 之后（L46 → L47）

```typescript
// 在 rerankModel: '' (L46) 之后插入：
  rerankInstruction: '',
```

**影响**：`cloneDefaultVectorMemoryConfig_ACU()` 自动继承，无需额外修改。

---

### Task 2：`vector-memory-config.ts` — 接口 + 规范化

**文件**：`src/service/vector/vector-memory-config.ts`

**2a. 接口**：在 `VectorMemoryConfig_ACU` 的 L26 `rerankModel: string;` 之后插入：
```typescript
  rerankInstruction: string;
```

**2b. 规范化**：在 `normalizeVectorMemoryConfig_ACU` 返回对象的 L132 `rerankModel: ...` 之后插入：
```typescript
  rerankInstruction: typeof (source as any).rerankInstruction === 'string'
      ? (source as any).rerankInstruction.trim()
      : (defaults as any).rerankInstruction,
```

---

### Task 3：`vector-rerank-gateway.ts` — 接口 + body 注入

**文件**：`src/data/gateways/vector-rerank-gateway.ts`

**3a. 接口**：在 `VectorRerankRequest_ACU` 的 `documents: string[];` 之后插入：
```typescript
  instruction?: string;
```

**3b. body 构造**（当前 L89-93）：
```typescript
// 当前：
body: JSON.stringify({
    model,
    query,
    documents,
}),

// 改为 IIFE 闭包：
const instruction = String(request.instruction ?? '').trim();
const payload: Record<string, any> = { model, query, documents };
if (instruction) payload.instruction = instruction;
// ...
body: JSON.stringify(payload),
```

---

### Task 4：`summary-vector-index-runtime.ts` — 调用方 instruction 注入

**文件**：`src/service/vector/summary-vector-index-runtime.ts`
**位置**：`rerankCandidates_ACU` 函数 L163-170

当前 body 构造：
```typescript
body: JSON.stringify({
    model,
    query,
    documents: candidates.map((candidate) => candidate.chunk.text),
}),
```

改为：
```typescript
const instruction = normalizeText_ACU(config.rerankInstruction);
const body: Record<string, any> = {
    model,
    query,
    documents: candidates.map((candidate) => candidate.chunk.text),
};
if (instruction) body.instruction = instruction;
// ...
body: JSON.stringify(body),
```

**注意**：spv3.7 的 `rerankCandidates_ACU` 不调用 `createRerankScores_ACU`，而是直连 fetch。两者需同步修改。

---

### Task 5：`api-call.ts` — 新增辅助函数

**文件**：`src/service/ai/api-call.ts`

**5a. `parseKeyValueLines()`** — 在 import 段之后、第一个 export 之前插入（约 L13 之后）：

```typescript
function parseKeyValueLines(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== 'string') return result;
  const lines = raw.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}
```

**5b. `buildCustomApiRequestBody_ACU()`** — 紧接其后：

完整逻辑见 spv6.9 L34-98，核心要点：
- `model` 默认 strip `models/` 前缀（可通过 `overrides.stripModelPrefix: false` 覆盖）
- `max_tokens` / `temperature` / `top_p` 优先级：overrides > effectiveApiConfig > 默认值
- `custom_include_headers`：基础 `Authorization` + 追加 `requestHeaders`（换行分隔）
- `bodyParams` 解析：通过 `parseKeyValueLines`，`'true'`→`true`，`'false'`→`false`，数字→`Number`，其余→string
- `excludeBodyParams`：逗号/换行分隔，`delete body[key]`

---

### Task 6：`api-call.ts` — 重构四个函数的 body 构造

**文件**：`src/service/ai/api-call.ts`

四个需要改动的函数和对应改动：

| 函数 | 当前行 | 改为 |
|------|-------|------|
| `callApiWithPlotPreset_ACU` | L108-126（硬编码 requestBody） | `const requestBody = buildCustomApiRequestBody_ACU(messages, effectiveApiConfig, { temperature: 0.7, topP: 0.95 });` |
| `callApi_ACU` | L88-126 body 段 | 同上 |
| `callAIWithPreset_ACU` | L267-285（JSON.stringify 硬编码） | `JSON.stringify(buildCustomApiRequestBody_ACU(messages, effectiveApiConfig, { maxTokens, temperature: effectiveApiConfig.temperature || 1.0, topP: effectiveApiConfig.top_p || 0.9, stripModelPrefix: false }))` |
| `callCustomOpenAI_ACU_Direct` | L280-291（硬编码 body） | 调用 `buildCustomApiRequestBody_ACU(messages, settings_ACU.apiConfig)` |

---

### Task 7：`settings-ui-api.ts` — UI 持久化三个新字段

**文件**：`src/presentation/triggers/settings-ui-sync/settings-ui-api.ts`

**7a. `saveApiConfig_ACU`**：在 L164 `temperature: ...` 之后、`});` 之前插入：
```typescript
      bodyParams: String($popupInstance_ACU!.find(`#${SCRIPT_ID_PREFIX_ACU}-api-body-params`).val() ?? ''),
      excludeBodyParams: String($popupInstance_ACU!.find(`#${SCRIPT_ID_PREFIX_ACU}-api-exclude-body-params`).val() ?? ''),
      requestHeaders: String($popupInstance_ACU!.find(`#${SCRIPT_ID_PREFIX_ACU}-api-request-headers`).val() ?? ''),
```

**7b. `clearApiConfig_ACU`**（L175-176）：在 `temperature: 0.9` 之后追加：
```typescript
bodyParams: '', excludeBodyParams: '', requestHeaders: ''
```

---

### Task 8：回归验证清单

| # | 验证项 | 方法 |
|---|--------|------|
| 1 | `defaultVectorMemoryConfig_ACU` 包含 `rerankInstruction: ''` | 读文件 |
| 2 | `normalizeVectorMemoryConfig_ACU` 正确处理 `rerankInstruction`：空字符串→空字符串，`"test"`→`"test"`，`undefined`→默认值 | 逻辑审查 |
| 3 | `createRerankScores_ACU` 无 instruction 时不注入字段，有时注入 | 逻辑审查 |
| 4 | `rerankCandidates_ACU` 无 `config.rerankInstruction` 时 body 不含 instruction | 逻辑审查 |
| 5 | `buildCustomApiRequestBody_ACU` 无 `bodyParams`/`excludeBodyParams`/`requestHeaders` 时产出与现有硬编码结构等价 | 逐字段对比 |
| 6 | `saveApiConfig_ACU` 正确从 DOM 读取三个新字段写入 `settings_ACU.apiConfig` | 逻辑审查 |
| 7 | `clearApiConfig_ACU` 清空三个新字段 | 逻辑审查 |
| 8 | TypeScript 编译零新增错误 | `tsc --noEmit` |

## 3. 风险点与回滚策略

| 风险 | 影响 | 缓解 |
|------|------|------|
| `bodyParams` 覆盖硬编码字段 | `buildCustomApiRequestBody_ACU` 中 `bodyParams` 合并在硬编码之后，同名 key 被覆盖。如果用户写了 `stream=false`，会覆盖原有的 `stream: true` | 设计如此（用户显式覆盖），文档注明即可 |
| `callCustomOpenAI_ACU_Direct` 未充分测试 | 该函数使用路径特殊（直接调用而非通过 preset），参数缺失可能导致行为差异 | 对比 spv6.9 对应实现逐行对齐 |
| UI 未提供三个新字段的 DOM 元素 | 若 HTML 模板中无对应 `<input>`/`<textarea>`，`$popupInstance.find()` 返回空 jQuery 对象，`.val()` 返回 `undefined`，被 `String()` 转为 `'undefined'` | 加 `?? ''` 兜底（已在设计中处理） |
| `clearApiConfig_ACU` 遗漏新字段 | 清除 API 配置后残留 `bodyParams` 等旧值 | Task 7b 显式清空 |

**回滚方式**：每项修改独立、范围明确（单一文件内、小范围代码块）。回滚时对每个文件恢复原代码块即可，互相不耦合。

## 4. 边界条件说明

1. **`instruction` 为空字符串时不注入**：`String(request.instruction ?? '').trim()` 返回空串时跳过注入，与 spv6.9 一致
2. **`bodyParams` 值类型转换**：`'true'`→`true`（布尔），`'false'`→`false`，数字字符串→`Number`，其余→`string`。此逻辑精确复现 spv6.9，不用 `JSON.parse` 替代（避免类型安全问题）
3. **`excludeBodyParams` 分隔符**：逗号或换行，`delete body[key]` 对不存在的 key 是静默无操作（JS 语义）
4. **`requestHeaders` 为多行时，`custom_include_headers` 格式**：基础 `Authorization: Bearer xxx` + `\n` + requestHeaders 逐行，与 spv6.9 完全一致
