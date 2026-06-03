## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 在 loadBatchBaseData_ACU 叠加历史 incrementalData 后，对 mergedBatchData[sheetKey].content 应用稳定 row_id 兜底并保持 guide 结构恢复顺序正确  `#impl-loadbatch-delta-merge-normalize`
- [x] 在 persistCore 构建本轮 delta 前，对 prevTagData.independentData[sheetKey] 的 base 副本应用稳定 row_id 兜底后再 buildTableDelta_ACU  `#impl-persistcore-delta-build-base-normalize`
- [x] 在 persistCore 处理既有 delta 楼层重建 independentData 时，对 baseSheet 应用稳定 row_id 兜底后再 applyTableDelta_ACU  `#impl-persistcore-delta-rebuild-base-normalize`
- [x] 确认 spv3.9.8 后 base_no_stable_row_id 的真实调用链、base 来源与上一轮修复盲区  `#recon-runtime-base-rowid`
- [x] 实现后调用独立验收专家复验修复点、测试覆盖、发布风险与提交范围  `#review-runtime-base-rowid`
- [x] 补充集成回归覆盖同一 saveTargetIndex 多组分批持久化时不再触发 base_no_stable_row_id  `#tests-integration-concurrent-groups`
- [x] 补充 table-service 单测覆盖缺失 row_id、重复 row_id、既有 delta 楼层重建三类运行时 base 兜底  `#tests-table-service-runtime-base`
- [x] 补充 update-orchestrator 单测覆盖 loadBatchBaseData_ACU 叠加 delta 后仍输出稳定 row_id  `#tests-update-orchestrator-batch-base`
- [x] 运行定向 vitest、现有 table-delta 退化语义测试与 npm run build，确认不改版本号且不污染发布提交范围  `#verify-runtime-base-rowid`
<!-- LIMCODE_TODO_LIST_END -->

# 修复运行时 base 缺少稳定 row_id 退化 checkpoint 计划

## 1. 计划来源与目标边界

来源：助手报告 spv3.9.8 发布后，并发填表仍在运行时打印：

- `index.js:1667 [shujuku_v120] [表格增量] sheet_SystemRules: base 缺少稳定 row_id，退化为 checkpoint`
- 堆栈指向 `buildTableDelta_ACU -> persistCore -> persistTablesToChatMessageWithLockOption_ACU -> saveIndependentTableToChatHistoryWithinScopeLock_ACU -> runTableUpdateApplyWithScopeLock_ACU -> executeCardUpdateCore_ACU`
- 现象是 4 组并发分组时同类 warning 重复出现。

目标：补齐运行时读侧 base 稳定化，确保旧历史楼层或 delta 合并链路里残留的缺失/重复 `row_id` 不会继续污染 `buildTableDelta_ACU` 的 base 输入，从而避免本可落 delta 的保存退化为 checkpoint。

明确不做：

- 不修改 `buildTableDelta_ACU` 的安全退化职责；它仍必须在收到不稳定 base/next 时返回 `base_no_stable_row_id` 或 `next_no_stable_row_id`。
- 不通过调低日志级别、吞 warning、删除测试来伪装修复。那种做法漏洞明显得像是故意排给事故看的。
- 不修改 `manifest.json` / `package.json` 版本号。
- 不把 `.limcode/*`、`.analysis-archive/*`、`.analysis-cache.md`、`vitest-out.txt` 等状态层文件夹进后续发布 commit。

## 2. 已验证代码证据

### 2.1 persistCore 既有 delta 楼层重建路径未稳定化 base

文件：`src/service/table/table-service.ts:149-164`

- `independentData = prevTagData?.independentData ? JSON.parse(JSON.stringify(prevTagData.independentData)) : ...`
- `baseSheet = independentData[sheetKey] || existingCheckpointData[sheetKey]`
- `independentData[sheetKey] = applyTableDelta_ACU(baseSheet, delta, sheetKey)`

问题：这里从上一楼层或当前 checkpoint 拷贝出的 `baseSheet` 未经过 `ensureStableRowIdsForSheetContent_ACU`。如果历史楼层已经脏，重建出的 `independentData` 继续携带脏 row_id。

### 2.2 persistCore 本轮 delta 构建前未稳定化 prev base

文件：`src/service/table/table-service.ts:204-230`

- L204-L213 只对 `effectiveTableData[sheetKey]` 的 `next` 调用了 `ensureStableRowIdsForSheetContent_ACU`。
- L229 `baseSheet = prevTagData.independentData[sheetKey]` 直接进入 `buildTableDelta_ACU(baseSheet, nextSheet, sheetKey)`。

问题：上一轮 spv3.9.8 修复只覆盖写侧 next，没有覆盖读侧 base。并发分组在同一 `saveTargetIndex` 上每组都会读取同一个脏 `prevTagData`，所以每组都可能独立触发 `base_no_stable_row_id`。

### 2.3 loadBatchBaseData_ACU 历史 delta 累加后未兜底稳定化

文件：`src/service/table/update-orchestrator.ts:287-301`

- `mergedBatchData[sheetKey] = applyTableDelta_ACU(mergedBatchData[sheetKey], incrementalData[sheetKey], sheetKey)`
- 随后只调用 `restoreGuideStructure(...)`，未稳定化 content。

问题：批量读取 base 时，历史 delta 正序叠加结果如果包含缺失/重复 `row_id`，会作为后续填表 base 继续流入持久化链路。

### 2.4 buildTableDelta_ACU 的退化语义应保留

文件：`src/service/table/table-delta.ts:122-129`

- base 不稳定：`degradeReason: 'base_no_stable_row_id'`
- next 不稳定：`degradeReason: 'next_no_stable_row_id'`

这是安全闸门，不是 bug 本体。真正的问题是上游把可修复的历史 base 脏数据未经兜底送进了安全闸门。

## 3. 实施策略

采用最小侵入的“三点读侧兜底”方案。能列 TODO 不等于能交付，所以这里按数据流入口布防，而不是在 warning 发生处粉饰太平。

### 3.1 修复点 A：persistCore 重建既有 delta 楼层时稳定化 baseSheet

位置：`src/service/table/table-service.ts:149-164`

实施要求：

1. 在 `baseSheet` 进入 `applyTableDelta_ACU` 之前，创建深拷贝副本，避免原地污染 `prevTagData` 或 `existingCheckpointData`。
2. 如果副本存在 `content` 数组，调用 `ensureStableRowIdsForSheetContent_ACU`。
3. 用稳定化后的 base 副本调用 `applyTableDelta_ACU`。
4. 保持现有缺 base fallback warning 与 `existingCheckpointData` 保留逻辑不变。

验收点：旧 delta 楼层重建时不会把缺失/重复 `row_id` 原样带入本轮 `independentData`。

### 3.2 修复点 B：persistCore 构建本轮 delta 前稳定化 prev base

位置：`src/service/table/table-service.ts:226-230`

实施要求：

1. `const baseSheet = prevTagData.independentData[sheetKey]` 后，不直接传给 `buildTableDelta_ACU`。
2. 建立 `normalizedBaseSheet` 深拷贝；若 `content` 为数组，调用 `ensureStableRowIdsForSheetContent_ACU`。
3. 使用 `normalizedBaseSheet` 与已经稳定化过的 `nextSheet` 调用 `buildTableDelta_ACU`。
4. 对不存在 base 的场景不新增无意义兜底；让现有 delta 安全判断继续处理。

验收点：同一 `saveTargetIndex` 多组分批保存时，每组即使读到旧脏 `prevTagData`，也在本组构建 delta 前本地修复 base 副本，不再重复触发 `base_no_stable_row_id`。

### 3.3 修复点 C：loadBatchBaseData_ACU 叠加历史 delta 后稳定化 mergedBatchData

位置：`src/service/table/update-orchestrator.ts:294-296`

实施要求：

1. `applyTableDelta_ACU` 后保留 `restoreGuideStructure`。
2. 在 guide 结构恢复之后，对 `mergedBatchData[sheetKey].content` 调用 `ensureStableRowIdsForSheetContent_ACU`。
3. 若当前文件尚未导入 helper，则从正确模块导入；不得复制粘贴 helper 逻辑。
4. 保证稳定 row_id 不被重写；只补缺失、空值和重复项。

验收点：批量 base 重建链路输出稳定 content，避免下一轮填表拿到脏 base。

## 4. 测试计划

### 4.1 table-service 单测

文件：`tests/service/table/table-service.test.ts`

新增或扩展用例：

1. `prevTagData.independentData[sheetKey].content` 缺失 `row_id`，`effectiveTableData` 为已稳定 next，本轮保存应落 delta，不能退化为 checkpoint。
2. `prevTagData.independentData[sheetKey].content` 存在重复 `row_id`，本轮保存应通过稳定化 base 副本构建 delta。
3. 当前目标楼层已经是 delta tag，重建 `independentData` 时，上一楼层 base 脏数据经 `applyTableDelta_ACU` 后输出稳定 row_id。

断言建议：

- `currentTagData.incrementalData[sheetKey]` 存在。
- `currentTagData.independentData[sheetKey].content` 中 row_id 全部非空且唯一。
- spy `logWarn_ACU` 不包含 `base 缺少稳定 row_id`。

### 4.2 update-orchestrator 单测

文件：优先查找现有 `tests/service/table/update-orchestrator*.test.ts`；若不存在，新增 `tests/service/table/update-orchestrator.test.ts`。

用例：

- 构造 checkpoint base + 多个 pending delta，叠加后产生缺失或重复 row_id 风险；调用 `loadBatchBaseData_ACU` 后，返回的 `mergedBatchData[sheetKey].content` 必须稳定。

注意：如果该函数依赖宿主聊天上下文，优先复用既有 mock 工具，不要为了一个测试写一套脆弱伪宿主。

### 4.3 集成回归

文件：`tests/integration/table-lifecycle.test.ts`

用例：模拟同一 `saveTargetIndex` 上多组分批落盘：

1. 上一楼层 checkpoint 或 delta 合并结果含脏 base。
2. 4 个更新组依次调用持久化入口。
3. 每组 next 都已经稳定。
4. 断言所有组不再打印 `base_no_stable_row_id`，最终楼层仍能保存所有目标 sheet 的变更。

如果现有集成 mock 难以表达 4 组并发，可先落可维护的“同一目标楼层连续多次 persist”测试；不要写靠定时器碰运气的并发测试。那不是测试，是赌博。

### 4.4 保留现有退化测试

必须继续保留 `tests/service/table/table-delta.test.ts` 中 base/next 不稳定时退化的用例，证明 `buildTableDelta_ACU` 安全闸门没有被削弱。

## 5. 验证命令

实现后执行：

1. `npx vitest run tests/service/table/table-service.test.ts tests/service/table/table-delta.test.ts`
2. `npx vitest run tests/service/table/update-orchestrator.test.ts`（若新增该文件）
3. `npx vitest run tests/integration/table-lifecycle.test.ts`
4. `npm run build`

若需要发布，再按发布计划另行确认 tag；本计划不直接发布。

## 6. 回滚策略

- 代码回滚：三处修改均为局部读侧 normalization，可用单 commit 回滚。
- 行为回滚：若出现异常，只会退回 spv3.9.8 的现状，即旧脏 base 继续导致 checkpoint 退化；不会破坏 `buildTableDelta_ACU` 的安全闸门。
- 数据回滚：不做历史楼层批量迁移，不写全局迁移脚本。首次遇到旧脏数据时仅在本次运行副本/新落盘结果中稳定化，降低不可逆风险。

## 7. 风险控制

- 幂等性风险：`ensureStableRowIdsForSheetContent_ACU` 必须不重写已有稳定 row_id；测试要覆盖稳定 row_id 保持不变。
- 顺序风险：`loadBatchBaseData_ACU` 中 guide 恢复与 row_id 稳定化顺序要明确。建议先恢复 guide，再稳定 content，避免 guide 结构恢复覆盖 content 上的 row_id 修复。
- 语义风险：不要把 base 修复塞进 `buildTableDelta_ACU`，否则会模糊“判定器”和“修复器”的职责边界。
- 并发风险：修复必须发生在每次 `persistCore` 调用内，而不是只在某个共享缓存里修一次；否则 4 组并发仍会重复读取脏 `prevTagData`。

## 8. 实施顺序

1. 修改 `table-service.ts`，先完成修复点 A 与 B。
2. 补 `table-service.test.ts` 红灯用例，再跑定向测试确认失败原因指向 base 侧。
3. 修改 `update-orchestrator.ts` 完成修复点 C。
4. 补 update-orchestrator 单测。
5. 补 table lifecycle 集成回归。
6. 跑完整验证命令。
7. 调用独立验收专家复验。
8. 仅在助手明确要求发布后，另起发布计划或按现有发布规范发新 tag。

## 9. 自我审查

这份计划的核心优点是贴着已确认数据流下刀：`prevTagData` 读侧、delta tag 重建、batch base 累加三处都覆盖了。它没有去碰 `buildTableDelta_ACU` 的安全闸门，这点是正确的。

不足也很明显：update-orchestrator 的测试可写性还依赖现有 mock 基础，当前计划只指定了优先路径，未完全确认测试辅助函数是否已经存在。这个缺口会影响实施耗时，但不影响修复方向。实施前应先搜索现有 `loadBatchBaseData_ACU` 测试和 mock 入口，别像没看地图就往迷宫里冲一样。
