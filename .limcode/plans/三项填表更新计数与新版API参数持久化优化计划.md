## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 加固 api-preset-store savePreset 对当前活动预设/重命名场景的 settings_ACU.apiConfig 同步，并修正不存在函数的误导注释  `#impl-api-preset-save-sync`
- [x] 修正 executeCardUpdateCore_ACU 首次初始化时 updateGroupKeys 与 tracking keys 使用 allSheetKeys，确保首楼所有表显示已更新  `#impl-orchestrator-first-floor-all-sheets`
- [x] 修正 executeCardUpdateCore_ACU 非首楼目标表参与即追踪的 keysToTrackAsUpdated 口径，并保留 summary/outline 过滤  `#impl-orchestrator-participated-sheets`
- [x] 在 table-service 保存入口统一计算 keysToSave ∪ trackingSheetKeys 的追踪候选集合，仅扩大 modifiedKeys/updateGroupKeys 元数据，不扩大实际保存表  `#impl-table-service-tracking-candidates`
- [x] 补充 api-preset-store 当前活动预设参数保存与重命名同步单测  `#test-api-preset-persistence`
- [x] 补充 update-orchestrator 首楼全表登记、参与无修改仍登记、统一提交多组场景单测  `#test-orchestrator-update-counting`
- [x] 补充 table-service trackingSheetKeys 与实际保存表分离的单测  `#test-table-tracking-metadata`
- [x] 运行定向 vitest 与 npm run build，确认无回归  `#verify-targeted-and-build`
<!-- LIMCODE_TODO_LIST_END -->

# 三项填表更新计数与新版 API 参数持久化优化计划

## 1. 计划来源与目标边界

来源：助手的直接需求，要求优化三项产品行为：

1. 新开对话首次填表时，第一层应显示所有表格已更新。
2. 每轮填表中，只要某表参与本轮填表，即使 AI 没有产生实质修改，也应计入本轮已更新。
3. presentation-v2 API 配置面板保存温度、max_tokens、bodyParams 等参数后，应真正持久化到当前聊天生效配置。

目标边界：

- 不修改版本号，不发布，不打 tag。
- 不改变 `hasTrackedUpdateInMessage_ACU` 的历史判定契约，继续使用 `modifiedKeys ∪ updateGroupKeys` 判断表是否已更新。
- 不新建额外历史字段，不迁移旧聊天数据。
- 不让 Vue 组件直接写 `settings_ACU`；API 参数副作用仍由 store 承担。
- 不改增量 delta 构建、checkpoint 退化、SQLite 生命周期等无关职责。

## 2. 已确认现状与证据

### 2.1 更新计数的数据契约

- `src/service/table/table-history.ts` 中 `hasTrackedUpdateInMessage_ACU` 通过 `modifiedKeys.includes(sheetKey) || updateGroupKeys.includes(sheetKey)` 判定表是否被追踪为已更新。
- Dashboard 与调度层通过 `resolveTableHistoryStateFromChat_ACU` 消费 `hasTrackedUpdate`、`lastTrackedUpdateAiFloor`。
- 因此本次不应改读侧判定，而应修正写侧落盘的 `modifiedKeys/updateGroupKeys`。

### 2.2 写侧入口与风险

- `src/service/table/table-service.ts` 的 `persistTablesToChatMessageWithLockOption_ACU` 是保存到聊天消息的核心入口。
- 现有逻辑中 `keysToSave` 主要代表实际保存表，`trackingSheetKeys/updateGroupKeys` 代表追踪语义，但 `actuallyModifiedKeys` 的口径仍偏向实际保存/修改表。
- `keysToSave.length === 0 && trackAsUpdate && actuallyModifiedKeys.length > 0` 分支可只写追踪元数据，但前提是 `actuallyModifiedKeys` 非空；若参与表未进入该集合，会漏计数。

### 2.3 多组统一提交路径

- `src/service/table/update-orchestrator.ts` 的 `applyUnifiedGroupFillResponses_ACU` 已汇总 `allTargetSheetKeys`，并在保存时传入：
  - `updateGroupKeys: allTargetSheetKeys`
  - `trackingSheetKeys: allTargetSheetKeys`
- 但 `targetSheetKeys` 当前仍是 `modifiedKeys ∪ initializedKeys`，实际保存表与追踪表没有完全统一，需由 `table-service` 正确尊重 tracking 语义。

### 2.4 单卡 legacy 路径与首楼

- `executeCardUpdateCore_ACU` 已有 `isFirstTimeInit` 判定。
- 首次初始化时会将 `keysToActuallySave` 扩展为 `allSheetKeys` 并补齐模板表。
- 但 `updateGroupKeysRaw = isFirstTimeInit ? keysToPersist : targetSheetKeys` 导致首楼只把实际修改表作为更新组，不符合“首楼所有表已更新”。
- `keysToTrackAsUpdated` 当前在有 `keysToPersist` 时不会扩到全部参与表，导致“参与但无实质修改”仍可能漏计。

### 2.5 API 参数持久化路径

- `src/presentation-v2/stores/api-preset-store.ts` 的 `setActivePresetForCurrentChat` 会写入：
  - `settings_ACU.apiPresetBindingsByChat[currentChatKey]`
  - `settings_ACU.apiMode`
  - `settings_ACU.apiConfig`
  - `settings_ACU.tavernProfile`
  - `saveSettings_ACU()`
- `savePreset` 当前在保存后已有条件调用 `setActivePresetForCurrentChat(preset.name)`：`!hadPresets || !this.activePresetName || this.activePresetName === preset.name`。
- 风险点在于重命名、绑定名、默认名、当前 activeName 与保存 preset name 的关系；必须补测试覆盖“编辑当前活动预设参数后 settings_ACU.apiConfig 同步”。
- 注释提到 `applyCurrentChatApiPresetSelection_ACU`，但源码搜索只命中注释，不存在真实函数。切换聊天时实际由 `resetScriptStateForNewChat_ACU -> loadSettings_ACU` 和 v2 `refreshFromSettings()` 刷新 store，没有额外 service 同步函数。

## 3. 方案取舍

### 3.1 更新计数采用“写侧通用化 + orchestration 明确传参与表”

选择：优先在 `persistTablesToChatMessageWithLockOption_ACU` 中统一修正 tracking 口径，同时在 `executeCardUpdateCore_ACU` 首楼/参与表处明确传入正确 tracking keys。

理由：

- 读侧契约稳定，历史兼容风险最低。
- `table-service` 是最终落盘边界，能覆盖统一提交、legacy 单卡、旧 chat-service 包装路径。
- `update-orchestrator` 仍需要修正首楼 `updateGroupKeysRaw` 与 `keysToTrackAsUpdated`，否则传入 `table-service` 的追踪意图本身就不完整。

不选择：只改 Dashboard 文案或只改 `hasTrackedUpdateInMessage_ACU`。那是在读侧粉饰写侧缺陷，漏洞明显得像是故意排给事故看的。

### 3.2 API 持久化采用“保存当前活动预设时同步当前聊天配置”

选择：保留 `setActivePresetForCurrentChat` 作为唯一写当前聊天 API 配置的副作用入口；修正/加固 `savePreset` 的当前活动预设识别与测试。

理由：

- 组件不应直接写 `settings_ACU`。
- store 已有封装，重复造 service 函数会扩大改动面。
- 注释中的 `applyCurrentChatApiPresetSelection_ACU` 不存在，应同步更新注释，避免后续维护者继续被假函数误导。

## 4. 实施步骤

### 阶段 A：更新计数写侧修复

1. 修改 `src/service/table/table-service.ts`：
   - 在 `persistTablesToChatMessageWithLockOption_ACU` 内构建一个稳定的 `trackingCandidateKeys`：
     - 来源为 `keysToSave ∪ trackingSheetKeys`。
     - 仅保留 `effectiveTableData` 中存在的 sheet key。
     - 去重并排序。
   - 将最终写入 `modifiedKeys` 的追踪集合从“仅实际保存/修改表”扩展为“实际保存表 + trackingSheetKeys 中存在的表”。
   - 保持 `updateGroupKeys` 的去重、排序和与 `effectiveTableData` 的存在性过滤。
   - 保持增量/checkpoint 写表逻辑不变；只改追踪元数据的计算。

2. 修改 `src/service/table/update-orchestrator.ts` 的 `executeCardUpdateCore_ACU`：
   - 当 `isFirstTimeInit` 为真时：
     - `updateGroupKeysRaw` 应使用 `allSheetKeys`，而不是 `keysToPersist`。
     - `keysToTrackAsUpdated` 应使用 `allSheetKeys`。
   - 当非首楼且存在 `targetSheetKeys` 时：
     - `keysToTrackAsUpdated` 应优先使用 `targetSheetKeys` 中存在于当前表数据的 key，表示“参与即更新”。
     - 对 summary/outline 表的既有过滤规则保留，但过滤依据应基于新的 tracking keys。
   - 保留 `keysToActuallySave` 只控制实际保存表，不把“参与即更新”误解为“必须全量重写表”。

3. 检查 `applyUnifiedGroupFillResponses_ACU`：
   - 目前已传 `updateGroupKeys/trackingSheetKeys: allTargetSheetKeys`，原则上无需大改。
   - 若阶段 A 的 `table-service` 通用化后测试仍漏计，再把 `targetSheetKeys` 从 `modifiedKeys ∪ initializedKeys` 调整为“仅保存仍按 modified/initialized，tracking 保持 allTargetSheetKeys”，不要为了计数强行全量保存所有目标表。

### 阶段 B：API 参数持久化修复

1. 修改 `src/presentation-v2/stores/api-preset-store.ts`：
   - 保留 `setActivePresetForCurrentChat` 为唯一同步当前聊天 API 配置的入口。
   - 在 `savePreset` 保存后，确保以下场景会调用 `setActivePresetForCurrentChat(preset.name)`：
     - 首个预设创建。
     - 当前无活动预设。
     - 保存的是当前活动预设。
     - 重命名的是当前活动预设。
   - 更新 `refreshFromSettings` 附近关于不存在的 `applyCurrentChatApiPresetSelection_ACU` 注释，改成真实行为描述：切换聊天由 `loadSettings_ACU` 更新 `settings_ACU`，v2 listener 只负责刷新 store；store 在显式选择/保存活动预设时写回当前聊天配置。

2. 不新增 `applyCurrentChatApiPresetSelection_ACU`，除非测试证明 chat 切换绑定无法恢复。当前证据只说明注释错误，不足以引入新 service 函数。

### 阶段 C：测试补齐

1. `tests/service/table/table-service.test.ts`
   - 增加用例：仅传 `trackingSheetKeys` 且 `targetSheetKeys` 为空时，保存结果仍在 `modifiedKeys/updateGroupKeys` 中登记 tracking 表。
   - 增加用例：`targetSheetKeys` 与 `trackingSheetKeys` 混合时，实际保存表不扩大，但 tracking 表完整登记。

2. `tests/service/table/update-orchestrator.test.ts`
   - 增加首楼首次填表用例：`isFirstTimeInit` 为真时，所有 sheet 写入追踪元数据。
   - 增加参与但无实质修改用例：目标表参与本轮，AI 返回未修改或解析结果 `modifiedKeys=[]` 时，仍登记为本轮更新。
   - 增加统一提交用例：多个 group 中某个 group 的参与表没有 parsed modified keys，保存元数据仍包含其 target sheet。

3. `tests/service/table/update-scheduler.test.ts`
   - 如现有断言依赖 `lastTrackedUpdateAiFloor`，补一个回归用例确认参与表登记后下一轮 due 计算推进。

4. `tests/presentation-v2/api/api-preset-store.test.ts`
   - 增加“编辑当前活动预设后同步 `settings_ACU.apiConfig.temperature/max_tokens/bodyParams`”用例。
   - 增加“重命名当前活动预设后绑定名与当前 API 配置同步”用例。

## 5. 验证策略

按顺序执行：

1. 定向单测：
   - `npx vitest run tests/service/table/table-service.test.ts`
   - `npx vitest run tests/service/table/update-orchestrator.test.ts`
   - `npx vitest run tests/service/table/update-scheduler.test.ts`
   - `npx vitest run tests/presentation-v2/api/api-preset-store.test.ts`
   - 必要时补跑 `tests/presentation-v2/dashboard/dashboard-page.test.ts`
2. 全量构建：`npm run build`
3. 若构建或测试失败：先定位失败是否来自本次语义变更；不得用放宽断言掩盖真实回归。

## 6. 回滚策略

- 更新计数改动集中在 `table-service.ts` 与 `update-orchestrator.ts`，可按文件级 diff 回滚。
- API 持久化改动集中在 `api-preset-store.ts` 与其测试，失败时可回退到原保存逻辑。
- 因不迁移数据、不新增字段、不改读侧判定，回滚不会要求清理历史聊天数据。

## 7. 风险与控制

1. 风险：扩大 tracking 口径后，一些调用方原本“不计更新”的行为被改变。
   - 控制：只在 `trackAsUpdate` 为真时生效，并过滤到真实存在的 sheet key。

2. 风险：把“参与即更新”误写成“参与即保存全表”，导致 checkpoint 变大或覆盖风险。
   - 控制：区分 `targetSheetKeys/keysToActuallySave` 与 `trackingSheetKeys/updateGroupKeys`，只扩大 tracking，不扩大实际保存。

3. 风险：API 保存后重复调用 `saveSettings_ACU()`。
   - 控制：接受一次额外保存的低风险成本；若测试发现副作用过多，再局部合并 persist 与 setActive 的保存路径。

4. 风险：注释中的不存在函数误导后续实现。
   - 控制：本次同步修正文档注释，避免维护债继续扩大。

## 8. 验收标准

- 首次填表后，所有 sheet 的 `hasTrackedUpdate` 为 true，`lastTrackedUpdateAiFloor` 指向首个保存楼层。
- 每轮填表中，所有参与 sheet 即使无 parsed modified keys，也出现在该轮的 tracking 元数据中。
- 不参与本轮的 sheet 不应被错误标记为本轮更新。
- API 面板保存当前活动预设后，`settings_ACU.apiConfig` 立即包含新温度、max_tokens、bodyParams 等值。
- 重开/切换聊天后 v2 store 能从 settings 恢复正确 active preset 与配置。
- 上述定向 vitest 与 `npm run build` 通过。

## 9. 自我审查

这份计划能执行，但还有两个必须在实施时严控的点：

- “参与即更新”必须只扩大追踪元数据，不能扩大实际保存表，否则就是把计数需求做成了数据覆盖风险。
- API store 的现状比最初判断稍复杂：`savePreset` 已经有条件调用 `setActivePresetForCurrentChat`，所以实现时不能粗暴重复调用，而要用测试锁定重命名和当前活动预设编辑的边界。否则只是把一个隐性 bug 换成另一个竞态。
