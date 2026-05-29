## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] main-popup-api.ts：在模型下拉框后插入 bodyParams/excludeBodyParams/requestHeaders 三个 textarea  `#ui-1`
- [x] main-popup-table.ts：在 rerank API key 后插入 rerankInstruction textarea  `#ui-2`
- [x] popup-bindings-worldbook.ts：在 rerankApiKey 绑定后插入 rerankInstruction 事件绑定  `#ui-3`
- [x] TypeScript 编译验证：npx tsc --noEmit 零错误  `#ui-4`
<!-- LIMCODE_TODO_LIST_END -->

# UI 补充移植：rerankInstruction + bodyParams/excludeBodyParams/requestHeaders

> **来源**：用户直接需求——完整移植两个功能。后端逻辑和持久化链路已在上一轮计划中完成（8/8 TODO，TypeScript 编译零错误）。本轮补齐 UI HTML 模板，实现后端→UI→持久化全链路闭环。
> **参考**：`shujuku-main/src/presentation/`（spv6.9 完整 UI）

---

## 0. 精确差异矩阵

### 差异 A：main-popup-api.ts — 三个 body 参数 textarea

| | spv6.9 | spv3.7 |
|--|--------|--------|
| 文件 | `shujuku-main/src/presentation/pages/main-popup-api.ts` L68-82 | `src/presentation/pages/main-popup-api.ts` |
| 状态 | 有三个 `<div>` 块（bodyParams L69-72 / excludeBodyParams L73-77 / requestHeaders L78-82），位于 `</select>` 和 `<div id="api-status">` 之间 | `</select>`（L67）后直接跳到 `</div><div id="api-status">`（L68-69），**缺这三块** |

### 差异 B：main-popup-table.ts — rerank instruction textarea

| | spv6.9 | spv3.7 |
|--|--------|--------|
| 文件 | `shujuku-main/src/presentation/pages/main-popup-table.ts` L224-228 | `src/presentation/pages/main-popup-table.ts` |
| 状态 | 在 rerank API key `</div>` 后、rerank 区块 `</div>` 前有 `<div class="acu-col-sm" style="grid-column: 1 / -1;">` 含 `<label>` + `<textarea>` + `<small>` | L222 rerank API key `</div>` 后直接跳到 L224 `</div>`，**缺该块** |

### 差异 C：popup-bindings-worldbook.ts — rerankInstruction 事件绑定

| | spv6.9 | spv3.7 |
|--|--------|--------|
| 文件 | `shujuku-main/src/presentation/pages/popup-bindings-worldbook.ts` L250-252 | `src/presentation/pages/popup-bindings-worldbook.ts` |
| 状态 | rerankApiKey 绑定后有 `bindVectorMemoryInput_ACU('#...rerank-instruction', ...)` | L257 rerankApiKey 绑定后直接跳到 L258 overview-sentence-limit 绑定，**缺该绑定** |

---

## 1. 实施任务

### Task UI-1：main-popup-api.ts — 插入三个 body 参数 textarea

**文件**：`src/presentation/pages/main-popup-api.ts`
**位置**：L67 `</select>` 后、L68 `</div>` 前
**操作**：在 `</select>\n` 和 `</div>\n<div id="` 之间，插入 spv6.9 L68-82 的三个 `<div>` 块（精确复制）。所有 ID 使用 `${SCRIPT_ID_PREFIX_ACU}` 模板字符串。
**验证**：read_file 确认 `api-body-params`、`api-exclude-body-params`、`api-request-headers` 三个 ID 存在于文件中。

### Task UI-2：main-popup-table.ts — 插入 rerank instruction textarea

**文件**：`src/presentation/pages/main-popup-table.ts`
**位置**：L222 rerank API key `</div>` 后、L224 `</div>` 前
**操作**：在 rerank API key 的 `</div>\n` 和 `</div>\n<small class="notes" style="display: block;` 之间，插入 spv6.9 L224-228 的 `<div class="acu-col-sm" style="grid-column: 1 / -1;">` 块。
**验证**：read_file 确认 `worldbook-vector-memory-rerank-instruction` ID 存在。

### Task UI-3：popup-bindings-worldbook.ts — 插入 rerankInstruction 事件绑定

**文件**：`src/presentation/pages/popup-bindings-worldbook.ts`
**位置**：L257 rerankApiKey 绑定 `});` 后、L258 overview-sentence-limit 绑定前
**操作**：插入 spv6.9 L250-252 的 `bindVectorMemoryInput_ACU` 调用块（2 行空行 + 3 行绑定代码）。
**验证**：read_file 确认包含 `worldbook-vector-memory-rerank-instruction` 和 `updateVectorMemoryField_ACU('rerankInstruction'`。

### Task UI-4：TypeScript 编译验证

**操作**：`npx tsc --noEmit`
**验证**：exit code 0，零新增错误。HTML 模板字符串中的 ID 变更不产生 TypeScript 类型错误。

---

## 2. 依赖关系

```
Task UI-1 ──→ 可并行
Task UI-2 ──→ 可并行
Task UI-3 ──→ 可并行（事件绑定使用 jQuery 选择器，与 HTML 渲染时序无关）
                    ──→ Task UI-4（编译验证）
```

---

## 3. 风险与回滚

| 风险 | 缓解 |
|------|------|
| HTML 插入位置偏移导致布局错乱 | 使用 `apply_diff`，`old_string` 精确匹配目标上下文行 |
| 事件绑定 ID 与 HTML ID 不一致 | 直接从 spv6.9 精确复制，不手动改写 ID |
| saveApiConfig_ACU 已读取这些 DOM ID | bodyParams 三字段在 settings-ui-api.ts L165-167 已存在 DOM 读取逻辑，textarea 插入后立即生效，无需修改该文件 |

**回滚**：每项修改为独立 diff 块，删除对应插入内容即可恢复。
