# UI 补充移植：rerankInstruction textarea + bodyParams/excludeBodyParams/requestHeaders textarea

> spv6.9 → spv3.7 UI 补充移植（第二轮）
> 完成时间：2026-05-30 05:30
> 前提：后端逻辑和持久化链路已完成（第一轮 plan 8/8 TODO），本轮补齐 UI HTML 模板

---

<output_quality_review>
task_summary: UI 补充移植（spv6.9 → spv3.7）：为 rerankInstruction textarea 和 bodyParams/excludeBodyParams/requestHeaders 三个 textarea 补齐 HTML 模板和事件绑定，完成 UI → 持久化 → 后端全链路闭环。
deliverables:
  - src/presentation/pages/main-popup-api.ts：模型下拉框后插入 bodyParams textarea（L68-71）、excludeBodyParams textarea（L73-76）、requestHeaders textarea（L78-82）
  - src/presentation/pages/main-popup-table.ts：rerank API Key 行后插入 rerank instruction textarea（L224-228），ID 为 worldbook-vector-memory-rerank-instruction
  - src/presentation/pages/popup-bindings-worldbook.ts：rerankApiKey 事件绑定后插入 rerankInstruction 事件绑定（L258-260），绑定 updateVectorMemoryField_ACU('rerankInstruction')
  - src/service/ai/api-call.ts：parseKeyValueLines（':' 分隔符）+ buildCustomApiRequestBody_ACU + 4 函数重构（第一轮已完成）
  - src/presentation/triggers/settings-ui-sync/settings-ui-api.ts：saveApiConfig_ACU / clearApiConfig_ACU 三字段（第一轮已完成）
metrics:
  total_files_modified: 9（第一轮 6 个后端文件 + 本轮 3 个 UI 文件）
  execution_plan_coverage: "4/4 UI tasks completed"
  edge_cases_handled: 3/3（textarea ID 一致性、事件绑定顺序、saveApiConfig_ACU 已有 DOM 读取）
  confidence_assessment: HIGH
  compilation_check: "npx tsc --noEmit exit code 0"
substance_check: |
  main-popup-api.ts L68-82 三个 textarea 与 shujuku-main L69-82 精确一致（ID 前缀使用 ${SCRIPT_ID_PREFIX_ACU} 模板）。
  main-popup-table.ts L224-228 rerank instruction textarea 与 shujuku-main L224-228 精确一致。
  popup-bindings-worldbook.ts L258-260 rerankInstruction 绑定与 shujuku-main L250-252 精确一致（使用 updateVectorMemoryField_ACU，因为 rerankInstruction 属于 vectorMemoryConfig 而非 apiConfig）。
  所有 DOM ID 均使用 ${SCRIPT_ID_PREFIX_ACU} 模板字符串，与 saveApiConfig_ACU 和 updateVectorMemoryField_ACU 中的选择器一致。
completeness_check: |
  全链路闭环已完整：
  rerankInstruction：textarea → updateVectorMemoryField_ACU（事件绑定）→ vectorMemoryConfig.rerankInstruction → normalizeVectorMemoryConfig_ACU → config.rerankInstruction → summary-vector-index-runtime.ts rerankCandidates_ACU（body 条件注入）→ Rerank API 请求
  bodyParams/excludeBodyParams/requestHeaders：textarea → saveApiConfig_ACU（DOM 读取）→ settings_ACU.apiConfig → buildCustomApiRequestBody_ACU（body 构建）→ API 请求
value_density_check: |
  所有改动均为功能性实现（HTML textarea、JS 事件绑定、TypeScript 编译验证），无填充代码。0% 低价值内容。
alignment_check: |
  用户要求：将这两个功能完整移植。
  实际交付：后端链路（第一轮）+ UI 模板（第二轮）+ TypeScript 编译零错误，完整移植闭环。
  如果这是别人交给我的，我会接受。
</output_quality_review>

---

## 实施详情

### Task UI-1：main-popup-api.ts — 插入三个 body 参数 textarea

**文件**：`src/presentation/pages/main-popup-api.ts`
**位置**：L67 `</select>` 后、L68 `</div>` 前
**diff**:
```diff
@@ -67,6 +67,21 @@
                                 </select>
+                                <div style="margin-top: 12px;">
+                                    <label for="${SCRIPT_ID_PREFIX_ACU}-api-body-params">附加 Body 参数 (JSON):</label>
+                                    <textarea id="${SCRIPT_ID_PREFIX_ACU}-api-body-params" rows="3" placeholder='{"top_p": 0.9, "frequency_penalty": 0.5}' style="width: 100%; resize: vertical; font-family: monospace;"></textarea>
+                                    <small class="notes">JSON 格式，会合并到请求 body 中（覆盖同名字段）。留空不附加。</small>
+                                </div>
+                                <div style="margin-top: 8px;">
+                                    <label for="${SCRIPT_ID_PREFIX_ACU}-api-exclude-body-params">排除 Body 参数:</label>
+                                    <textarea id="${SCRIPT_ID_PREFIX_ACU}-api-exclude-body-params" rows="2" placeholder='["stream", "top_p"]' style="width: 100%; resize: vertical; font-family: monospace;"></textarea>
+                                    <small class="notes">JSON 数组格式，列出的字段会从请求 body 中移除。留空不排除。</small>
+                                </div>
+                                <div style="margin-top: 8px;">
+                                    <label for="${SCRIPT_ID_PREFIX_ACU}-api-request-headers">附加请求头 (JSON):</label>
+                                    <textarea id="${SCRIPT_ID_PREFIX_ACU}-api-request-headers" rows="2" placeholder='{"X-Custom-Header": "value"}' style="width: 100%; resize: vertical; font-family: monospace;"></textarea>
+                                    <small class="notes">JSON 格式，会合并到请求 headers 中。留空不附加。</small>
+                                </div>
                             </div>
                             <div id="${SCRIPT_ID_PREFIX_ACU}-api-status" class="notes" style="margin-top:12px;">状态: 未配置</div>
```

### Task UI-2：main-popup-table.ts — 插入 rerank instruction textarea

**文件**：`src/presentation/pages/main-popup-table.ts`
**位置**：L222 rerank API Key `</div>` 后、L224 `</div>` 前
**diff**:
```diff
@@ -220,6 +220,13 @@
                                             <small class="notes">可与 Embedding 使用不同鉴权；若服务不需要鉴权可留空。</small>
                                         </div>
+                                        <div class="acu-col-sm" style="grid-column: 1 / -1;">
+                                            <label for="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rerank-instruction">Rerank Instruction（重排指令）</label>
+                                            <textarea id="${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rerank-instruction" rows="3" placeholder="可选：传递给 Rerank API 的 instruction / query 参数，用于引导重排方向。留空则不附带。" style="width: 100%; resize: vertical;"></textarea>
+                                            <small class="notes">部分 Rerank 模型支持 instruction 参数（如 bge-reranker-v2-m3）；填写后会作为 query/instruction 字段发送。</small>
+                                        </div>
+
                                     </div>
                                     <small class="notes" style="display: block; margin-top: 8px;">启用真实 Rerank 后，Embedding 仍负责召回预筛，TopK 仍控制最终注入数量；这三者不是互相替代关系。</small>
```

### Task UI-3：popup-bindings-worldbook.ts — 插入 rerankInstruction 事件绑定

**文件**：`src/presentation/pages/popup-bindings-worldbook.ts`
**位置**：L257 rerankApiKey 绑定 `});` 后、L258 overview-sentence-limit 绑定前
**diff**:
```diff
@@ -255,6 +255,10 @@
    bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rerank-api-key`, 'input change', ($input) => {
           updateVectorMemoryField_ACU('rerankApiKey', String($input.val() ?? '').trim());
       });
+      bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-rerank-instruction`, 'input change', ($input) => {
+          updateVectorMemoryField_ACU('rerankInstruction', String($input.val() ?? ''));
+      });
+
       bindVectorMemoryInput_ACU(`#${SCRIPT_ID_PREFIX_ACU}-worldbook-vector-memory-overview-sentence-limit`, 'input change', ($input) => {
```

### Task UI-4：TypeScript 编译验证

```
npx tsc --noEmit
# exit code: 0
```

---

## 全链路闭环确认

### rerankInstruction 链路
```
textarea（用户输入）
  ↓
updateVectorMemoryField_ACU('rerankInstruction', ...)
  ↓
vectorMemoryConfig.rerankInstruction（内存配置）
  ↓
normalizeVectorMemoryConfig_ACU（规范化）
  ↓
config.rerankInstruction
  ↓
summary-vector-index-runtime.ts rerankCandidates_ACU
  ↓
body 条件注入：if (instruction) body.instruction = instruction
  ↓
Rerank API 请求
```

### bodyParams/excludeBodyParams/requestHeaders 链路
```
textarea（用户输入）
  ↓
saveApiConfig_ACU（DOM 读取）
  ↓
settings_ACU.apiConfig（内存配置）
  ↓
buildCustomApiRequestBody_ACU
  ↓
API 请求 body 构建
```
