<!-- LIMCODE_SOURCE_ARTIFACT_START -->
{"type":"review","path":".limcode/review/spv69-spv37-完整移植验收报告.md","contentHash":"sha256:5cd92768dc5369cc7484e809ac5dfdb8c138510a9d17dbc26b8cf24055024436"}
<!-- LIMCODE_SOURCE_ARTIFACT_END -->

## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] src/service/ai/api-call.ts parseKeyValueLines：返回值类型 Record<string, string> → Record<string, any>，增加 JSON 检测 + JSON.parse 分支，行解析增加 key 去引号和 value 去尾逗号  `#t1`
- [x] src/service/ai/api-call.ts buildCustomApiRequestBody_ACU：merge 循环增加 typeof v === 'string' guard，非字符串值直接 body[k] = v  `#t2`
- [x] 编译验证：npm run typecheck 零新增错误  `#t3`
- [x] 手动回归：行格式 bodyParams 行为不变；JSON 格式 bodyParams 正确覆盖默认字段；嵌套对象 JSON 正确赋值  `#t4`
<!-- LIMCODE_TODO_LIST_END -->

# 修复 bodyParams 不支持 JSON 输入

> **来源**：用户直接需求（实测 bug 报告）
> **关联计划**：`.limcode/plans/spv69-spv37-移植rerank-指令参数-api-附加-body-参数.plan.md`（此计划中 Task 5 的实现存在缺陷）

## 0. 根因确认

`parseKeyValueLines` (`src/service/ai/api-call.ts` L12-26) 是 bodyParams 的唯一解析入口。当用户输入 JSON 时：

| 输入 | 解析结果 | 写入 body | 实际效果 |
|------|---------|-----------|---------|
| `{"top_p": 1,` | key=`"top_p"`, value=`1,` | `body["\"top_p\""] = "1,"` | ❌ key 不匹配，原 `top_p: 0.9` 不变 |
| `"presence_penalty": 0,` | key=`"presence_penalty"`, value=`0,` | `body["\"presence_penalty\""] = "0,"` | ❌ key 不匹配 |
| `"thinking": {` | key=`"thinking"`, value=`{` | `body["\"thinking\""] = "{"` | ❌ 值错误 |

三条输入全部因 key 含引号而无法覆盖原有字段，表现就是"附加参数填了但不生效"。

## 1. 修改范围

**单一文件**：`src/service/ai/api-call.ts`

| 位置 | 改动类型 | 说明 |
|------|---------|------|
| L12 return 类型 | 修改 | `Record<string, string>` → `Record<string, any>` |
| L14-15 后 | 新增 | JSON 检测 + JSON.parse 分支 |
| L19 L21 L22 | 微调 | 行解析中的新变量名避免遮蔽、key 去引号、value 去尾逗号 |
| L77 | 微调 | merge 分支判断 `typeof v === 'string'` |

## 2. 详细改动

### 2a. `parseKeyValueLines` — 返回值类型 + JSON 检测

```typescript
function parseKeyValueLines(raw: string): Record<string, any> {
  const result: Record<string, any> = {};
  if (!raw || typeof raw !== 'string') return result;

  // JSON 检测：尝试整体 parse
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // 不是合法 JSON，回退到行解析
    }
  }

  // 行解析（保持现有逻辑 + 边界加固）
  const lines = raw.split(/\n/);
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed || lineTrimmed.startsWith('#')) continue;
    const eqIndex = lineTrimmed.indexOf(':');
    if (eqIndex <= 0) continue;
    let key = lineTrimmed.slice(0, eqIndex).trim();
    let value = lineTrimmed.slice(eqIndex + 1).trim();
    // 去除 key 的引号包裹（兼容 JSON 行混入）
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }
    // 去除 value 尾部逗号（兼容 JSON 行混入）
    if (value.endsWith(',')) {
      value = value.slice(0, -1).trimEnd();
    }
    if (key) result[key] = value;
  }
  return result;
}
```

### 2b. `buildCustomApiRequestBody_ACU` — merge 分支

当前 L77-82：
```typescript
for (const [k, v] of Object.entries(extra)) {
  if (v === 'true') body[k] = true;
  else if (v === 'false') body[k] = false;
  else if (v !== '' && !isNaN(Number(v))) body[k] = Number(v);
  else body[k] = v;
}
```

改为：
```typescript
for (const [k, v] of Object.entries(extra)) {
  if (typeof v === 'string') {
    if (v === 'true') body[k] = true;
    else if (v === 'false') body[k] = false;
    else if (v !== '' && !isNaN(Number(v))) body[k] = Number(v);
    else body[k] = v;
  } else {
    // JSON 解析路径：值已是正确类型（number/boolean/object）
    body[k] = v;
  }
}
```

## 3. 行为变化矩阵

| 输入格式 | 修复前 | 修复后 |
|---------|--------|--------|
| `top_k: 50\nfrequency_penalty: 0.5` | ✅ 正常 | ✅ 正常（不变） |
| `{"top_p": 1, "presence_penalty": 0}` | ❌ key 带引号不生效 | ✅ JSON.parse 后正确合并 |
| `{"thinking": {"type": "disabled"}}` | ❌ 嵌套对象被拍平 | ✅ 对象直接赋值 body.thinking |
| `"top_p": 1,\n"frequency_penalty": 0,` | ❌ 同上 | ✅ 去引号+去尾逗号后正确解析 |
| `{"top_p": 1` (格式错误) | N/A | 回退行解析，行为可预测 |

## 4. 调用方影响分析

`parseKeyValueLines` 仅被 `buildCustomApiRequestBody_ACU` 调用（L76），无其他调用方。`buildCustomApiRequestBody_ACU` 被以下 4 个函数调用：

| 调用方 | 行号 | 影响 |
|-------|------|------|
| `callApiWithPlotPreset_ACU` | L128 | bodyParams 现在正确合并 ✅ |
| `callApi_ACU` | L181 | 同上 ✅ |
| `callCustomOpenAI_ACU_Direct` | L254 | 同上 ✅ |
| `callAIWithPreset_ACU` | L314 | 同上 ✅ |

**无破坏性变更**：所有调用方使用传入 `effectiveApiConfig` 时，`bodyParams` 字段保持不变；`buildCustomApiRequestBody_ACU` 的返回值类型 `Record<string, any>` 不变；body 合并逻辑语义不变（仅增加 JSON 路径）。

## 5. 风险点

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| JSON.parse 抛出非 SyntaxError 异常 | 极低 | 吞掉异常回退行解析 | catch 块不区分异常类型，所有异常回退 |
| 用户误填 `{` 开头非 JSON 文本 | 低 | 行解析路径仍可工作 | JSON.parse 失败静默回退 |
| JSON 中的数组值未处理 | 低 | 数组开头 `[` 不会被 JSON 检测拦截，走行解析 | 不影响功能（用户本意不是用数组） |
| 行解析返回类型变为 `Record<string, any>` | 无 | TypeScript 编译通过 | `typeof v === 'string'` guard 保证类型安全 |

## 6. 测试策略

### 手动验证（用户侧）

1. 在 bodyParams 输入 JSON：`{"top_p": 1, "presence_penalty": 0, "frequency_penalty": 0}`
2. 触发一次自定义 API 调用
3. 观察请求体：`top_p` 应为 `1`，`presence_penalty` 应为 `0`，`frequency_penalty` 应为 `0`

### 自动化测试建议

在 `tests/service/ai/api-call.test.ts` 中增加：

- JSON 格式 bodyParams 正确覆盖默认字段
- 行格式 bodyParams 行为不变（回归）
- JSON 中嵌套对象正确赋值
- JSON 解析失败回退到行解析
- key 含双引号/single-quote 的行格式去引号后正确解析
- value 尾部逗号被正确去除

## 7. 回滚策略

修改仅在 `api-call.ts` 一个文件中、两个函数内。回滚方式：将 `parseKeyValueLines` 和 merge 循环恢复到 L12-26 和 L77-82 的原始代码即可。
