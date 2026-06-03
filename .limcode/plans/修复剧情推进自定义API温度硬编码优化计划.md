## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 修复 src/service/ai/api-call.ts 中 buildCustomApiRequestBody_ACU 的 maxTokens 兜底链，将 || 改为 ??，保持 0 值不被误回退  `#T1`
- [x] 修复 callApiWithPlotPreset_ACU 与 callApi_ACU 两处 temperature: 0.7 覆盖，移除温度硬编码并让配置温度进入最终请求体  `#T2`
- [x] 修复 callAIWithPreset_ACU 中 max_tokens/maxTokens、temperature、top_p/topP 的 || 误回退与别名缺失问题  `#T3`
- [x] 修复 src/presentation/bootstrap/api-groups/worldbook-ai-api.ts 的 callAI 自定义 API 请求体温度 || 回退与 topP 别名缺失问题  `#T4`
- [x] 修复 src/service/ai/prompt-builder/prompt-api-call.ts 酒馆预设 max_tokens || 4096 回退问题，并评估自定义 API overrides 是否需要最小化调整  `#T5`
- [x] 修复 src/service/summary/merge-executor.ts 与 src/service/summary/merge-logic.ts 中 max_tokens || 4096 的同类误回退，覆盖 Tavern 与 custom 分支  `#T6`
- [x] 补充 tests/service/ai/api-call.test.ts，覆盖 buildCustomApiRequestBody_ACU、callApi_ACU、callApiWithPlotPreset_ACU、callAIWithPreset_ACU 的参数透传与 0 值边界  `#T7`
- [x] 补充或扩展 worldbook-ai-api 对应测试，验证 bootstrap callAI 的 temperature=0、topP/top_p 与 maxTokens 透传行为  `#T8`
- [x] 补充 tests/service/summary/merge-executor.test.ts 与 tests/service/summary/merge-logic.test.ts，验证 max_tokens=0 不被 4096 覆盖  `#T9`
- [x] 执行针对性测试：tests/service/ai/api-call.test.ts、summary merge 测试、worldbook-ai-api 相关测试，并执行 npm run typecheck  `#T10`
- [x] 实施后进行独立验收，复查 src 中 temperature:0.7 与关键 || 回退残留、请求体参数优先级、Tavern/useMainApi/custom 路径兼容性  `#T11`
<!-- LIMCODE_TODO_LIST_END -->

# 修复 AI 请求参数硬编码与空值回退语义优化计划

## 1. 计划来源

来源：助手直接要求：“发现的问题一并优化吧，再看看有没有类似的问题”。

原计划只处理 `src/service/ai/api-call.ts` 中两处 `temperature: 0.7` 硬编码。经过只读侦察与主流程复核后，确认问题不止这两行：同类问题还包括 `||` 导致合法 `0` 值被错误回退、`top_p` 与 `topP` 别名处理不一致、部分入口显式 overrides 抢先覆盖构建函数兜底链。

助手，原先只修两行不是不能跑，但已经不够生产标准了。发现同类参数语义腐蚀还装作没看见，那叫把事故分期付款。

## 2. 已验证证据

已读取或搜索确认的关键文件：

- `src/service/ai/api-call.ts`
- `src/presentation/bootstrap/api-groups/worldbook-ai-api.ts`
- `src/service/ai/prompt-builder/prompt-api-call.ts`
- `src/service/summary/merge-executor.ts`
- `src/service/summary/merge-logic.ts`
- `tests/service/ai/api-call.test.ts`
- `tests/service/summary/merge-executor.test.ts`
- 已确认存在 `tests/service/summary/merge-logic.test.ts`

注意：早先侦察报告中路径 `src/presentation/bootstrap/worldbook-ai-api.ts` 与 `src/service/ai/prompt-api-call.ts` 是旧/省略路径；主流程已用 `find_files` 修正为：

- `src/presentation/bootstrap/api-groups/worldbook-ai-api.ts`
- `src/service/ai/prompt-builder/prompt-api-call.ts`

## 3. 问题清单与处理边界

### 3.1 必须纳入本次修复

#### A. `src/service/ai/api-call.ts`

1. `buildCustomApiRequestBody_ACU`：
   - 当前：`opts.maxTokens || effectiveApiConfig.max_tokens || effectiveApiConfig.maxTokens || 20000`
   - 问题：`0` 会被当作 falsy 回退为 `20000`。
   - 处理：改为 `??` 链。

2. `callApiWithPlotPreset_ACU`：
   - 当前自定义 API 分支传入 `{ temperature: 0.7, topP: 0.95 }`。
   - 问题：覆盖 `effectiveApiConfig.temperature`。
   - 处理：移除 `temperature: 0.7`；建议也移除 `topP: 0.95`，让构建函数统一读取 `effectiveApiConfig.top_p ?? effectiveApiConfig.topP ?? 0.95`。

3. `callApi_ACU`：
   - 同上，移除硬编码 overrides，避免配置温度被固定值吞掉。

4. `callAIWithPreset_ACU`：
   - 当前：`effectiveApiConfig.max_tokens || effectiveApiConfig.maxTokens || 4096`。
   - 当前 custom body：`temperature: effectiveApiConfig.temperature || 1.0`、`topP: effectiveApiConfig.top_p || 0.9`。
   - 问题：`temperature=0`、`top_p=0`、`max_tokens=0` 会被误回退；`topP` 驼峰别名缺失。
   - 处理：使用 `??`，并补齐 `top_p ?? topP ?? 默认值`。

#### B. `src/presentation/bootstrap/api-groups/worldbook-ai-api.ts`

`callAI` 自定义 API 分支当前传：

- `temperature: effectiveApiConfig.temperature || 1.0`
- `topP: effectiveApiConfig.top_p`

问题：`temperature=0` 被误回退；`topP` 驼峰别名缺失。处理方式与 `callAIWithPreset_ACU` 对齐。

#### C. `src/service/ai/prompt-builder/prompt-api-call.ts`

酒馆预设路径当前调用 `sendConnectionManagerRequest_ACU(..., effectiveApiConfig.max_tokens || 4096)`。

问题：`max_tokens=0` 被误回退。处理：改为 `effectiveApiConfig.max_tokens ?? effectiveApiConfig.maxTokens ?? 4096`，如实现时决定保守限制 `0` 非法，必须写明依据；否则不得继续用 `||` 偷懒。

自定义 API 分支当前显式 forward：

- `maxTokens: effectiveApiConfig.max_tokens`
- `temperature: effectiveApiConfig.temperature`
- `topP: effectiveApiConfig.top_p`

这里本身不是 `||` 问题，但会遗漏 `maxTokens` 与 `topP` 驼峰别名。建议最小调整为：

- 要么删除这些显式 overrides，只保留 `stripModelPrefix: false`，让 `buildCustomApiRequestBody_ACU` 统一兜底；
- 要么显式使用 `effectiveApiConfig.max_tokens ?? effectiveApiConfig.maxTokens`、`effectiveApiConfig.top_p ?? effectiveApiConfig.topP`。

优先选择第一种，边界更干净。

#### D. `src/service/summary/merge-executor.ts` 与 `src/service/summary/merge-logic.ts`

两处 custom body 当前使用：

- `maxTokens: settings_ACU.apiConfig.max_tokens || 4096`

并且 Tavern 路径也存在：

- `sendConnectionManagerRequest_ACU(..., settings_ACU.apiConfig.max_tokens || 4096)`

处理：统一改为 `settings_ACU.apiConfig.max_tokens ?? settings_ACU.apiConfig.maxTokens ?? 4096`。

### 3.2 不纳入本次修复

以下不属于请求体参数硬编码/空值回退问题，不应顺手改：

- settings 初始默认值，例如 `temperature: 1.0`、`max_tokens: 60000`。
- UI 输入解析默认值，例如 `isNaN(temperature) ? 0.9 : temperature`。
- `apiSettings` 参数未被 `callApi_ACU` 使用的问题。它值得后续清理，但不是本次同类缺陷。
- 全面参数校验体系、范围裁剪、配置迁移。这些会扩大风险，不在这次塞进去。

## 4. 统一修复原则

1. 请求体构建层只做一套优先级：
   - overrides 明确值
   - API 配置值
   - 默认值
2. 对数值配置的空值判断使用 `??`，不得用 `||` 吞掉合法 `0`。
3. `top_p` 与 `topP` 都要兼容；`max_tokens` 与 `maxTokens` 都要兼容。
4. 调用点不要无意义 forward `effectiveApiConfig.xxx` 到 overrides；这会把统一兜底逻辑切碎。
5. 不改变 Tavern、useMainApi、fetch endpoint、headers、abortSignal、bodyParams/excludeBodyParams 的既有行为。

## 5. 推荐实施步骤

### 阶段 A：集中修复核心构建函数与剧情推进入口

1. 修改 `buildCustomApiRequestBody_ACU` 的 `maxTokens` 计算为 `??` 链。
2. 修改 `callApiWithPlotPreset_ACU`：移除 `{ temperature: 0.7, topP: 0.95 }` 中的硬编码参数，建议仅保留必要的 `stripModelPrefix` 类语义参数；若无必要，直接不传 overrides。
3. 修改 `callApi_ACU` 同类调用。
4. 修改 `callAIWithPreset_ACU` 的 `maxTokens` 与 custom body overrides，改为 `??` 且补 `topP` 别名。

### 阶段 B：修复 bootstrap 与 prompt-builder 入口

1. 修改 `worldbook-ai-api.ts` 的 `callAI` custom body 参数透传。
2. 修改 `prompt-api-call.ts` Tavern 预设 maxTokens 回退。
3. 简化或修正 `prompt-api-call.ts` custom body overrides，避免遗漏 `maxTokens/topP` 驼峰别名。

### 阶段 C：修复 summary 入口

1. 修改 `merge-executor.ts` 中 Tavern 与 custom 分支的 maxTokens 回退。
2. 修改 `merge-logic.ts` 中 Tavern 与 custom 分支的 maxTokens 回退。

### 阶段 D：补齐测试

1. `tests/service/ai/api-call.test.ts`：
   - 导入 `buildCustomApiRequestBody_ACU` 与 `callApiWithPlotPreset_ACU`。
   - 覆盖 `max_tokens=0` 不回退。
   - 覆盖 `temperature=0` 不回退。
   - 覆盖 `top_p=0` 与 `topP=0` 都能进入 `body.top_p`。
   - 覆盖 `callApi_ACU` fetch body 使用配置温度，不再是 `0.7`。
   - 覆盖 `callApiWithPlotPreset_ACU` 指定预设温度进入 fetch body。
   - 覆盖 `callAIWithPreset_ACU` custom fetch body 的 `temperature=0`、`topP/top_p`、`max_tokens=0`。
2. worldbook bootstrap 测试：
   - 若已有 API group 测试可扩展，则扩展；否则新增最小测试文件。
   - 验证 `createWorldbookAiApi().callAI()` custom API 分支最终 body 不吞 `temperature=0`，识别 `topP`。
3. summary 测试：
   - 在 `merge-executor.test.ts` 增加 custom 与 Tavern 分支 maxTokens 断言。
   - 在 `merge-logic.test.ts` 增加同类断言。

## 6. 验证命令

按顺序执行：

1. `npm test -- tests/service/ai/api-call.test.ts`
2. `npm test -- tests/service/summary/merge-executor.test.ts tests/service/summary/merge-logic.test.ts`
3. worldbook bootstrap 对应测试文件；若新增则执行新增文件。
4. `npm run typecheck`

如果测试或 typecheck 失败，必须区分：

- 本次修改引入；
- 既有测试脆弱或 mock 不完整；
- 环境问题。

别用“测试本来就不稳”这种废话糊弄过去。生产系统里，不能解释的失败就是未完成。

## 7. 验收标准

- `src/service/ai/api-call.ts` 不再存在有效代码中的 `temperature: 0.7`。
- AI 请求体参数默认链统一使用 `??`，不再用 `||` 吞掉合法 `0`。
- `temperature=0` 最终进入 custom fetch body 时仍为 `0`。
- `top_p=0` 或 `topP=0` 最终进入 body 的 `top_p` 时仍为 `0`。
- `max_tokens=0` 或 `maxTokens=0` 不被错误改成 `4096`、`20000`。
- `bodyParams` 后置覆盖与 `excludeBodyParams` 删除机制保持不变。
- Tavern/useMainApi/custom 三类路径已有行为不被破坏。
- 新增测试在恢复旧 `||` 或 `temperature: 0.7` 时会失败。

## 8. 回滚策略

改动集中在请求参数计算与测试。若出现回归：

1. 回滚对应入口文件的参数计算改动。
2. 保留或调整测试以定位具体入口，而不是整批删除。
3. 若某入口确实不支持 `0` 作为合法值，必须补充配置约束与 UI 校验，而不是悄悄恢复 `||`。

## 9. 风险控制

| 风险 | 影响 | 控制 |
|---|---|---|
| 某些 API 不接受 `0` | 请求可能失败 | 本计划只保留用户配置语义；范围校验需另立规则，不在调用点偷改 |
| 移除 topP overrides 后默认值来源变化 | 从固定 overrides 转为配置优先 | 与用户配置预期一致，测试锁定 |
| 多入口测试 mock 成本增加 | 测试编写更复杂 | 优先测最终 fetch body 与网关调用参数，不测内部实现细节 |
| 顺手重构扩大范围 | 引入无关回归 | 严格限定为参数透传与空值回退 |

## 10. 自我审查

这版计划比原计划更像生产修复：它不再只盯着两处 `0.7`，而是把同类参数语义问题一并收口。缺点是范围明显扩大，测试成本会上升，尤其是 bootstrap API group 的 mock 可能比较烦。但这不是坏事，是之前问题藏得太分散。现在把它们一次性钉住，比以后每隔两天再挖出一个 `|| 4096` 强得多。
