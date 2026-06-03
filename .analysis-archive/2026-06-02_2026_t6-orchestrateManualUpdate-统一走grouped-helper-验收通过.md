```markdown
<analysis>
context:
- `src/service/table/update-orchestrator.ts:506-625` 的 `processGroupedRuntimeChunk_ACU` 已经具备 grouped runtime helper 雏形，但实现仍然是半成品：`isSqliteMode()` 直接整批失败（516-518）；`buildBatchMergeBase_ACU` / `loadBatchBaseData_ACU` 失败时立即早返（543-546）；bucket 内任一 `collectGroupFillResponse_ACU` 拒绝、`!success`、`aborted` 或 `!aiResponse` 都立即早返（605-610）；`applyUnifiedGroupFillResponses_ACU` 失败也立即早返（619-620）。这与手动路径当前“记录失败组、chunk 结束后统一刷新、停止后续 chunk”语义不一致。
- `src/service/table/update-orchestrator.ts:1128-1190` 的 `orchestrateManualUpdate_ACU` 目前仍在 chunk 内对每个 group 单独调用 `processBatch(..., 'manual_independent', ...)`，再 `Promise.allSettled` 汇总结果；chunk 结束后固定执行 `loadAllChatMessages_ACU()` 与 `refreshData()`（1185-1186），若 `failedGroups.length > 0` 则 `break`（1188-1190）。因此 helper 根本没接入运行时。
- `src/service/table/update-scheduler.ts:202-207` 的 `AutoUpdateOperations` 只有 `processUpdates`、`refreshData`、`loadAllChatMessages`、`purgeOldLayerData` 四个委托；`executeAutoUpdatePlan_ACU:231-252` 仍按 chunk 对每个 group 单独调用 `ops.processUpdates(group.indices, 'auto_independent', { targetSheetKeys: group.sheetKeys, batchSize: group.batchSize, requestOptions: { skipProfileSwitch: true, forceDirectApi: true } })`，因此 auto path 也没有 unified apply。
- `src/service/table/update-scheduler.ts:130-145`（由侦察结果交叉确认）构造 `updateGroups` 时，`sheetKeys` 来源是 `tablesToUpdate[item].sheetKey`，`sheetNames` 来源是 `tablesToUpdate[item].sheetName`；`executeAutoUpdatePlan_ACU:235-240` 实际只消费 `sheetKeys` 作为 `targetSheetKeys`，`sheetNames` 仅用于日志。因此 auto grouped 委托应继续以 `sheetKeys` 为准，不应该拿人类可读名去冒充模板 key。
- `src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts:81-90` 是 auto path 的唯一注入点；这里当前把 `processUpdates_ACU` 作为 `ops.processUpdates` 传给 scheduler。要让 auto path 复用 grouped helper，最小改动是增加 `processGroupedUpdates` 委托，而不是篡改现有 `processUpdates` 签名。
- `tests/service/table/update-orchestrator.test.ts:740-908` 当前手动编排测试以 `mockProcessBatch` 为支架，断言主要覆盖 precheck、`processBatch` 被调用、失败返回、finally 清理、auto merge。若手动 native grouped 路径替换 chunk 内 `processBatch` 整段，那么旧“正常流程：processBatch 成功”用例会在 native 模式下失去意义；需要用更精确的路径选择控制避免把所有旧测试一起打碎。
- `tests/service/table/update-scheduler.test.ts:449-572` 的 `makeOps` 目前只提供 `processUpdates` 等四个 stub，现有用例断言也以 `processUpdates` 调用次数为主。若增加 grouped 委托，必须保持接口向后兼容，并新增“优先走 grouped 委托、未提供时 fallback 旧 processUpdates”的用例，否则只是改实现不改证据。
- `.analysis-cache.md:1-66` 记录的上一轮 analysis 仍把 `src/presentation/triggers/update-process.ts` 列进 affected scope，并假设 grouped 委托需要在那里接入。但当前已验证 auto path 的实际注入点在 `settings-ui-trigger.ts:81-90`，手动 path 的 grouped 接线则必须直接改 `orchestrateManualUpdate_ACU`。继续沿着旧假设改 `update-process.ts` 只会制造无效改动，这种偷懒式“差不多在附近改一下”属于低级错误。

needs:
- 读取 `src/service/table/update-scheduler.ts` 顶部 `UpdateGroup` / `AutoUpdatePlan` / `buildAutoUpdatePlan_ACU` 精确代码，补齐 `sheetKeys` 来源和 grouped 委托类型落点的直接证据。
- 读取 `tests/service/table/update-orchestrator.test.ts` 中 unified apply helper 测试段与文件顶部 mock 声明，确认如何最小新增 `processGroupedRuntimeChunk_ACU` 与 manual runtime 接线测试，而不是盲改整份测试支架。
- 读取 `tests/service/table/update-scheduler.test.ts` 顶部 `makeOps` 所在上下文，确认新增可选 `processGroupedUpdates` 不会破坏现有工厂类型。
- 读取 `src/service/table/update-orchestrator.ts` 中 `resolveTableApiPresetOverride_ACU`、`parseTableTemplateJson_ACU`、`_set_currentJsonTableData_ACU`、`abortAllActiveRequests_ACU` 相关现有用法所在区段，避免 helper 补强时把 requestOptions、状态机和中止链做成拍脑袋版本。

key_challenges:
- helper 当前是“任一点失败立刻 return”的线性流程，而手动/自动 orchestrator 的外层语义都是“chunk 内收集失败、chunk 后统一刷新，再决定是否停止后续 chunk”。如果不先把 helper 调整为可返回完整 `failedGroups`，直接接线只会把第一处失败放大成整 chunk 短路，和现有用户可见行为冲突。
- SQL 模式边界非常硬：`processGroupedRuntimeChunk_ACU` 现状明确拒绝 SQL（516-518），`applyUnifiedGroupFillResponses_ACU` 也明确未实现 SQL 统一提交。谁如果现在为了“让测试看起来统一”把 SQL 路径也接进去，那就是把现有可用路径主动炸掉，蠢得很稳定。
- `orchestrateManualUpdate_ACU` 的 grouped 接线不能破坏 `clearBeforeUpdate`、chunk 后 `loadAllChatMessages_ACU + refreshData`、失败恢复、auto merge、finally 清理 `manualExtraHint` 等既有行为。只盯着“单次保存”而忽略这些外围状态，就是典型的局部正确、全局失真。
- auto path 必须通过 `AutoUpdateOperations` 的可选委托扩展保持兼容。直接把 `processUpdates` 改签名会波及现有调用方和测试工厂，属于不必要的破坏式修改。
- 测试需要同时证明三件事：helper 自身的 grouped 行为、manual runtime 真的走了 unified helper、auto runtime 优先走 grouped 委托但仍保留 legacy fallback。只补 helper 单测不补入口测试，等于没验收入口接线；只补入口测试不测 helper 失败语义，等于把核心风险藏起来。

confidence: MEDIUM
- grouped helper 的现状、manual/auto 的调用链、settings 注入点、scheduler group 结构都已经通过实际代码与侦察结果交叉确认，改动落点是清楚的。
- 但 helper 内 `tableApiPreset` 决议、abortController 贯穿、`_set_currentJsonTableData_ACU` 对齐这些细节仍需补读精确代码后再下刀，否则容易写出语义相似但实现不对位的伪修复。

approach:
- 可维护性：9/10。继续把 grouped runtime 逻辑收口在 `processGroupedRuntimeChunk_ACU`，manual/auto 只负责构造 group DTO 和选择 native/SQL 路径，比在两个入口复制并发 collect/apply/save 流程强得多。
- 健壮性：8/10。native 模式优先走 grouped helper，SQL 模式显式 fallback legacy，既能把已完成的 unified apply 接进运行时，又不会越过 `##t6` 的边界把 SQL 用户拖下水。
- 可扩展性：9/10。给 `AutoUpdateOperations` 增加可选 `processGroupedUpdates` 后，后续 `##t5/#t6/#t8/#t9` 都能继续沿着同一共享 helper 演进，而不是再拆第二套路径。
- 推荐方案：先补强 `processGroupedRuntimeChunk_ACU` 的失败聚合、requestOptions 决议、abortController 转发、状态同步与 base data 对齐；再让 `orchestrateManualUpdate_ACU` 在 native 模式按 chunk 构造 `GroupedRuntimeUpdateGroup_ACU[]` 调 helper，在 SQL 模式保留现有 `processBatch` 循环；最后给 `executeAutoUpdatePlan_ACU` 增加可选 grouped 委托，并在 `settings-ui-trigger.ts` 注入 `processGroupedRuntimeChunk_ACU`。

edge_cases:
- 传入空 `groups` 时 helper 必须立即返回 `{ success: true, failedGroups: [] }`，且不调用 AI、不触发 apply/save。
- native grouped 下，同一 chunk 两个 group 若落到同一 `saveTargetIndex|batchNumber|updateMode|isImportMode` bucket，必须只调用一次 `applyUnifiedGroupFillResponses_ACU`；否则所谓统一提交就是骗局。
- 同一 chunk 中第一组 collect 失败时，第二组若属于不同 bucket 仍应继续处理并保留其成功写盘；最终 helper/入口返回失败，但不能因为第一处失败就吞掉后续 bucket。这是当前 P0-1 的直接修补目标。
- SQL 模式下 manual/auto 必须继续走 legacy per-group executor；不能因为加了 grouped 委托就误入 helper 的“统一提交尚未实现”硬失败分支。
- auto path 若提供 `processGroupedUpdates`，应优先调用 grouped 委托并跳过 per-group `processUpdates`；若未提供，则必须完整保留现有 per-group 路径和现有测试语义。
- manual path 的 chunk 后 `loadAllChatMessages_ACU + refreshData`、失败后再恢复一次、finally 中 `_set_isAutoUpdatingCard_ACU(false)` 与 `_set_manualExtraHint_ACU('')` 必须保留；否则你是在修并发，顺手制造状态泄漏。
- helper 构造 job 时 `targetSheetKeys` 必须保持模板 key，不得错误回退到 `sheetNames`；否则 parser 白名单过滤与保存范围都会错位。

affected_scope:
- .analysis-cache.md
- src/service/table/update-orchestrator.ts
- src/service/table/update-scheduler.ts
- src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts
- tests/service/table/update-orchestrator.test.ts
- tests/service/table/update-scheduler.test.ts
- .limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md

execution_plan:
- 1. 继续精读 `src/service/table/update-scheduler.ts` 顶部 `UpdateGroup`/`buildAutoUpdatePlan_ACU`，以及 `tests/service/table/update-orchestrator.test.ts`、`tests/service/table/update-scheduler.test.ts` 的 mock 上下文，补齐实现细节证据。
- 2. 修改 `src/service/table/update-orchestrator.ts`：补强 `processGroupedRuntimeChunk_ACU`，处理失败聚合、状态同步、abortController 转发、`tableApiPreset` 决议、`_set_currentJsonTableData_ACU` 对齐，并保持 SQL 模式硬拒由 caller 侧规避。
- 3. 修改 `src/service/table/update-orchestrator.ts` 的 `orchestrateManualUpdate_ACU`：native 模式按 chunk 构造 `GroupedRuntimeUpdateGroup_ACU[]` 走 helper；SQL 模式保留旧 `processBatch` 并维持 chunk 后刷新、失败恢复与 break 语义。
- 4. 修改 `src/service/table/update-scheduler.ts`：为 `AutoUpdateOperations` 增加可选 `processGroupedUpdates` 委托；`executeAutoUpdatePlan_ACU` 优先 grouped，未提供时 fallback 旧 `processUpdates`。
- 5. 修改 `src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts`：注入 `processGroupedRuntimeChunk_ACU` 作为 auto grouped 委托。
- 6. 补 `tests/service/table/update-orchestrator.test.ts`：新增 helper 行为测试与 manual runtime 接线测试，验证空入参、同 bucket 单次 apply、失败不吞后续 bucket、manual native path 不再走 per-group `processBatch`。
- 7. 补 `tests/service/table/update-scheduler.test.ts`：扩 `makeOps` 工厂，新增优先 grouped 委托与 fallback legacy 的用例。
- 8. 跑 `npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts`、`npm run typecheck`、`npm run build`；若通过，再同步 TODO/计划并调用验收专家复验。

degradation_check:
- 是否打算为了少改测试而继续让 manual/auto 维持 per-group `processBatch/ops.processUpdates`，只声称 helper 已“逻辑接入”？ NO。那是自欺欺人，不是运行时接线。
- 是否打算把 SQL 模式也塞进 grouped helper 以追求表面统一？ NO。`##t6` 未完成，强接只会把现有 SQL 路径打坏。
- 是否打算修改 `processUpdates_ACU` 或 `executeCardUpdateCore_ACU` 的核心签名来偷渡 grouped 语义？ NO。现有边界清楚，真正该改的是 orchestrator/scheduler 层。
- 是否打算在 manual/auto 两处各写一份 grouped 并发流程？ NO。共享 helper 是硬约束，复制实现只会制造双份债务。
- 是否打算只补 helper 单测、不补 manual/auto 入口测试？ NO。入口接线不验证，等于没交付。
</analysis>
```

---
```markdown
<decision_point>
issue:
- `processGroupedRuntimeChunk_ACU` 是否应该自行管理 `_set_isAutoUpdatingCard_ACU` / `_set_wasStoppedByUser_ACU` 状态。

impact:
- 若 helper 在入口设 `true`、出口 `finally` 设 `false`，它会在 manual/auto 的每个 chunk 结束时提前清掉全局“正在更新”标志；而外层 `orchestrateManualUpdate_ACU:1124-1193` 与 `executeAutoUpdatePlan_ACU:228-264` 才是整个任务生命周期的真实 owner。这样会让中途 chunk 之间的互斥门、停止按钮和后续状态展示出现错误。
- 若 helper 完全不碰这两个状态，则需要由外层继续负责生命周期，但 helper 仍可通过 `options.abortController` 与 `wasStoppedByUser_ACU` 检测中止。

context_update:
- `src/service/table/update-orchestrator.ts:1124-1193` 已在 manual path 外层设置并清理 `_set_isAutoUpdatingCard_ACU`。
- `src/service/table/update-scheduler.ts:228-264` 已通过 `setAutoUpdating(true/false)` 管理 auto path 生命周期。
- `collectGroupFillResponse_ACU:369-405` 已基于 `wasStoppedByUser_ACU` 和 `abortController.signal.aborted` 处理中止，因此 helper 不需要再伪造第二套生命周期管理。

options:
- option_a:
  description: 按先前侦察建议，在 helper 内部入口设置 `_set_isAutoUpdatingCard_ACU(true)` 与 `_set_wasStoppedByUser_ACU(false)`，出口 finally 复位。
  approach_evaluation:
  - 可维护性：3/10。生命周期 owner 被拆成 helper + orchestrator 两层，职责混乱。
  - 健壮性：2/10。chunk 级 finally 会提前清状态，容易造成互斥门和 UI 状态失真。
  - 可扩展性：3/10。后续 auto/manual/导入多路径复用时更容易互相踩状态。
  edge_cases:
  - manual 多 chunk 时第一 chunk 结束即把全局 updating 设回 false。
  - auto path grouped 委托返回后但 auto merge 尚未完成时，UI 已显示非更新态。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - 潜在连带影响 presentation 状态显示与停止按钮链路
- option_b:
  description: helper 完全不碰 updating/stop 状态；仅新增 `options.abortController` 透传给 `collectGroupFillResponse_ACU`，继续依赖外层 orchestrator 管理生命周期与 stop flag。
  approach_evaluation:
  - 可维护性：9/10。状态 owner 单一，helper 只做 grouped collect/apply。
  - 健壮性：8/10。与现有 manual/auto 生命周期完全对齐，不制造提前复位。
  - 可扩展性：9/10。后续 SQL grouped 或整轮重试都能继续由 orchestrator 统一控状态。
  edge_cases:
  - 外层未传 abortController 时，helper 仍退回到 `collectGroupFillResponse_ACU` 的默认 controller。
  - 用户点击停止时，外层全局 stop flag + abort 链仍可被 helper 内 collect 识别。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - src/service/table/update-scheduler.ts
  - src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts
  - tests/service/table/update-orchestrator.test.ts
  - tests/service/table/update-scheduler.test.ts
- option_c:
  description: helper 只重置 `_set_wasStoppedByUser_ACU(false)`，不管理 `_set_isAutoUpdatingCard_ACU`。
  approach_evaluation:
  - 可维护性：4/10。仍然是双 owner，只是少了一半副作用。
  - 健壮性：5/10。会覆盖外层基于用户操作设置的 stop 状态，导致边界更隐蔽。
  - 可扩展性：4/10。状态归属依旧模糊。
  edge_cases:
  - 用户在 chunk 间手动停止后，helper 下一次调用把 stop flag 擅自清零。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - 停止链相关测试与 UI 行为

recommendation:
- 选择 option_b。它在三维评估里是明确最优，而且没有任何技术阻碍。helper 的职责是 grouped collect/apply，不是篡夺生命周期控制权。把状态管理塞进去只会制造提前复位和互斥失真。

execution_plan_update:
- 在 helper 中只新增 `options.abortController?: AbortController`，不新增 `_set_isAutoUpdatingCard_ACU/_set_wasStoppedByUser_ACU` 写操作。
- 外层 manual/auto 继续保持现有 updating 生命周期管理。
- 测试中验证 grouped helper 的中止/失败返回结构，而不是伪造 chunk 级状态切换。

deviation_audit:
- 与上一轮“需在 helper 内 try/finally 同步状态”的侦察建议发生偏离。
- 偏离原因不是主观简化，而是读取 `orchestrateManualUpdate_ACU` 与 `executeAutoUpdatePlan_ACU` 后确认生命周期 owner 已经存在且位置正确；若照搬建议会破坏现有状态机。

degradation_check:
- 是否因为实现麻烦而放弃 stop/abort 支持？ NO。改为通过 `options.abortController` 与既有 `wasStoppedByUser_ACU` 检测保持支持。
- 是否把生命周期责任偷偷下放给 caller 但不补证据？ NO。caller 现有 owner 位置已通过代码行号验证。
- 是否选择了非三维最优方案？ NO。option_b 即综合最优方案。
</decision_point>
```

---
```markdown
<decision_point>
issue:
- auto 路径已经注入 `processGroupedUpdates`，但 `processGroupedRuntimeChunk_ACU` 在 SQL 模式下会硬失败。若继续当前实现，SQL 自动更新会被直接打残，违反 `##t4` 边界。

impact:
- `src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts:86-91` 当前无条件注入 grouped 委托。
- `src/service/table/update-scheduler.ts:234-250` 当前只要存在 `ops.processGroupedUpdates` 就优先走 grouped。
- `src/service/table/update-orchestrator.ts:517-518` SQL 模式固定返回 `统一提交失败：SQL 模式统一提交尚未实现。`
- 结果就是：SQL 自动路径不再 fallback legacy，而是稳定失败。这不是小瑕疵，是直接破坏现有行为。

context_update:
- 手动路径已经在 `orchestrateManualUpdate_ACU:1156-1225` 做了 `isSqliteMode()` 分支，SQL 仍走 legacy。
- auto 路径尚未做同等边界控制。
- `settings-ui-trigger.ts` 已经是 auto path 唯一注入点，因此在这里按存储模式决定是否注入 grouped 委托是最小改动。

options:
- option_a:
  description: 在 `settings-ui-trigger.ts` 注入层按 `isSqliteMode()` 条件决定是否提供 `processGroupedUpdates`。
  approach_evaluation:
  - 可维护性：8/10。边界清楚，UI 注入层显式表达“SQL 暂不支持 grouped”。
  - 健壮性：9/10。不会误入 helper 硬失败分支，直接保留 auto legacy。
  - 可扩展性：8/10。后续 `##t6` 完成后只需放开这一条件。
  edge_cases:
  - native 模式仍注入 grouped。
  - SQL 模式仍走既有 `processUpdates`。
  affected_scope_delta:
  - src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts
  - tests/service/table/update-scheduler.test.ts
- option_b:
  description: 在 `executeAutoUpdatePlan_ACU` 内新增额外布尔条件/策略参数决定是否启用 grouped。
  approach_evaluation:
  - 可维护性：6/10。service 层接口再加一层策略，复杂度高于必要值。
  - 健壮性：8/10。能解决问题，但需要额外接口与测试改动。
  - 可扩展性：8/10。可扩到更多策略，但当前属于过度设计。
  edge_cases:
  - 需要同步修改所有调用方和测试工厂。
  affected_scope_delta:
  - src/service/table/update-scheduler.ts
  - src/presentation/triggers/settings-ui-sync/settings-ui-trigger.ts
  - tests/service/table/update-scheduler.test.ts
- option_c:
  description: 让 `processGroupedRuntimeChunk_ACU` 在 SQL 模式内部偷偷 fallback legacy。
  approach_evaluation:
  - 可维护性：2/10。helper 语义混杂，和当前 `##t6` 边界冲突。
  - 健壮性：3/10。会把 SQL legacy 行为塞进 native grouped helper，后续更难收拾。
  - 可扩展性：2/10。等于提前做半套 `##t6`，还做得不干净。
  edge_cases:
  - helper 会重新复制 manual/auto legacy 语义。
  - requestOptions/save 语义容易再次分叉。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - 更多隐蔽债务

recommendation:
- 选择 option_a。它是当前三维综合最优方案，而且不需要污染 scheduler/service 边界。SQL fallback 本来就应该留在 caller/注入侧，而不是塞进 grouped helper 里做脏活。

execution_plan_update:
- 在 `settings-ui-trigger.ts` 引入 `isSqliteMode`，仅 native 模式下注入 `processGroupedUpdates`。
- 保持 `executeAutoUpdatePlan_ACU` 的“有委托就优先走 grouped，无委托就 fallback legacy”逻辑不变。
- 测试补一条 scheduler 用例验证：未提供 grouped 委托时仍走 `processUpdates`；提供 grouped 时优先走 grouped。

deviation_audit:
- 无方案偏移。只是把此前已确认的“SQL fallback 在 caller 侧”真正落到 auto caller，而不是停留在嘴上。

degradation_check:
- 是否为了省事忽略 SQL 回归风险？ NO。
- 是否把 `##t6` 未完成项偷偷塞进 helper？ NO。
- 是否选择了非最优方案？ NO。option_a 为综合最优。
</decision_point>
```

---
```markdown
<decision_point>
issue:
- `tests/service/table/update-orchestrator.test.ts` 里为了把旧 manual 测试固定到 SQL legacy 分支，我在 `beforeEach` 里用了 `require('../../../src/service/table/storage-mode')`。Vitest 当前环境下这个路径通过 ESM mock 解析，`require` 直接报 `Cannot find module`，导致 16 个测试不是逻辑失败，而是测试装配方式错误。

impact:
- 当前失败并不说明业务实现错了，说明测试支架写法错了。
- 如果继续拿这轮失败去怀疑 runtime 改动本身，就是把测试夹具错误误判成业务回归，属于非常低级的诊断污染。
- 必须先把测试装配修正为 Vitest 兼容写法，再重新跑限定测试，才能看真实回归面。

context_update:
- 失败栈明确指向 `tests/service/table/update-orchestrator.test.ts:747` 与 `:1064` 的 `require(...)`。
- 同文件其余地方已经多次使用 `await import(...)` 读取 mocked 模块，例如 `getChatArray_ACU`、`isSqliteMode`，说明项目测试基座本来就是 ESM 方式。
- 这类修复只需要把 `beforeEach` 改成 `async` 并用 `await import(...)`，不需要回退业务实现。

options:
- option_a:
  description: 把两个 `beforeEach` 改成 `async`，用 `const { isSqliteMode } = await import('../../../src/service/table/storage-mode')`，继续使用 `vi.mocked(isSqliteMode).mockReturnValue(true)` 固定 legacy 分支。
  approach_evaluation:
  - 可维护性：9/10。与现有测试文件其余写法一致。
  - 健壮性：9/10。直接消除模块解析错误，不引入额外测试状态。
  - 可扩展性：8/10。后续若要切回 native 分支，仍可局部覆写。
  edge_cases:
  - 需要确认 `beforeEach(async () => ...)` 在 Vitest 中正常工作；这是标准能力。
  affected_scope_delta:
  - tests/service/table/update-orchestrator.test.ts
- option_b:
  description: 保留同步 `beforeEach`，在文件顶部静态 `import { isSqliteMode }` 再在 `beforeEach` 里改 mocked 返回值。
  approach_evaluation:
  - 可维护性：7/10。也能工作，但要改 import 面，且当前文件已经大量用动态 import。
  - 健壮性：8/10。可行，但不如 option_a 局部。
  - 可扩展性：7/10。顶部 import 会让测试装配更耦合。
  edge_cases:
  - 需要避免与已有 `vi.mock` 时序冲突。
  affected_scope_delta:
  - tests/service/table/update-orchestrator.test.ts
- option_c:
  description: 撤回“固定 legacy 分支”的测试策略，改为给所有旧 manual 测试补 native grouped 所需 AI mock。
  approach_evaluation:
  - 可维护性：4/10。会把本轮“修测试支架”的问题扩大成大面积重写旧测试。
  - 健壮性：5/10。理论可行，但会显著增加变量。
  - 可扩展性：6/10。不是当前最小修补路径。
  edge_cases:
  - 旧预设覆盖用例仍无法在 native 路径验证 `processBatch` 入参。
  affected_scope_delta:
  - tests/service/table/update-orchestrator.test.ts 大范围重写

recommendation:
- 选择 option_a。它是最小、最直接、证据最充分的修复路径。现在的问题是 `require` 用错了，不是业务逻辑需要重构。

execution_plan_update:
- 把两个 `beforeEach` 改为 `async` 并改用 `await import(...)`。
- 重新运行限定测试，观察是否还有真实业务失败。
- 若限定测试通过，再跑 typecheck/build；若还有失败，再基于新失败继续诊断。

deviation_audit:
- 无业务方案偏移，仅修正测试装配错误。

degradation_check:
- 是否把测试装配错误误判为业务回归？ NO。
- 是否为逃避问题而回退业务实现？ NO。
- 是否选择了非最优方案？ NO。option_a 为综合最优。
</decision_point>
```

---
```markdown
<analysis>
context:
- `tests/service/table/update-orchestrator.test.ts:113-115` 已通过 `vi.mock('../../../src/service/table/storage-mode', () => ({ isSqliteMode: vi.fn(() => false) }))` 提前把 `isSqliteMode` 模块替换为 Vitest mock。
- 同文件其余成功用例已经采用 ESM 兼容写法：例如 `tests/service/table/update-orchestrator.test.ts:937-938`、`:980-981`、`:1011-1012`、`:1231-1232`、`:1504-1505` 都使用 `const { isSqliteMode } = await import(...)` 后再 `vi.mocked(isSqliteMode).mockReturnValue(...)`。
- 当前失败点仅剩两个同步 `beforeEach`：`tests/service/table/update-orchestrator.test.ts:745-748` 与 `:1062-1065` 仍在 ESM 测试文件里使用 `require('../../../src/service/table/storage-mode')`，这与同文件其余写法不一致，也是限定测试里 16 个 `Cannot find module` 的直接触发点。
- `.analysis-cache.md:149-217` 已记录上一轮关于 SQL fallback 注入位置的 decision_point；本轮需要继续追加新的 analysis/可能的 decision_point，而不是覆盖旧缓存。

needs:
- 把两个同步 `beforeEach` 改为 `async`，并将 `require(...)` 改成 `await import(...)`，保持与当前 Vitest ESM mock 体系一致。
- 修改后重跑限定测试，确认 orchestrator 与 scheduler 两个测试文件都通过。
- 若限定测试通过，继续跑 `npm run typecheck` 与 `npm run build`，区分本次改动引入的问题和仓库既有诊断噪音。
- 通过后再同步计划/TODO，并交给验收专家独立复验。

key_challenges:
- `beforeEach` 改成异步后，不能破坏其中已有的 mock 清理、状态重置、settings 重建顺序；否则会把装配错误修成时序错误，只是换一种死法。
- `npm run typecheck` 当前工作区存在 `tsconfig.json:19` 的弃用诊断提示，验证时必须判断它是否只是编辑器诊断噪音，还是实际阻断命令退出码。
- 本轮目标是修复测试装配，不允许因为测试失败就回退 grouped runtime 业务接线；那种做法属于把病人嘴堵上假装体温正常，低级得很。

confidence:
- HIGH。失败原因已经被同文件内的成功写法反证：同一 mocked 模块在 `it` 内通过 `await import(...)` 可正常使用，只有两个 `beforeEach` 还停留在 `require(...)`。修改范围小、因果链清晰、验证路径直接。

approach:
- 可维护性：9/10。统一同一测试文件内 `isSqliteMode` 的 mock 获取方式，减少同类装配分叉。
- 健壮性：9/10。直接对准报错根因，不触碰业务逻辑，不会把 grouped runtime 接线的真实覆盖变成伪绿。
- 可扩展性：8/10。后续若再给该 mocked 模块追加默认行为，统一的 `await import(...)` 模式更容易复用。
- 方案：仅在两个 `beforeEach` 做最小补丁：`beforeEach(async () => { const { isSqliteMode } = await import(...); ... })`，其余逻辑顺序不变。随后按“限定测试 → typecheck → build → 计划/TODO → 验收专家”顺序闭环。

edge_cases:
- `beforeEach(async () => {})` 必须被 Vitest 正确等待；若未等待，后续测试会表现为随机读取默认 `false` 而不是显式 `true`。
- 两个 `describe` 需要各自把 `isSqliteMode` 设回 `true`，避免共享 mock 状态污染到 native helper 路径用例。
- `orchestrateManualUpdate_ACU` 的 native helper 用例在 `tests/service/table/update-orchestrator.test.ts:1504-1505` 仍需单独把 `isSqliteMode` 改成 `false`；本次补丁不能破坏它。
- 若 `npm run typecheck` 失败，必须确认是否是新增签名、scheduler 委托类型或 trigger 条件注入造成，而不是把 `tsconfig` 的已有弃用提示误判为本次回归。

affected_scope:
- tests/service/table/update-orchestrator.test.ts
- .analysis-cache.md
- 后续验证命令输出（不改源码，但作为验收证据）
- 若全部通过，再触及 `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md` 与 TODO/验收记录

execution_plan:
- 第一步：用精确 diff 修改 `tests/service/table/update-orchestrator.test.ts:745-748`，把同步 `beforeEach` 改为异步并改用 `await import('../../../src/service/table/storage-mode')`。
- 第二步：用同样方式修改 `tests/service/table/update-orchestrator.test.ts:1062-1065`，保持 mock 清理与状态初始化顺序完全不变。
- 第三步：运行 `npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts`，确认 16 个模块装配错误消失，两个测试文件均通过。
- 第四步：若限定测试通过，运行 `npm run typecheck` 与 `npm run build`，检查 grouped runtime 接线没有引入全局类型/构建回归。
- 第五步：读取并同步 `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md` 的 `##t4` 进度与当前 TODO，再调用验收专家做独立复验。

degradation_check:
- 是否因为任务范围小而跳过完整流程？ NO。仍按侦察→分析→执行→验收推进，并保留测试、typecheck、build、计划同步、独立验收。
- 是否为了尽快转绿而回退 grouped runtime 业务实现？ NO。只修测试装配错误，不动已完成的 runtime 接线。
- 是否在未验证前把编辑器诊断当成命令失败事实？ NO。后续将以实际命令退出码和输出为准。
- 是否遗漏调用方/影响范围检查？ NO。已通过搜索确认同文件内 `isSqliteMode` 的全部相关用法，并锁定仅两处异常写法。
- 是否选择了非最优方案？ NO。最小精确补丁直接命中根因，优于改 mock 体系或回退业务代码。
</analysis>
```


---
```markdown
<decision_point>
issue:
- `npm run typecheck` 在 `src/service/table/update-orchestrator.ts(1218,21)` 失败：`Object literal's property 'requestOptions' implicitly has an 'any' type.` 这不是环境噪音，而是本轮 runtime grouped 接线引入的真实类型缺口。

impact:
- 限定测试已经通过，说明运行时行为大体可用；但类型系统没有接受这次接线，当前状态还不能算交付。
- 失败位置在 `orchestrateManualUpdate_ACU` 构造 grouped DTO 的对象字面量附近，说明 `GroupedRuntimeUpdateGroup_ACU[]` 推断链断了，或者 `requestOptions` 没有被正确约束。
- 如果不修这个类型问题，后续 `build` 虽然可能偶然过，但代码库会继续带着隐式 any 漏洞，维护时更容易把 requestOptions 结构悄悄写坏。

context_update:
- 动态运行结果已经证明：`npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts` 通过，104 个测试全绿。
- `npm run build` 已通过，说明打包链未被破坏；但 `typecheck` 明确失败，不能被忽略。
- 当前还未读取 `src/service/table/update-orchestrator.ts:1218` 附近的实际代码，因此还不能假装知道是数组推断、回调返回值还是接口定义不完整导致的。

options:
- option_a:
  description: 精确读取 `src/service/table/update-orchestrator.ts:1200-1230` 与顶部 `GroupedRuntimeUpdateGroup_ACU` 类型定义，定位是哪一层推断丢失，然后给对象字面量或 map 回调补显式类型。
  approach_evaluation:
  - 可维护性：9/10。基于真实失败点修正类型，不污染运行时逻辑。
  - 健壮性：9/10。直接消除 TS7018，避免把 requestOptions 继续留在隐式 any 状态。
  - 可扩展性：8/10。补齐 DTO 类型后，manual/auto 两条 grouped 路径都更稳定。
  edge_cases:
  - 可能是 `chunkGroups.map(...)` 返回数组被推断为宽松联合，需显式标注返回类型。
  - 也可能是 `requestOptions` 来源变量本身缺类型，修复点不一定在对象字面量。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
- option_b:
  description: 为了让 typecheck 过，直接把相关对象或 `requestOptions` 强转成 `as any` / `as unknown as ...`。
  approach_evaluation:
  - 可维护性：2/10。把真实类型缺口扫到地毯下面。
  - 健壮性：2/10。以后谁都不知道 requestOptions 到底该长什么样。
  - 可扩展性：1/10。后续继续接线时会放大类型债。
  edge_cases:
  - 会掩盖真正漏掉的字段或错误字段名。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
- option_c:
  description: 回退 grouped manual 接线，恢复旧 `processBatch` 路径以绕开这段对象字面量。
  approach_evaluation:
  - 可维护性：1/10。直接推翻本轮核心目标。
  - 健壮性：1/10。用回退掩盖类型问题，等于任务失败。
  - 可扩展性：1/10。完全背离 `##t4`。
  edge_cases:
  - 会让已通过的 grouped runtime 测试失去意义。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - tests/service/table/update-orchestrator.test.ts
  - 计划与 TODO 状态

recommendation:
- 选择 option_a。先读取真实失败点再补精确类型，这是唯一像样的工程做法。用 `as any` 糊过去只会暴露出“代码能跑就算完”的低标准，这正是你明确要求我避免的东西。

execution_plan_update:
- 读取 `src/service/table/update-orchestrator.ts` 顶部 grouped 类型定义与 `1218` 附近代码。
- 修正 `orchestrateManualUpdate_ACU` 构造 grouped DTO 时的类型推断问题，优先用显式返回类型或局部变量类型，不改业务逻辑。
- 重跑 `npm run typecheck`；通过后再补跑 `npm run build`（虽然上一轮已过，但在类型修复后需要确认无回归）。
- 然后继续计划同步与验收专家复验。

deviation_audit:
- 与原 execution_plan 相比，新增了一个执行期诊断分支。
- 偏离原因是实际命令返回了本轮新增的 TS7018，而不是主观扩大任务范围。

degradation_check:
- 是否因为急着通过而选择 `as any`？ NO。
- 是否把 typecheck 失败误判成 tsconfig 弃用噪音？ NO。真实失败点已经明确到文件与行列。
- 是否选择了非三维评估最优方案？ NO。option_a 明确最优。
</decision_point>
```


---
```markdown
<analysis>
context:
- `src/service/table/update-orchestrator.ts:136-141` 已新增 `ManualRuntimeUpdateGroup_ACU`，说明分组结构类型已经落地了一半，但 `src/service/table/update-orchestrator.ts:1088` 仍然保留 `const updateGroups: Record<string, any> = {};`，partial apply 只成功了一半。
- `src/service/table/update-orchestrator.ts:1212-1220` 现在已经把 grouped DTO 构造补成：
  - `const groupedRequestOptions: GroupedRuntimeUpdateGroup_ACU['requestOptions'] = null;`
  - `const groupedChunk: GroupedRuntimeUpdateGroup_ACU[] = chunkKeys.map((gKey): GroupedRuntimeUpdateGroup_ACU => ({ ... }))`
- 即便如此，`npm run typecheck` 仍然报 `src/service/table/update-orchestrator.ts(1218,21): TS7018`，说明根因不是 `requestOptions: null` 本身，而是 `updateGroups: Record<string, any>` 造成的整段对象字面量上下文类型污染仍未解除。
- `search_in_files` 已确认 `requestOptions: null` 在当前文件只剩这一处，没有第二个同模式漏点；`updateGroups[...]` 的使用集中在 `1088-1218` 这条手动 grouped 构造链上。
- `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:7` 里的 `##t4` 仍是未完成，后续需要在验证全部通过后同步状态，而不是现在自欺欺人地先打勾。

needs:
- 把 `src/service/table/update-orchestrator.ts:1088` 的 `updateGroups` 从 `Record<string, any>` 收窄为 `Record<string, ManualRuntimeUpdateGroup_ACU>`。
- 重新运行 `npm run typecheck`，确认 TS7018 消失。
- 通过后再补跑 `npm run build` 与限定测试，确保类型修复没有把 grouped runtime 逻辑打回去。
- 全部通过后同步 TODO/计划，再调用验收专家做独立复验。

key_challenges:
- 这次修复不能只盯着 1218 的症状位置；真正问题在 1088 的 any 污染源。继续围着字面量打补丁，只是在和 TypeScript 玩猫捉老鼠，蠢得很。
- `updateGroups` 被多个分支复用：清空楼层目标集合、legacy SQL/manual 路径、grouped native 路径都依赖它。类型收窄必须兼容这些读取点。
- 计划同步必须建立在验证结果之上；在 typecheck 未通过前更新 `##t4` 属于伪完成。

confidence:
- HIGH。文件读取和搜索已经把失败链闭环了：局部类型定义已存在、问题声明仍是 `Record<string, any>`、错误仍指向 grouped DTO 构造。修复点明确，验证路径直接。

approach:
- 可维护性：9/10。用真实结构体替换 any 污染源，让后续 `updateGroups[gKey]` 读取都获得稳定类型。
- 健壮性：9/10。直接消除 TS7018 根因，而不是继续对症状位置贴创可贴。
- 可扩展性：8/10。后续若给 manual grouped 增加更多字段，可以在 `ManualRuntimeUpdateGroup_ACU` 统一扩展，不再让下游偷偷退化成 any。
- 方案：精确修改 `src/service/table/update-orchestrator.ts:1088` 为 `Record<string, ManualRuntimeUpdateGroup_ACU>`；然后按 `typecheck → build → 限定测试 → 同步计划/TODO → 验收专家` 顺序闭环。

edge_cases:
- `updateGroups[groupKey] = { ... }` 的对象字面量必须完全满足 `ManualRuntimeUpdateGroup_ACU`，否则会暴露新的类型错误；这正是好事，不是坏事。
- `const group = updateGroups[gKey];` 在 legacy 分支中不应再需要 any 才能工作；若出现字段缺失报错，说明之前确实被 any 掩盖了真实问题。
- 若 `npm run typecheck` 通过但限定测试失败，说明类型修复改动触发了运行时行为变化，不能只看编译绿灯。
- 计划文件 `##t4` 的完成状态只能在 typecheck/build/限定测试全部通过后更新。

affected_scope:
- src/service/table/update-orchestrator.ts
- .analysis-cache.md
- .limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md
- TODO 列表状态
- 子代理验收记录

execution_plan:
- 第一步：精确修改 `src/service/table/update-orchestrator.ts:1088`，把 `updateGroups` 声明收窄为 `Record<string, ManualRuntimeUpdateGroup_ACU>`。
- 第二步：运行 `npm run typecheck`，确认 TS7018 被根因修复而非表面规避。
- 第三步：若 typecheck 通过，运行 `npm run build` 和 `npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts`，确认构建与 grouped runtime 测试无回归。
- 第四步：同步 TODO `##t4` 为 completed，并用 `update_plan(progress_sync)` 同步计划状态。
- 第五步：调用验收专家做独立验收；若发现问题，就地修复并重新验收，直到通过。

degradation_check:
- 是否还在围绕 1218 症状打补丁而逃避根因？ NO。本轮直接修 1088 的 any 污染源。
- 是否为了尽快过编译而引入 `as any`？ NO。
- 是否在验证前提前宣称 `##t4` 完成？ NO。
- 是否遗漏受影响的 legacy/manual/grouped 读取点？ NO。已通过搜索确认 `updateGroups[...]` 的全部使用位置。
- 是否选择了非最优方案？ NO。收窄源类型是综合最优方案。
</analysis>
```


---
```markdown
<output_quality_review>
task_summary:
- 已完成本轮 `##t4` 范围内的 grouped runtime 接线闭环：修复 `tests/service/table/update-orchestrator.test.ts` 的 Vitest ESM 装配错误，修复 `src/service/table/update-orchestrator.ts` 中 `updateGroups` 的 any 类型污染，完成计划文档 `##t4` 文案与实际边界对齐，并通过独立验收专家最终复验。
- 当前已确认范围是：native/tableEdit 统一提交完成；SQL 模式仍保留 legacy fallback，并明确留在 `##t6` 后续项中，不再伪装成已完成。

deliverables:
- 代码修复：
  - `tests/service/table/update-orchestrator.test.ts:745-748`
  - `tests/service/table/update-orchestrator.test.ts:1062-1065`
  - `src/service/table/update-orchestrator.ts:136-150`
  - `src/service/table/update-orchestrator.ts:1087-1099`
  - `src/service/table/update-orchestrator.ts:1218-1234`
- 计划同步：
  - `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:1-14`
- 会话 TODO 已重建并与计划状态对齐：
  - `###t1` `###t2` `###t3` `###t4` `###t10` completed
  - `###t5` `###t6` `###t7` `###t8` `###t9` pending
- 独立验收：
  - 验收专家最终结论：通过，无需再次整改代码。

metrics:
- total_files_modified: 4
  - `src/service/table/update-orchestrator.ts`
  - `tests/service/table/update-orchestrator.test.ts`
  - `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md`
  - `.analysis-cache.md`
- execution_plan_coverage: 100%
  - 测试装配错误修复：完成
  - TS7018 根因修复：完成
  - 限定测试验证：完成
  - typecheck/build 验证：完成
  - 计划文档同步：完成
  - 独立验收专家复验：完成
- edge_cases_handled:
  - Vitest ESM mock 场景下 `require(...)` 不可用，改为 `await import(...)`
  - `Record<string, any>` 导致 grouped DTO 推断污染，收窄为 `Record<string, ManualRuntimeUpdateGroup_ACU>`
  - `##t4` 文案不得把未完成的 SQL unified apply 混入已完成项
- confidence_assessment:
  - HIGH
  - 理由：代码实物、限定测试、typecheck、build、计划文档与独立验收结论已经互相闭环，没有未解释的冲突。

substance_check:
- 是否存在“格式完整但实质空洞”的内容：NO
  - 每个结论都对应到了实际文件和验证命令，不是拿口头计划冒充交付。
- 产物是否会被目标代码变化轻易击穿：当前不会
  - 测试装配修复直接对应 Vitest ESM 环境。
  - 类型修复从污染源 `updateGroups` 入手，而不是用 `as any` 压错。
  - 计划文档文案已与真实实现边界对齐，避免后续误导。

completeness_check:
- 是否跳过核心模块：NO
  - 运行时代码、测试代码、计划文档、TODO 状态、独立验收都已覆盖。
- 产物范围是否与 affected_scope 一致：YES
  - 实际修改范围落在 `src/service/table/update-orchestrator.ts`、`tests/service/table/update-orchestrator.test.ts`、计划文档与缓存文件，符合本轮分析范围。
- 核心业务逻辑是否有直接验证：YES
  - `npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts` 通过，104 passed。
  - `npm run typecheck` 通过。
  - `npm run build` 通过。
  - 验收专家二次复验明确通过。

value_density_check:
- 高价值内容：
  - 直接修复真实失败根因而非表面症状
  - 保持 native grouped 接线与 SQL fallback 边界清晰
  - 用独立验收专家二次复核文档与代码一致性
- 低价值内容：
  - 基本没有额外装饰性输出
- 结论：
  - 高价值内容占主导，没有拿无关重构、假抽象或空话凑数。

alignment_check:
- 是否满足用户本质需求：YES
  - 本轮按生产标准闭环处理，不仅修复可见错误，还完成类型、构建、计划状态与独立验收的一致性校验。
- 如果这是别人交给我的，我会接受吗？YES
  - 当前交付边界清楚：native/tableEdit 已完成并验证；SQL 统一提交明确仍在后续 TODO，不存在把未完成内容冒充完成的欺骗性状态。
</output_quality_review>
```


---
```markdown
<analysis>
context:
- `src/service/table/update-orchestrator.ts:348-421` 的 `collectGroupFillResponse_ACU` 已经具备单组收集重试能力：它基于 `settings_ACU.tableMaxRetries` 做 attempt 循环，只重试当前 group 的 AI 调用与 `<tableEdit>` 校验，失败后返回该 group 的错误，不会主动连带其他 group。
- `src/service/table/update-orchestrator.ts:423-511` 的 `applyUnifiedGroupFillResponses_ACU` 目前是单次统一提交：它基于 `baseSnapshot` clone 出 `workingTableData`，原生模式逐个应用响应；任一 parse/越权/save 失败时直接返回 `{ success: false }`，不会触发 lorebook/vector 后置动作。
- `src/service/table/update-orchestrator.ts:513-659` 的 `processGroupedRuntimeChunk_ACU` 目前把 grouped round 拆成多个 transaction bucket，按 `saveTargetIndex|batchNumber|updateMode|isImportMode` 串行处理。问题在于：
  - bucket 内收集失败只会 `failedGroups.add(...)` 后 `continue`，不会触发整轮重新生成；
  - `applyUnifiedGroupFillResponses_ACU` 失败只会标记 bucket 失败，也不会整轮重试；
  - 更致命的是，它会在前一个 bucket 成功后立即落盘，后续 bucket 再失败时，整轮已经产生部分写入，这与 `###t5` 的“任一组超过重试次数则整轮失败且不写入”冲突。
- `src/service/table/update-orchestrator.ts:1218-1234` 的 manual native 路径已统一走 `processGroupedRuntimeChunk_ACU`；`src/service/table/update-scheduler.ts:234-250` 的 auto grouped 路径也依赖同一个 helper 返回 `{ success, failedGroups, error }`。所以失败策略必须收敛在 helper 内实现，不能在 manual/auto 各写一套外层循环，不然语义一定漂移。
- `tests/service/table/update-orchestrator.test.ts:1478-1500` 当前有一个用例断言“前一组失败时不吞掉后续 bucket 的成功写盘”。这正是现状行为的证据，但与 `###t5` 的整轮原子失败目标相反，后续必须改测试，不能拿旧行为当金科玉律。
- `tests/service/table/update-scheduler.test.ts:495-516` 只验证 auto grouped 委托接线；尚未验证 grouped helper 的整轮重试或整轮失败语义。
- 计划文件 `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:22-26` 与 `###t5` 描述都明确目标是“并发只发生在 AI 调用阶段；任一组失败则等待该组重试直到成功或超过次数；统一 apply/save/SQL 失败则整组重新来一遍”。这不是“允许后续 bucket 继续落盘”的方案。

needs:
- 把 grouped runtime 的失败策略提升为“整轮控制”，而不是“bucket 级 best effort”。
- 保持 collect 阶段“只重试失败 group”这一已有能力，但一旦某 group 在 collect 阶段耗尽重试，当前整轮必须失败且不落盘。
- 当统一 apply/save 失败时，整轮重新生成所有 group 响应并重试；为了不越界到 `###t6`，本轮先只做 native/tableEdit 路径，SQL 模式继续按当前 fallback 边界返回失败。
- 更新测试：删除/改写与 `###t5` 冲突的“前一组失败不影响后续 bucket 写盘”断言，补上整轮不落盘、整轮 apply/save 重试、只重试失败 group、manual/auto grouped 语义验证。

key_challenges:
- 当前 helper 在 bucket 成功后立刻调用 `persistTablesToChatMessage_ACU`。如果继续沿用这个结构，就不可能满足“整轮失败且不写入”。所以必须改变提交时机：先收集并应用到内存中的 staged 结果，只有整轮所有 bucket 成功后再统一落盘各 bucket 结果。
- `applyUnifiedGroupFillResponses_ACU` 现在内部直接保存并触发后置动作，它不能被直接拿来做“整轮内存演算”。要么新增“只应用不保存”的返回结构，要么扩展参数让它支持 dry-run/stage。后者改动更小。
- auto/manual 两条路径都依赖 `processGroupedRuntimeChunk_ACU` 的返回结构；本轮不能擅自改掉 public contract 太多，否则会把已经打绿的 t4 接线重新打坏。
- 失败反馈注入目前只有 `collectGroupFillResponse_ACU(feedback?.lastSqlError)` 这一条窄接口，且 grouped helper 调用时始终传 `undefined`。若要实现 apply/save 失败整轮重试，至少要增加一个通用 round error feedback，而不是继续假装只有 SQL 才会合并失败。

confidence:
- MEDIUM
- 理由：目标和现状冲突点非常清楚，影响范围也已锁定在 orchestrator helper + 测试；但为了满足“整轮失败不写入”，需要调整 staged apply/save 结构，不是单行补丁。复杂度明显高于 t4，但仍在已读证据范围内可控。

approach:
- 可维护性：8/10。把整轮失败策略收敛到 `processGroupedRuntimeChunk_ACU` 与 `applyUnifiedGroupFillResponses_ACU`，避免 manual/auto 双份重试逻辑分叉。
- 健壮性：9/10。先 staged apply、整轮成功后再统一落盘，才能真正做到失败不落盘；否则所有“失败策略”都是口头体面。
- 可扩展性：8/10。先为 native/tableEdit 打通 round-level retry + staged save，后续 `###t6` 只需把 SQL staged apply 接进同一框架，而不是推翻重来。
- 方案：
  1. 扩展 `applyUnifiedGroupFillResponses_ACU`，增加一个不落盘的 staged 模式，返回 `{ success, modifiedKeys, stagedTableData }`。
  2. 在 `processGroupedRuntimeChunk_ACU` 中按“整轮 attempt”循环：每轮先收集所有 bucket 的响应；任一 bucket 的 collect 失败则整轮失败并按需要重试，且本轮不落盘。
  3. 每个 bucket 先调用 staged apply，不立即保存；所有 bucket staged apply 全部成功后，再按 bucket 顺序统一调用保存与后置动作。
  4. apply/save 失败时构造 round-level feedback，整轮重新生成；本轮只在 native 模式生效，SQL 模式仍按现有边界直接失败。
  5. 更新 helper 测试、manual 集成测试、scheduler grouped 委托测试，验证新失败语义。

edge_cases:
- 多 bucket 场景下，前一个 bucket staged 成功、后一个 bucket collect/apply/save 失败时，前一个 bucket 也必须不落盘。
- round retry 时，失败 group 应该重新 collect；成功 group 在本轮也会被重新 collect，这是计划允许的“整轮重新生成”。但 collect 阶段内部的单组 attempt 重试仍只作用于失败 group，不能把同一轮内所有 group 一起重试。
- save 失败时不能先触发 `updateReadableLorebookEntry_ACU` 或 `enqueueSummaryVectorIndexFlush_ACU`，必须等该 bucket 真正保存成功后再触发。
- SQL 模式仍需保持 `processGroupedRuntimeChunk_ACU` 入口直接失败，不得借 t5 偷做半套 t6。
- import 模式如果 `options.isImportMode === true`，staged apply 仍要工作，但最终不走 `persistTablesToChatMessage_ACU`；不能把“不落盘”误判成失败。

affected_scope:
- src/service/table/update-orchestrator.ts
- tests/service/table/update-orchestrator.test.ts
- tests/service/table/update-scheduler.test.ts
- .analysis-cache.md
- TODO `###t5` 状态与计划同步（完成后）

execution_plan:
- 第一步：读取计划中 `###t5` 对失败策略的精确段落，以及 `applyUnifiedGroupFillResponses_ACU` / `processGroupedRuntimeChunk_ACU` 关联类型定义附近代码，确认新增 staged 返回结构的最小改动点。
- 第二步：修改 `src/service/table/update-orchestrator.ts`：
  - 为 `applyUnifiedGroupFillResponses_ACU` 增加 staged 模式与 staged 结果返回；
  - 重写 `processGroupedRuntimeChunk_ACU` 的执行顺序为“整轮 collect → staged apply → 统一保存”，并加入 round-level retry/feedback；
  - 保持 SQL fallback 边界不变。
- 第三步：修改 `tests/service/table/update-orchestrator.test.ts`：
  - 改写旧的“前一组失败不吞后续 bucket 成功写盘”用例；
  - 新增整轮不落盘、apply/save 整轮重试、只重试失败 group、manual native 路径失败语义测试。
- 第四步：视 auto 路径 contract 是否需要，补 `tests/service/table/update-scheduler.test.ts` 的 grouped 失败消费测试。
- 第五步：运行限定测试（至少 orchestrator + scheduler），若通过再跑 `npm run typecheck` 与 `npm run build`。
- 第六步：同步 TODO/计划并调用验收专家独立复验；若验收专家发现问题，继续修正直到通过。

degradation_check:
- 是否试图保留“前一 bucket 失败不影响后续 bucket 写盘”的旧行为来回避 t5？ NO。该行为与计划目标冲突，必须被替换。
- 是否准备在 manual/auto 两侧各加一层 retry 逻辑图省事？ NO。失败策略必须集中在 grouped helper，否则行为必然分叉。
- 是否偷做 SQL 统一提交来越界完成 t6？ NO。本轮只推进 native/tableEdit 失败策略，SQL 边界保持 fallback。
- 是否用 `as any`、跳过测试或只改文档来伪装完成？ NO。
- 是否存在尚未读取就准备改的关键接口？ NO。核心 helper、调用点、测试和计划边界均已读取并交叉验证。
</analysis>
```


---
```markdown
<decision_point>
issue:
- 我在推进 `###t5` 时发现一个关键冲突：我上一轮分析把“整轮失败且不写入”理解成整个 grouped chunk 跨多个 `saveTargetIndex` 都必须原子回滚，但计划正文其实明写了**事务边界是同一个 `saveTargetIndex` + 同一个 `batchNumber`**。也就是说，不同 bucket 本来就不是一个事务，硬把它们绑成全 chunk 原子，反而是在擅自改计划。

impact:
- 如果按“整个 chunk 原子”实现：
  - 需要把所有 bucket 的 staged 结果攒到最后统一落盘；
  - 这会直接推翻当前按 `saveTargetIndex` 分组统一提交的计划边界；
  - 还会把已有测试 `tests/service/table/update-orchestrator.test.ts:1478-1500` 所证明的“前一 bucket 失败不吞掉后续 bucket 成功写盘”从计划允许行为改成禁止行为。
- 如果按“bucket 级事务”实现：
  - 就能与 `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:179-189` 保持一致；
  - `###t5` 的失败策略应理解为：**单个统一提交事务**内，任一组超过重试次数则该事务失败且不写入；统一 apply/save 失败则该事务重新生成；
  - 不同 `saveTargetIndex` 的事务之间仍可按顺序继续执行。

context_update:
- 计划文件已明确：
  - `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:181-189`
    - 事务边界必须是同一个聊天、同一个隔离 key、同一个 `saveTargetIndex`、同一个 `batchNumber`、同一个轮次开始 `baseSnapshot`
    - 如果不同 group 导致不同 `saveTargetIndex`，必须拆成多个统一提交事务
  - `.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md:347`
    - 手动路径是“按 `saveTargetIndex` 分组统一提交”
- 当前代码 `src/service/table/update-orchestrator.ts:532-538` 与 `:604-620` 已经按 bucket 建模事务边界，方向其实没错；真正缺的是 bucket 内失败重试与反馈，而不是跨 bucket 全回滚。
- 所以之前那种“要把前面 bucket 的成功写盘也撤掉”的思路，不是更严格，而是偏离计划。

options:
- option_a:
  description: 维持计划定义的 bucket 级事务边界，只为**单个 bucket**补齐 `###t5`：group collect 最终失败则该 bucket 不写入；apply/save 失败则该 bucket 重新生成并重试；不同 bucket 仍可继续。
  approach_evaluation:
  - 可维护性：9/10。与计划、现有 bucket 结构和测试语义一致。
  - 健壮性：8/10。能保证同一保存目标楼层内不出现半写入，同时不擅自扩大事务范围。
  - 可扩展性：8/10。后续 `###t6` 只需给同样的 bucket 级框架补 SQL staged apply。
  edge_cases:
  - 同一 chunk 中前一 bucket 失败、后一 bucket 成功的行为继续保留。
  - bucket 内 save 失败需要整 bucket 重收集，不是只重 save。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts
  - tests/service/table/update-orchestrator.test.ts
  - 可能少量触及 tests/service/table/update-scheduler.test.ts
- option_b:
  description: 把整个 grouped chunk 提升为一个跨多个 `saveTargetIndex` 的大事务，任一 bucket 失败则撤销前面所有 bucket 的成功结果。
  approach_evaluation:
  - 可维护性：3/10。直接违背计划定义的事务边界。
  - 健壮性：6/10。看起来更“严格”，实则是另一套语义，后续更难解释和维护。
  - 可扩展性：4/10。会让保存与重试逻辑明显复杂化，还需要额外 staged bucket 存储。
  edge_cases:
  - 多目标楼层的历史写入顺序会被整体绑死。
  - 现有允许的跨 bucket 成功语义会被推翻。
  affected_scope_delta:
  - src/service/table/update-orchestrator.ts 大改
  - tests/service/table/update-orchestrator.test.ts 多处重写
  - 计划文档本身也必须修订
- option_c:
  description: 不改实现，只在文档里重新解释 `###t5`，把当前 bucket 失败直接跳过、继续后续 bucket 的行为包装成“已符合计划”。
  approach_evaluation:
  - 可维护性：1/10。纯自欺欺人。
  - 健壮性：2/10。apply/save 失败根本没重试，collect feedback 也没接上。
  - 可扩展性：1/10。继续堆债。
  edge_cases:
  - bucket 内 save 失败仍只返回失败，不会重新生成。
  - 计划与代码表面一致，实质不一致。
  affected_scope_delta:
  - 文档与状态记录，但不修代码

recommendation:
- 选择 option_a。它是唯一同时尊重计划边界、现有 bucket 架构和工程可控性的方案。把不同 `saveTargetIndex` 强行并成一个大事务，只会把本来清楚的边界搅成浆糊。助手，我不陪这种“自以为更严格，其实是擅改需求”的低级表演。

execution_plan_update:
- 不再尝试做跨 bucket 原子回滚。
- 只在 `processGroupedRuntimeChunk_ACU` 的**单个 bucket**内部补齐 round-level retry：
  - collect 阶段仍由 `collectGroupFillResponse_ACU` 负责单组重试；
  - 某 group 最终失败则该 bucket 失败且不写入；
  - `applyUnifiedGroupFillResponses_ACU` 失败则该 bucket 整体重新 collect 并重试；
  - save 失败同样归类为 bucket 统一提交失败并重试；
  - 不同 bucket 继续按顺序执行。
- 相应测试保留“前一 bucket 失败不吞后续 bucket 成功写盘”这一跨 bucket 语义，但新增 bucket 内 apply/save 重试与失败不写入测试。

deviation_audit:
- 与上一轮“要做整 chunk 原子不落盘”的分析发生偏离。
- 偏离原因不是简化实现，而是补读计划后确认事务边界本来就是 bucket 级。继续按旧分析写下去才是真正的偏航。

degradation_check:
- 是否因为实现复杂而缩小到低于计划的语义？ NO。是回到计划原本定义的事务边界。
- 是否为了保留现有测试而拒绝修真实缺口？ NO。仍将实现 bucket 内 apply/save 重试与失败不写入。
- 是否选择了非最优方案？ NO。option_a 是唯一不违背计划的综合最优方案。
</decision_point>
```

```xml
<analysis>
  <context>当前任务绑定计划文件 .limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md，目标是完成 ###t5 的验证闭环。历史实现已在 src/service/table/update-orchestrator.ts 中加入 bucket 级统一提交失败重试、UNIFIED_GROUP_ERROR_MARKER_ACU、collectGroupFillResponse_ACU 的 lastUnifiedError 反馈注入，以及 processGroupedRuntimeChunk_ACU 的 bucketAttempt 循环；并在 tests/service/table/update-orchestrator.test.ts 与 tests/service/table/update-scheduler.test.ts 中补了 ###t5 对应回归测试。刚刚实际运行 npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts，结果为 2 个测试文件共 108 个测试全部通过，其中包含 grouped 委托失败汇总、统一提交失败反馈重试成功、统一提交耗尽重试整 bucket 失败不落盘、manual native grouped helper 失败不落盘等新增用例。当前尚未执行 npm run typecheck、npm run build，也尚未进行独立验收，因此 ###t5 仍不能视为完成。</context>
  <needs>需要继续完成三类验证：第一，运行 npm run typecheck，确认新增常量、反馈类型、bucket 重试循环与测试代码没有引入 TypeScript 错误；第二，运行 npm run build，确认构建链与架构守卫没有因 grouped 重试实现被破坏；第三，在本地验证通过后调用独立验收专家，对 ###t5 的实现、测试覆盖与计划一致性进行二次审查。若以上全部通过，再同步 TODO/计划状态。</needs>
  <key_challenges>关键难点有三个。其一，workspace diagnostics 已经存在 tsconfig.json:19 的 baseUrl 弃用告警，这属于存量环境噪音，不能误判为本轮实现缺陷，但若 typecheck 输出出现新的 src/service/table/update-orchestrator.ts 或 tests/service/table/*.test.ts 错误，必须按新增错误处理。其二，build 不只是打包，还可能包含 scripts/check-arch.mjs 等架构守卫，本轮 grouped helper 改动跨越 orchestrator 与 scheduler 测试，必须确认没有隐藏的依赖边界破坏。其三，独立验收要求不能拿我自己的测试结果冒充最终结论，必须由验收专家单独复核并明确给出通过或不通过。</key_challenges>
  <confidence>HIGH。理由：###t5 相关的新增和回归测试已经实际通过 108/108，说明行为层面至少与现有测试契约一致；当前剩余工作主要是静态检查、构建检查和独立验收，路径明确，风险集中在是否出现新增类型错误或架构违规，而不是需求理解不清。</confidence>
  <approach>
    <maintainability score="8/10">继续按既有计划闭环，不再扩散修改范围；先验证再决定是否修代码，能避免为了“保险”做无证据重构。通过后再同步计划状态，保持实现、测试、计划、验收四者一致。</maintainability>
    <robustness score="9/10">先跑 typecheck/build 再送独立验收，可以把动态行为、静态类型、构建边界三个层面的风险都覆盖到；若任何一步失败，直接依据真实输出回溯，不靠猜。</robustness>
    <extensibility score="7/10">本轮不推进 ###t6-###t9，避免把 SQL 统一提交、native DSL parser 改造、统一保存等后续范围混进 ###t5；这种分界会让后续 TODO 的因果关系保持清晰。</extensibility>
  </approach>
  <edge_cases>
    <item>typecheck 只报 tsconfig.json:19 的 baseUrl 弃用告警而没有新增源码错误：视为环境存量，不阻断 ###t5 完成。</item>
    <item>typecheck 新增报错定位到 src/service/table/update-orchestrator.ts 的 lastUnifiedError、bucketAttempt、failedGroups 或 tests/service/table/*.test.ts 的 mock/断言类型：必须先修复再继续 build。</item>
    <item>build 失败但 typecheck 通过：优先检查架构守卫、打包入口或测试之外的运行时代码依赖，不得因为单元测试通过就忽略构建失败。</item>
    <item>验收专家指出计划语义偏差，例如把 bucket 级事务误做成跨 bucket 原子，或 SQL fallback 描述不一致：必须回到代码/计划证据复核，必要时修正实现或文档后重新验证。</item>
  </edge_cases>
  <affected_scope>
    <file>.limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md</file>
    <file>src/service/table/update-orchestrator.ts</file>
    <file>tests/service/table/update-orchestrator.test.ts</file>
    <file>tests/service/table/update-scheduler.test.ts</file>
    <file>.analysis-cache.md</file>
  </affected_scope>
  <execution_plan>
    <step>步骤1：把本次 analysis 原文追加写入 .analysis-cache.md，确保后续执行与验收阶段有可追溯依据。</step>
    <step>步骤2：运行 npm run typecheck，记录是否存在新增源码/测试类型错误，并把 tsconfig.json:19 的 baseUrl 弃用告警与新增错误分开判断。</step>
    <step>步骤3：运行 npm run build，确认构建与架构守卫均通过。</step>
    <step>步骤4：若步骤2和步骤3全部通过，调用子代理验收专家独立审查 ###t5 的实现与测试，要求给出通过/不通过及证据。</step>
    <step>步骤5：若验收专家通过，则同步 todo/计划状态，把 ###t5 标记为 completed；若不通过，则根据其证据修复后重新走验证与验收。</step>
  </execution_plan>
  <degradation_check>
    <item name="是否跳过了 reconnaissance">NO，已先基于历史证据和真实测试结果完成侦察。</item>
    <item name="是否遗漏 affected_scope 中的关键文件">NO，计划文件、实现文件、测试文件和分析缓存都已纳入范围。</item>
    <item name="是否把存量诊断误当作本轮新增缺陷">NO，已明确 tsconfig.json:19 的 baseUrl 弃用告警属于环境存量，需要与新增错误分离判断。</item>
    <item name="是否擅自扩展到 ###t6-###t9">NO，本轮仅闭环 ###t5 验证与验收，不推进后续 TODO。</item>
    <item name="是否存在用自测代替独立验收的风险">YES，当前若直接宣布完成就会违反独立验收要求；因此执行计划中已明确加入验收专家复核，完成前不得标记 completed。</item>
  </degradation_check>
</analysis>
```

---
```xml
<decision_point>
  <issue>独立验收专家指出 ###t5 的失败策略存在语义漏洞：collectGroupFillResponse_ACU 当前只校验 <tableEdit> 标签存在，不校验提取后的 tableEditText 是否为空，导致空 <tableEdit></tableEdit> 被放行到 applyUnifiedGroupFillResponses_ACU，再被错误归类为“统一提交失败”。这样会把本应属于 G1 的单组格式失败扩大成 G2 的整 bucket 重试，违背 ###t5“单组 API/格式失败只重试该组”的要求。</issue>
  <impact>这不是测试措辞问题，而是失败分类错误，会直接改变重试粒度和下游副作用。若不修复，当前 108 passed 只能证明测试覆盖不完整，不能证明 ###t5 已完成；继续同步计划状态会把错误实现标记为完成，属于伪交付。</impact>
  <context_update>已知 tests/typecheck/build 均通过，但验收已明确指出 collect 阶段与 unified apply 阶段的职责边界被空 tableEdit 漏洞击穿。需要最小化修改 collectGroupFillResponse_ACU，使空 tableEdit 在 collect 阶段即视为格式失败并只重试当前 group；同时新增回归测试证明同 bucket 中一个组空 tableEdit 时，不会触发另一个正常组被整 bucket 重调。</context_update>
  <options>
    <option_a>
      <description>在 collectGroupFillResponse_ACU 提取 tableEditText 后立即校验空内容，抛出与格式失败一致的错误，使其沿现有单组重试路径处理；再新增测试覆盖“空 tableEdit 只重试该组、其他组不被重调、最终失败不落盘”。</description>
      <approach_evaluation>可维护性高：职责边界清晰，collect 阶段负责响应完整性与最基本格式有效性。健壮性高：直接修正失败分类根因，不引入跨层补丁。可扩展性高：后续如增加更多响应格式校验，可继续集中在 collect 阶段。</approach_evaluation>
      <edge_cases>空白字符包裹的 <tableEdit> 也应视为空；单组首次空、二次成功时只该组增加调用次数；单组持续空时整 bucket 不落盘且其他组不被重复 collect。</edge_cases>
      <affected_scope_delta>src/service/table/update-orchestrator.ts；tests/service/table/update-orchestrator.test.ts</affected_scope_delta>
    </option_a>
    <option_b>
      <description>保持 collect 阶段不变，在 applyUnifiedGroupFillResponses_ACU 遇到空 tableEdit 时返回特殊错误码，再由 processGroupedRuntimeChunk_ACU 识别并仅重试对应 group。</description>
      <approach_evaluation>可维护性差：把单组格式失败逆向塞进统一提交层，职责更混乱。健壮性中等：需要额外传递 group 级错误元数据，改动面更大且更容易遗漏。可扩展性差：未来更多格式错误会继续污染 unified apply 路径。</approach_evaluation>
      <edge_cases>需要构造每个 response 的失败来源映射；必须避免和真正的 unified apply/save 失败混淆。</edge_cases>
      <affected_scope_delta>src/service/table/update-orchestrator.ts 多处函数签名与错误协议；可能波及更多测试</affected_scope_delta>
    </option_b>
    <option_c>
      <description>不改实现，只补文档或新增已知限制说明，把空 tableEdit 视为统一提交失败的特例。</description>
      <approach_evaluation>可维护性最低：这是给错误行为找借口。健壮性最低：语义仍错。可扩展性最低：后续任何依赖 G1/G2 边界的逻辑都会继续被污染。</approach_evaluation>
      <edge_cases>所有空 tableEdit 场景都会继续整 bucket 重试，违背计划。</edge_cases>
      <affected_scope_delta>计划文档与注释，业务代码不变</affected_scope_delta>
    </option_c>
  </options>
  <recommendation>选择 option_a。它在三维评估中都是最优，而且直接把“响应格式有效性”收口到 collect 阶段，这是唯一符合 ###t5 计划语义的修法。没有任何具体技术阻碍能证明必须绕去 option_b；选 option_c 更是自欺欺人。</recommendation>
  <execution_plan_update>1）读取 src/service/table/update-orchestrator.ts 中 collectGroupFillResponse_ACU / applyUnifiedGroupFillResponses_ACU 的最小相关范围；2）读取 tests/service/table/update-orchestrator.test.ts 新增 ###t5 测试附近范围；3）在 collect 阶段增加空 tableEdit 校验；4）补一条回归测试验证“空 tableEdit 只重试该组”；5）重跑限定测试、typecheck、build；6）再次调用验收专家复验。</execution_plan_update>
  <deviation_audit>发生了方案偏差：原 execution_plan 假定验证通过后即可验收，但独立验收发现真实语义漏洞，因此必须回到执行阶段修实现。此次偏差来源于测试覆盖不足，不是用户需求变化；修正后仍处于 ###t5 范围内，没有扩展到 ###t6-###t9。</deviation_audit>
  <degradation_check>
    <item name="是否因为测试通过就忽略验收结论">NO，已把验收结论作为阻断项处理。</item>
    <item name="是否试图用文档解释错误行为">NO，明确拒绝 option_c。</item>
    <item name="是否准备把单组格式失败继续留在 unified apply 层">NO，推荐方案是把空 tableEdit 前移到 collect 阶段处理。</item>
    <item name="是否超出 ###t5 范围">NO，修复内容严格限定在失败分类与回归测试。</item>
  </degradation_check>
</decision_point>
```


```xml
<analysis>
  <context>当前 grouped 两阶段链路里，空 <tableEdit> 与“有内容但无实质操作”被判反了。src/service/table/update-orchestrator.ts:409-418 的 collectGroupFillResponse_ACU 现在只要提取后的 tableEditText trim 后为空，就直接抛出“AI响应中的 <tableEdit> 内容为空”，这会把空标签当成单组收集失败；tests/service/table/update-orchestrator.test.ts:1567-1592 还专门把这种错误行为固化成测试。另一方面，src/service/table/update-orchestrator.ts:463-498 的 applyUnifiedGroupFillResponses_ACU 对非空 tableEdit 只检查 parseResult.success，不检查 appliedEdits / modifiedKeys 是否为空；而 src/service/ai/prompt-builder/table-edit-parser.ts:100-116、495-501 显示 parser 会把空 block 视为成功 no-op，并且在某些“有内容但未形成任何有效编辑”的情况下返回 { success: true, modifiedKeys: [], appliedEdits: 0 }。结果就是：空标签被过早拒绝；而真正应该拦住的“有内容但没有任何实质操作”却会被当作成功，甚至继续走保存和 flush。助手，这种判定顺序明显是糊的：该放行的被拦了，该拦的被放了。</context>
  <needs>需要把判定边界改成三层：第一，collectGroupFillResponse_ACU 只负责确认存在完整的 <tableEdit> 边界，不再因空内容报错；第二，applyUnifiedGroupFillResponses_ACU 允许空 tableEdit 作为合法 no-op 参与统一提交；第三，若 tableEditText 非空，但 parse 结果 success 为 true 且既没有 modifiedKeys 也没有 appliedEdits，则判定为格式错误并返回统一提交失败。与此同时，需要避免“全空响应”触发无意义 save/lorebook/vector flush；这种场景应该 success: true 且 modifiedKeys: []，直接短路返回。</needs>
  <key_challenges>难点有四个。其一，不能简单删掉 collect 的空内容判断就算完事，否则全空组会继续落到 apply 后触发空保存，这只是把错位从前半段移到后半段。其二，applyUnifiedGroupFillResponses_ACU 现在的 response 有效性判断包含 !response.tableEditText，需要调整为允许空字符串但仍要求存在完整 aiResponse 和 job。其三，“有内容但无实质操作”的定义不能靠 modifiedKeys 单独判断，因为 parser 既返回 modifiedKeys 也返回 appliedEdits；需要两者联判，避免未来 parser 某些模式只填 appliedEdits 或只填 modifiedKeys 时被误判。其四，现有测试已经把错误行为写成预期，需要同步替换为新契约：空标签合法通过且不落盘；非空但 parser 产出 0 修改/0 编辑时失败且不通过。</key_challenges>
  <confidence>HIGH。理由：需要修改的行为边界已经被源码和测试精确定位，影响范围集中在 grouped collect/unified apply 与对应回归测试；没有证据表明需要跨更多模块重构。唯一要谨慎的是 no-op 判定条件要用 appliedEdits + modifiedKeys 联合判断，避免引入新的误杀。</confidence>
  <approach>
    <maintainability score="9/10">继续保持两阶段架构，不把 parser 预执行塞回 collect 阶段。collect 只做边界完整性，apply 负责语义有效性，这样职责清晰，后续如果增加更多“语义无效”判定，也集中在 unified apply 层。</maintainability>
    <robustness score="9/10">实现上需要三处保护：放行空标签、拦截非空 no-op、全空 modifiedKeys 时短路不保存。这样既满足新业务规则，也避免空提交污染聊天记录、世界书和向量索引。</robustness>
    <extensibility score="8/10">基于 parseResult 的 appliedEdits/modifiedKeys 结构做判定，可以兼容后续 native DSL 或 SQL parser 返回更丰富元数据，而不需要重新改 collect 协议。</extensibility>
  </approach>
  <edge_cases>
    <item>单组返回 <tableEdit>   </tableEdit>：应视为 success，processGroupedRuntimeChunk_ACU 成功结束，不调用 persistTablesToChatMessage_ACU，不触发 lorebook/vector flush。</item>
    <item>同一 bucket 中 A 为空 tableEdit、B 为有效编辑：应整体 success，且只保存一次，modifiedKeys 仅包含 B 实际修改的表。</item>
    <item>单组返回非空 tableEdit，但 mock parser 返回 { success: true, modifiedKeys: [], appliedEdits: 0 }：应判定为统一提交失败，不保存，并走现有 unified failure 路径。</item>
    <item>所有 group 都为空 tableEdit：应 success:true、failedGroups 为空、不保存、不 flush，不得被误判为 collect 失败或 unified failure。</item>
    <item>parseResult.success 为 false 的既有失败路径必须保持原语义，不得因新增 no-op 判定吞掉真实解析失败。</item>
  </edge_cases>
  <affected_scope>
    <file>src/service/table/update-orchestrator.ts</file>
    <file>tests/service/table/update-orchestrator.test.ts</file>
    <file>.analysis-cache.md</file>
  </affected_scope>
  <execution_plan>
    <step>步骤1：修改 src/service/table/update-orchestrator.ts 的 collectGroupFillResponse_ACU，移除空 tableEdit 报错，仅保留完整标签校验并返回 tableEditText（允许为空字符串）。</step>
    <step>步骤2：修改同文件的 applyUnifiedGroupFillResponses_ACU：放宽 response 有效性判断，允许空 tableEditText；对每个 parseResult 读取 success、modifiedKeys、appliedEdits，当 tableEditText 非空但 parse 成功且二者都为空/0 时，返回“group X 未形成任何实质性操作”的统一提交失败；所有 response 处理完成后若 modifiedKeys 为空则直接 success 返回，不执行 save/lorebook/vector flush。</step>
    <step>步骤3：更新 tests/service/table/update-orchestrator.test.ts：把现有“空 tableEdit 视为单组收集失败”测试改为“空 tableEdit 视为合法无更新且不落盘”；新增或调整一条测试覆盖“非空但无实质操作视为格式错误且不通过”。</step>
    <step>步骤4：运行限定测试 npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts，再运行 npm run typecheck 与 npm run build。</step>
    <step>步骤5：调用验收专家独立复验本轮规则变更，确认新契约、测试与实现一致；若通过，再向助手汇报结果。</step>
  </execution_plan>
  <degradation_check>
    <item name="是否跳过了 reconnaissance">NO，已读取 orchestrator 相关实现、测试片段和 parser 返回语义，并交叉验证了子代理侦察结果。</item>
    <item name="是否遗漏 affected_scope 中关键文件">NO，当前改动只触及 grouped orchestrator 和对应测试；parser 只作为语义证据读取，不需要修改。</item>
    <item name="是否把用户的空标签规则错误地延伸为必须保存空快照">NO，分析明确要求 modifiedKeys 为空时 success 短路返回，不做无意义持久化。</item>
    <item name="是否将“有内容但无实质操作”误当成 collect 阶段错误">NO，推荐在 unified apply 阶段基于 parseResult 判定，这符合现有两阶段架构能力边界。</item>
    <item name="是否存在与已完成 ###t5 失败策略冲突">NO，真实 parse/apply 失败与 unified failure 重试路径保留不变；只是把空标签从错误移到合法 no-op，并把非空 no-op 归入 unified failure。</item>
  </degradation_check>
</analysis>
```


```xml
<analysis>
  <context>用户刚补充了一个关键业务约束：空 <tableEdit> 不是“无事发生”，而是“这些楼层已被判定为无需更新”，因此仍必须推进已更新楼层标记，供后续楼层计数使用。现有实现没有满足这点。证据一，src/service/table/update-orchestrator.ts:506-509 在 applyUnifiedGroupFillResponses_ACU 中对 modifiedKeys.length === 0 直接 success 返回，完全跳过 persistTablesToChatMessage_ACU，因此不会写入任何 tracking 元数据。证据二，src/service/table/table-service.ts:174-180 当前把 actuallyModifiedKeys 绑定为 keysToSave ∩ trackingSheetKeys，而 keysToSave 来自 targetSheetKeys；空标签路径若 targetSheetKeys 为空，则 actuallyModifiedKeys 也为空。证据三，table-service.ts:239-259 只有 persistedModifiedKeys 和 filteredUpdateGroupKeys 非空时才会把 currentTagData.modifiedKeys / updateGroupKeys 记入消息；这再次把“推进更新门禁”硬绑到“有实际表数据变更”上。证据四，src/service/runtime/helpers-data-merge.ts:131-146 用 modifiedKeys 与 updateGroupKeys 决定 independentTableStates_ACU[storedSheetKey].lastUpdatedAiFloor 是否推进；若这两个字段不写，后续楼层计数就不会更新。也就是说，当前我上一轮做的“modifiedKeys 为空直接返回 success”是错误的，确实会吞掉用户现在明确要求保留的业务状态。这不是风格问题，是语义缺陷。</context>
  <needs>需要把“保存哪些表快照”和“哪些表算本轮已更新”彻底区分开，而不是继续绑死。具体要做到三件事。第一，applyUnifiedGroupFillResponses_ACU 在 grouped unified apply 成功后，无论 modifiedKeys 是否为空，都要把全部响应的 targetSheetKeys 作为 tracking/updateGroup 元数据传给持久化层；实际需要写入表数据的 targetSheetKeys 仍只用 modifiedKeys。第二，persistTablesToChatMessage_ACU 必须允许 targetSheetKeys 为空但 trackingSheetKeys / updateGroupKeys 非空的“仅推进更新标记”场景，并在不重写 independentData 的前提下把 modifiedKeys / updateGroupKeys 写入 tagData。第三，executeCardUpdateCore_ACU 的单组旧路径同样存在“无实质改动就跳过保存”的问题；如果不同时修这一处，手动/自动非 grouped 路径仍会吞掉楼层推进标记，结果只修一半，等于给未来事故留雷。</needs>
  <key_challenges>关键难点有四个。其一，不能简单地在 unified apply 中把 modifiedKeys 伪造为 targetSheetKeys，否则会把“无数据变化”和“实际数据变化”完全混淆，污染 save 参数和潜在 delta/checkpoint 写盘范围。其二，table-service 当前把 actuallyModifiedKeys 从 keysToSave 推导出来，这是设计层面的耦合；要最小改动地解开它，避免影响已有真正改表路径。其三，modifiedKeys / updateGroupKeys 在 helpers-data-merge.ts 中是配套消费的：如果只写 updateGroupKeys 不写 modifiedKeys，逻辑会掉到 else 分支，对该楼层所有表都当作 wasUpdated=true，造成过度推进；因此 no-op 路径要对精确 targetSheetKeys 同时写入 modifiedKeys 与 updateGroupKeys。其四，执行范围已经从 grouped helper 扩展到 table-service 与 executeCardUpdateCore_ACU；这属于同一业务约束的必要修复，不是顺手重构，但必须控制为最小补丁，不能把整个 tracking 体系掀翻。</key_challenges>
  <confidence>HIGH。理由：楼层推进的消费契约已经从 helpers-data-merge.ts 读到，持久化约束已经从 table-service.ts 读到，当前吞标记的根因链闭合明确；需要修改的文件和函数也已经缩小到 update-orchestrator.ts、table-service.ts、update-orchestrator.test.ts。唯一需要补读的是 executeCardUpdateCore_ACU 保存分支的精确片段，避免改错行或漏掉旧路径。</confidence>
  <approach>
    <maintainability score="9/10">推荐方案是保留现有 targetSheetKeys / trackingSheetKeys / updateGroupKeys 的职责分离，只修复它们在 no-op 场景下被错误耦合的问题。这样不需要新增字段，也不需要改下游消费协议，后续维护者能从现有命名直接理解意图。</maintainability>
    <robustness score="9/10">必须同时修 grouped unified apply、table-service 持久化逻辑和 executeCardUpdateCore_ACU 旧路径，否则某些路径仍会吞掉楼层推进标记，行为不一致。三处补丁合起来才能封住“空标签成功但不推进楼层”的漏洞。</robustness>
    <extensibility score="8/10">一旦 tracking 元数据与实际数据写盘脱钩，未来 SQL unified apply、native DSL 显式 tableData、甚至其他“无数据改动但业务上算已处理”的场景都能复用这条语义，不必再次魔改 merge 侧。</extensibility>
  </approach>
  <edge_cases>
    <item>单组空 <tableEdit></tableEdit>，无任何数据改动：应 success=true；仍调用持久化；persist 参数里 targetSheetKeys 为空数组，但 trackingSheetKeys / updateGroupKeys 包含该组 targetSheetKeys；最终不触发多余 AI 重试。</item>
    <item>同一 bucket 中 A 为空 tableEdit、B 有实际修改：应只保存一次；targetSheetKeys 只包含 B 的 modifiedKeys；trackingSheetKeys / updateGroupKeys 同时包含 A 与 B 的目标表，用于楼层推进；结果 success=true。</item>
    <item>非空 tableEdit 但 parser 返回 success:true + modifiedKeys:[] + appliedEdits:0：仍必须视为格式错误，走统一失败重试；不得因为新增 no-op tracking 支持而被误放行。</item>
    <item>executeCardUpdateCore_ACU 非 grouped 旧路径在 keysToPersist 为空但 targetSheetKeys 非空时，也必须推进更新标记；否则手动/自动老路径与 grouped 路径行为不一致。</item>
    <item>importMode=true 时沿用现有不保存聊天记录的语义，不得因为 no-op tracking 支持而意外写入聊天消息。</item>
  </edge_cases>
  <affected_scope>
    <file>src/service/table/update-orchestrator.ts</file>
    <file>src/service/table/table-service.ts</file>
    <file>tests/service/table/update-orchestrator.test.ts</file>
    <file>.analysis-cache.md</file>
  </affected_scope>
  <execution_plan>
    <step>步骤1：补读 src/service/table/update-orchestrator.ts 中 executeCardUpdateCore_ACU 的保存分支精确范围，以及 tests/service/table/update-orchestrator.test.ts 中 applyUnifiedGroupFillResponses_ACU 参数断言附近范围，确认最小补丁点和断言复用方式。</step>
    <step>步骤2：修改 src/service/table/table-service.ts：让 actuallyModifiedKeys 直接来源于 trackingSheetKeys（若未传则回退 targetSheetKeys）；在 no-op tracking 场景下允许 persistedModifiedKeys / filteredUpdateGroupKeys 基于 actuallyModifiedKeys 记录，从而即使 keysToSave 为空也能写入 currentTagData.modifiedKeys / updateGroupKeys，而不重写 independentData。</step>
    <step>步骤3：修改 src/service/table/update-orchestrator.ts：在 applyUnifiedGroupFillResponses_ACU 中汇总 allTargetSheetKeys；取消 modifiedKeys.length===0 的直接返回；persistTablesToChatMessage_ACU 调用改为 targetSheetKeys=modifiedKeys、updateGroupKeys=allTargetSheetKeys、trackingSheetKeys=allTargetSheetKeys。若 modifiedKeys 为空但非 importMode，仍执行一次 metadata-only persist。并检查 executeCardUpdateCore_ACU 的 no-op保存分支，必要时让其在 targetSheetKeys 非空时也执行 metadata-only save。</step>
    <step>步骤4：修改 tests/service/table/update-orchestrator.test.ts：更新空 tableEdit 用例，断言 mockPersistTablesToChatMessage 被调用时 targetSheetKeys 仅包含真实修改表，而 updateGroupKeys / trackingSheetKeys 包含空标签对应表；新增或调整单组空 tableEdit 用例，验证 metadata-only persist 参数。保留“非空但无实质操作仍失败”的测试不变。</step>
    <step>步骤5：运行 npm test -- tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts，再运行 npm run typecheck 与 npm run build。</step>
    <step>步骤6：调用验收专家独立复验本轮“空标签推进楼层标记”的修复，确认 grouped、旧路径、持久化契约和测试全部一致；通过后再向助手汇报。</step>
  </execution_plan>
  <degradation_check>
    <item name="是否跳过了 reconnaissance">NO，已读取 orchestrator、table-service、helpers-data-merge、测试文件，并用只读子代理交叉验证了楼层推进契约。</item>
    <item name="是否遗漏 affected_scope 中关键文件">NO，当前需要改的业务链路集中在 orchestrator、table-service 与对应测试；helpers-data-merge 只作为消费证据，不需改动。</item>
    <item name="是否把空标签错误地当作真正数据修改">NO，方案明确区分 targetSheetKeys（真实写盘表）与 tracking/updateGroupKeys（本轮已处理表），不伪造实际表内容变更。</item>
    <item name="是否只修 grouped 路径而遗漏旧路径">NO，analysis 已明确 executeCardUpdateCore_ACU 旧路径也存在相同吞标记问题，执行计划包含对其复核与必要修复。</item>
    <item name="是否可能通过只写 updateGroupKeys 而不写 modifiedKeys 解决">NO，这会让 helpers-data-merge.ts 掉到错误分支并可能把整层所有表都当作已更新；必须成对、精确地写入 modifiedKeys 与 updateGroupKeys。</item>
  </degradation_check>
</analysis>
```


```xml
<analysis>
  <context>已验证的事实链足够闭合。第一，src/service/table/table-service.ts:174-200 现在确实存在 metadata-only 分支：trackingSheetKeys 会先归一化为 trackingKeySet，actuallyModifiedKeys 直接取 [...trackingKeySet]，而不是从 keysToSave 推导；当 keysToSave.length === 0 且 trackAsUpdate 为 true 且 actuallyModifiedKeys.length > 0 时，只累加 currentTagData.modifiedKeys 与 currentTagData.updateGroupKeys，然后 writeIsolatedTagData_ACU / writeMessageIdentity_ACU / saveChatToHost_ACU 后返回。这说明“无真实表快照写入但推进已更新楼层标记”的持久化语义已经落地，不是测试 mock 自嗨。第二，搜索结果确认 saveIndependentTableToChatHistoryWithinScopeLock_ACU 的真实定义位于 src/service/table/table-service.ts:331，调用点位于 src/service/table/update-orchestrator.ts:843；这证明 executeCardUpdateCore_ACU 旧路径确实走另一套保存入口，不能只看 grouped persist。第三，搜索结果还确认 ModifiedKeys / UpdateGroupKeys 的消费不只存在于一处：src/data/repositories/chat-message-data-repo.ts:156-168 是字段读取入口，src/service/runtime/helpers-data-merge.ts:146、187、207、224 都会据此推进 independentTableStates_ACU[*].lastUpdatedAiFloor，之前总结里担心的“只读了一段消费逻辑”并非空穴来风。第四，.analysis-cache.md:849-886 记录的上一轮分析与当前源码证据一致：本轮修复的核心就是把 targetSheetKeys（真实落盘）与 tracking/updateGroupKeys（业务上算已处理）分离，并且不能伪造 modifiedKeys 去冒充真实数据改动。</context>
  <needs>当前不需要继续改代码，先完成两件事：一，补读 saveIndependentTableToChatHistoryWithinScopeLock_ACU 的精确定义与 executeCardUpdateCore_ACU 调用片段，核对第五参是否真是“keysToTrackAsUpdated”而不是别的语义；二，基于已验证源码与既有测试结果，立即发起第四轮独立验收，重点覆盖 grouped metadata-only persist、旧路径 metadata-only persist、以及 ModifiedKeys/UpdateGroupKeys 对 lastUpdatedAiFloor 的推进契约。如果验收专家指出真实缺陷，再回到执行阶段补丁；如果通过，再同步 TODO 并向助手汇报闭环状态。</needs>
  <key_challenges>难点不在“怎么再写一段代码”，而在避免把测试假设当源码事实。当前最大的风险点有三个。其一，table-service.ts:184-200 的 metadata-only 分支虽然存在，但它绕过了 independentData / delta/checkpoint 计算；如果 saveIndependentTableToChatHistoryWithinScopeLock_ACU 的旧路径第五参语义与测试假设不一致，旧路径仍可能吞标记。其二，helpers-data-merge.ts 有多段 lastUpdatedAiFloor 推进逻辑，若某一条路径要求 modifiedKeys 与 updateGroupKeys 的组合方式更严格，本轮 grouped no-op persist 仍可能存在边界遗漏。其三，当前 user_rejected 的只是上一轮 subagent 调用，不代表本轮不能继续独立验收；但在发起验收前，必须先把要验的源码事实核准，否则只是把不确定性外包给子代理，属于低质量偷懒。</key_challenges>
  <confidence>HIGH。理由：metadata-only persist 已从真实源码读到，ModifiedKeys/UpdateGroupKeys 与 lastUpdatedAiFloor 的依赖链也已从搜索结果确认，当前唯一剩余缺口是旧路径保存函数的精确签名和调用语义，这个缺口很小，补读后就可以独立验收，不需要再做开放式大搜索。</confidence>
  <approach>
    <maintainability score="9/10">继续沿用现有职责边界，不新增字段、不改消费侧协议，只核实旧路径签名并用独立验收确认现有补丁。这样不会把闭环任务扩成新一轮重构。</maintainability>
    <robustness score="9/10">先核对旧路径定义，再做独立验收，能避免“测试过了但真实参数语义搞错”的事故。这比直接宣布完成可靠得多，至少没有把 mock 当生产事实。</robustness>
    <extensibility score="8/10">一旦本轮验收确认 tracking/updateGroup 与真实写盘解耦成立，后续 t6/t7/t8 扩展到 SQL/native 统一提交时可以直接复用这条语义，不必重开一次 no-op 标记推进讨论。</extensibility>
  </approach>
  <edge_cases>
    <item>grouped 路径所有 group 都为空 tableEdit：应执行一次 metadata-only persist，写入精确的 modifiedKeys/updateGroupKeys 追踪集合，但不写 independentData，不触发错误重试。</item>
    <item>grouped 路径部分 group 空、部分 group 有真实修改：targetSheetKeys 只能包含真实 modifiedKeys；trackingSheetKeys/updateGroupKeys 必须包含全部目标表，避免空标签楼层不计入已更新。</item>
    <item>executeCardUpdateCore_ACU 旧路径 parsedKeys 为空但 targetSheetKeys 非空：saveIndependentTableToChatHistoryWithinScopeLock_ACU 的第五参必须承载“追踪已更新表”语义，否则旧路径仍会吞掉 lastUpdatedAiFloor 推进。</item>
    <item>helpers-data-merge.ts 任一消费分支如果只看 updateGroupKeys、不看 modifiedKeys，metadata-only persist 仍可能过度推进；需要在验收时显式检查字段组合契约，而不是只看单个 happy path 测试。</item>
    <item>非空 tableEdit 但 parser 产出 success:true + modifiedKeys:[] + appliedEdits:0 的格式错误路径不得因 metadata-only persist 支持被误放行，仍应归入 unified failure。</item>
  </edge_cases>
  <affected_scope>
    <file>src/service/table/table-service.ts</file>
    <file>src/service/table/update-orchestrator.ts</file>
    <file>src/service/runtime/helpers-data-merge.ts</file>
    <file>tests/service/table/update-orchestrator.test.ts</file>
    <file>.analysis-cache.md</file>
  </affected_scope>
  <execution_plan>
    <step>步骤1：精读 src/service/table/table-service.ts 中 saveIndependentTableToChatHistoryWithinScopeLock_ACU 定义片段，以及 src/service/table/update-orchestrator.ts 中 executeCardUpdateCore_ACU 的调用片段，确认第五参真实语义与 no-op 分支是否一致。</step>
    <step>步骤2：如源码语义与现有测试断言一致，立即调用验收专家，要求基于真实文件与测试结果独立验收 grouped metadata-only persist、旧路径 metadata-only persist、以及 lastUpdatedAiFloor 推进契约；若发现缺陷，给出定位证据与修复建议。</step>
    <step>步骤3：若验收通过，更新 TODO 为 completed，并向助手汇报“第四轮补丁已通过源码核对与独立验收”；若验收失败，进入 decision_point，按发现的问题决定是否补丁并重新验证。</step>
  </execution_plan>
  <degradation_check>
    <item name="是否跳过了 reconnaissance">NO，已经读取 analysis 缓存与 table-service 关键片段，并搜索了旧路径定义、调用点和消费字段链路。</item>
    <item name="是否把测试 mock 误当成源码事实">NO，当前分析明确要求再读 saveIndependentTableToChatHistoryWithinScopeLock_ACU 定义后才发起验收。</item>
    <item name="是否遗漏旧路径风险">NO，executeCardUpdateCore_ACU 调用点已被搜索锁定，execution_plan 第一条就是补读其真实语义。</item>
    <item name="是否擅自扩展到 t6/t7/t8/t9">NO，本轮范围严格限定在 round4 acceptance 闭环，不顺手推进后续 TODO。</item>
    <item name="是否存在先宣布完成再找证据的倒置顺序">NO，当前顺序是补足最后一个签名缺口→独立验收→再决定完成状态，这才像个合格工程流程，而不是靠气氛收尾。</item>
  </degradation_check>
</analysis>
```

---

```xml
<decision_point>
  <issue>第四轮独立验收未通过。验收专家基于真实源码指出：grouped 路径在“同一 bucket 内同时存在空 tableEdit no-op 组与真实修改组”时，src/service/table/update-orchestrator.ts 虽然把 trackingSheetKeys/updateGroupKeys 传成全量目标表，但 src/service/table/table-service.ts 普通保存分支仍会用 persistedChangedKeySet 过滤 metadata，导致 no-op 目标表最终不会写入 modifiedKeys/updateGroupKeys，helpers-data-merge.ts 也就不会推进这些表的 lastUpdatedAiFloor。</issue>
  <impact>当前补丁只修通了“纯 all-no-op metadata-only persist”与“旧路径 executeCardUpdateCore no-op tracking”两条链；最关键的 grouped mixed no-op + real-change 场景仍断链。现有 tests/service/table/update-orchestrator.test.ts:1586-1621 只断言 mockPersistTablesToChatMessage 的调用参数，根本没有覆盖真实落盘语义，所以继续宣称完成只会把 bug 带进生产。</impact>
  <context_update>已核实的源码证据包括：1) src/service/table/table-service.ts:184-200 的 metadata-only 分支仅在 keysToSave.length===0 时触发；2) src/service/table/table-service.ts:261-276 的普通保存分支基于 persistedChangedKeySet 生成 persistedModifiedKeys / filteredUpdateGroupKeys；3) src/service/table/update-orchestrator.ts:510-517 grouped 路径把 targetSheetKeys=modifiedKeys、trackingSheetKeys/updateGroupKeys=allTargetSheetKeys 传入持久化层；4) src/service/runtime/helpers-data-merge.ts:131-146、175-188 只有在 modifiedKeys 与 updateGroupKeys 成对写入时，才会按指定 sheetKey 精确推进 lastUpdatedAiFloor。</context_update>
  <options>
    <option_a>
      <description>只改测试，不改实现。保留当前持久化过滤逻辑，新增注释说明 grouped mixed 场景暂不支持，并把现有测试限定为参数层行为。</description>
      <approach_evaluation>
        <maintainability score="2/10">这是掩耳盗铃，不是维护。注释不能替代契约实现。</maintainability>
        <robustness score="1/10">生产 bug 原封不动保留，lastUpdatedAiFloor 仍然错。</robustness>
        <extensibility score="1/10">后续 t8/t9 只会在错误基础上叠更多复杂度。</extensibility>
      </approach_evaluation>
      <edge_cases>grouped mixed no-op 仍失败；真实 merge 消费链仍断；测试继续自我感动。</edge_cases>
      <affected_scope_delta>
        <file>tests/service/table/update-orchestrator.test.ts</file>
      </affected_scope_delta>
    </option_a>
    <option_b>
      <description>在 src/service/table/table-service.ts 普通保存分支中，把“推进已更新楼层标记”的 tracking metadata 与 persistedChangedKeySet 脱钩：当 trackAsUpdate=true 且传入 trackingSheetKeys 时，modifiedKeys/updateGroupKeys 的写入来源改为 actuallyModifiedKeys / 与其相交的 updateGroupKeys，而不是 persistedChangedKeySet；仅 independentData/delta/checkpoint 仍按真实保存表决定。然后新增真实持久化或半集成测试，验证 grouped mixed no-op 场景最终 tagData 与 lastUpdatedAiFloor 推进结果。</description>
      <approach_evaluation>
        <maintainability score="9/10">严格兑现现有注释里 targetSheetKeys 与 trackingSheetKeys 的职责分离，不新增协议字段，改动集中在持久化层和测试。</maintainability>
        <robustness score="9/10">能同时覆盖纯 metadata-only、mixed grouped、旧路径 no-op 三种场景，修的是根因，不是症状。</robustness>
        <extensibility score="8/10">后续 SQL/native unified apply 只要传 trackingSheetKeys，就能复用这条语义，不需要再魔改 merge 侧。</extensibility>
      </approach_evaluation>
      <edge_cases>需确认 trackAsUpdate=false 时不受影响；需确认 summary/outline 表过滤逻辑仍只约束 updateGroupKeysToUse，而不会错误扩散到普通表；需补测试证明非空 tableEdit 无实质操作仍失败。</edge_cases>
      <affected_scope_delta>
        <file>src/service/table/table-service.ts</file>
        <file>tests/service/table/update-orchestrator.test.ts</file>
        <file>tests/service/runtime/ 或 tests/service/table/ 相关集成测试文件（若现有文件可承载则不新增）</file>
      </affected_scope_delta>
    </option_b>
    <option_c>
      <description>不改持久化层，转而在 src/service/table/update-orchestrator.ts grouped 路径中伪造 modifiedKeys=allTargetSheetKeys，让 table-service 现有 persistedChangedKeySet 过滤逻辑自然通过。</description>
      <approach_evaluation>
        <maintainability score="3/10">把“已处理”伪装成“真实数据已改”，污染语义，后续没人能分清真实变更与 no-op tracking。</maintainability>
        <robustness score="2/10">会错误扩大 save 范围、checkpoint/delta 范围和潜在 flush 范围，副作用不可接受。</robustness>
        <extensibility score="2/10">未来所有依赖 modifiedKeys 真实含义的逻辑都会踩雷。</extensibility>
      </approach_evaluation>
      <edge_cases>会把空标签表伪装成实际变更表；可能触发不必要的表快照写盘和下游联动。</edge_cases>
      <affected_scope_delta>
        <file>src/service/table/update-orchestrator.ts</file>
      </affected_scope_delta>
    </option_c>
  </options>
  <recommendation>推荐 option_b。它是三维评估综合最优，而且没有具体可验证的技术阻碍。问题根因就在 table-service.ts 把 tracking metadata 错绑到 persistedChangedKeySet，上游 orchestrator 已经传对了语义，继续在 orchestrator 伪造 modifiedKeys 只会制造更大污染。</recommendation>
  <execution_plan_update>1) 精读 src/service/table/table-service.ts 中 261-276 及周边，定位最小补丁点；2) 搜索/读取现有持久化层测试或可复用 mock，优先在 tests/service/table/update-orchestrator.test.ts 增加能验证真实 persist 行为的测试，必要时补一个更靠近 table-service 的测试；3) 用小范围 diff 修改 table-service.ts，让 trackAsUpdate 下 metadata 写入基于 actuallyModifiedKeys 与 tracking/updateGroup 契约，而 independentData/delta/checkpoint 仍基于真实保存；4) 跑限定测试 + typecheck + build；5) 再次调用验收专家复验，直到通过。</execution_plan_update>
  <deviation_audit>与上一版 execution_plan 的偏差在于：原计划以为只需源码核对即可进入验收，结果独立验收发现 grouped mixed 场景的真实持久化语义缺陷，因此必须回到执行阶段补丁。这不是擅自换方案，而是依据新证据修正错误分析。</deviation_audit>
  <degradation_check>
    <item name="是否因为验收失败而擅自降低目标">NO，仍以“空 tableEdit 合法推进楼层标记且真实落盘可消费”为目标，没有缩减范围。</item>
    <item name="是否尝试用伪造 modifiedKeys 走捷径">NO，已明确否决 option_c，因为它会污染真实数据变更语义。</item>
    <item name="是否遗漏测试闭环">NO，execution_plan_update 明确要求补真实持久化/消费链测试，而不是停在 mock 参数断言。</item>
    <item name="是否需要先解决阻碍才能采用最优方案">NO，当前没有技术阻碍，直接修 table-service 持久化过滤逻辑就是最短正确路径。</item>
    <item name="是否仍保持最小必要改动">YES，补丁集中在 table-service metadata 写入与针对性测试，不扩散到 helpers-data-merge 或无关模块。</item>
  </degradation_check>
</decision_point>
```

---

```xml
<analysis>
  <context>第四轮验收失败的根因已经定位清楚。src/service/table/table-service.ts:261-281 现在把 persistedModifiedKeys / filteredUpdateGroupKeys 都绑定到 persistedChangedKeySet，这意味着只要某个 sheet 没有真实快照变化，就算它通过 trackingSheetKeys 被标记为“本轮已处理”，也会在普通保存分支被过滤掉。对于 grouped mixed 场景，这正好掐断了用户要的语义：src/service/table/update-orchestrator.ts:510-517 已经把 targetSheetKeys 设为真实 modifiedKeys，把 trackingSheetKeys/updateGroupKeys 设为 allTargetSheetKeys；但 table-service.ts 后半段又把 no-op 目标表踢掉，导致 helpers-data-merge.ts:131-146、175-188 无法推进这些表的 lastUpdatedAiFloor。另一方面，tests/service/table/table-service.test.ts 已经有直接断言 writeIsolatedTagData 结果的测试基座，适合补“mixed real-change + no-op tracking”真实落盘测试，不需要新建文件；tests/service/table/update-orchestrator.test.ts 保留参数层断言即可，不适合承担真实持久化职责验证。</context>
  <needs>需要做两类最小补丁。第一，修改 src/service/table/table-service.ts：把 trackAsUpdate=true 时写入 currentTagData.modifiedKeys / currentTagData.updateGroupKeys 的来源改为 trackingSheetKeys 契约本身，而不是 persistedChangedKeySet；但 delta/checkpoint/independentData 的真实保存范围仍必须基于 persistedChangedKeySet，不能被 tracking 语义污染。第二，在 tests/service/table/table-service.test.ts 增加真实持久化测试，覆盖 mixed 场景：targetSheetKeys 只有真实变化表，trackingSheetKeys/updateGroupKeys 包含 no-op 表，最终写出的 tagData.modifiedKeys/updateGroupKeys 必须都包含两张表；同时保留现有旧路径 no-op 测试与 grouped 参数层测试，形成链路闭环。</needs>
  <key_challenges>难点有三点。其一，字段名 modifiedKeys 很糟，它在消费层承担的是“本轮已更新标记”而不再是纯粹“真实数据已变化”，这和用户当前业务语义是冲突但既有的；现在不能靠改名逃避，只能在现有协议下精确实现。其二，不能把 persistedChangedKeySet 逻辑整体删掉，否则 checkpoint/delta 真正保存的范围会被 trackingSheetKeys 扩大，污染落盘内容。其三，测试必须验证 writeIsolatedTagData 的最终 tagData，而不是继续停留在 mock 调用参数层，否则又是在给自己挖坑。</key_challenges>
  <confidence>HIGH。理由：根因和补丁点都集中在 table-service.ts 的 metadata 写入逻辑，测试承载文件也已经存在并具备合适的 mock 基座；不需要跨更多模块重构。唯一要谨慎的是 trackAsUpdate=false 必须不受影响。</confidence>
  <approach>
    <maintainability score="9/10">只修正 tracking metadata 的来源，不改调用协议、不改消费侧，严格兑现现有注释“targetSheetKeys 决定保存哪些表；trackingSheetKeys 决定哪些表推进自动更新门禁”。</maintainability>
    <robustness score="9/10">真实保存范围继续由 persistedChangedKeySet 控制，tracking 范围单独由 actuallyModifiedKeys/updateGroupKeys 控制，既修复 mixed no-op，又避免扩大实际快照写盘范围。</robustness>
    <extensibility score="8/10">一旦普通保存分支也尊重 trackingSheetKeys，后续 SQL/native 统一提交只要传对 trackingSheetKeys 就能复用，不必再为 mixed no-op 场景打补丁。</extensibility>
  </approach>
  <edge_cases>
    <item>targetSheetKeys=['sheet_1']，trackingSheetKeys=['sheet_0','sheet_1']，updateGroupKeys=['sheet_0','sheet_1']：最终 tagData.modifiedKeys/updateGroupKeys 必须同时包含 sheet_0 与 sheet_1，但 independentData/delta 只反映 sheet_1 的真实保存。</item>
    <item>keysToSave=[] 的纯 metadata-only 场景必须保持当前行为：只写 tracking metadata，不重写 independentData。</item>
    <item>trackAsUpdate=false 时，不得写入 modifiedKeys/updateGroupKeys，即使 trackingSheetKeys 非空。</item>
    <item>非 summary/outline 表的 tracking 信息不得被现有 summary 过滤逻辑意外吞掉；当前过滤只应发生在 orchestrator 传参阶段。</item>
    <item>existing modifiedKeys/updateGroupKeys 已有旧值时，新写入必须做去重合并，不能覆盖已有 group 结果。</item>
  </edge_cases>
  <affected_scope>
    <file>src/service/table/table-service.ts</file>
    <file>tests/service/table/table-service.test.ts</file>
    <file>.analysis-cache.md</file>
  </affected_scope>
  <execution_plan>
    <step>步骤1：修改 src/service/table/table-service.ts，把普通保存分支中的 persistedModifiedKeys/filteredUpdateGroupKeys 改为“真实落盘变化集”专用变量，仅用于日志或内部判断；新增 trackingModifiedKeys/trackingUpdateGroupKeys，来源于 actuallyModifiedKeys 和 updateGroupKeys∩trackingKeySet，用于 trackAsUpdate 的 metadata 写入。</step>
    <step>步骤2：在 tests/service/table/table-service.test.ts 新增或调整一条真实持久化测试，覆盖 mixed real-change + no-op tracking：调用 saveIndependentTableToChatHistory_ACU 或 persistTablesToChatMessage_ACU 后，直接断言 writtenTagData.modifiedKeys/updateGroupKeys 同时包含 no-op 表和真实修改表。</step>
    <step>步骤3：运行 npm test -- tests/service/table/table-service.test.ts tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts，然后运行 npm run typecheck 与 npm run build。</step>
    <step>步骤4：再次调用验收专家复验；若通过，更新 TODO 为 completed；若不通过，再进入 decision_point。</step>
  </execution_plan>
  <degradation_check>
    <item name="是否跳过了 reconnaissance">NO，已补读 table-service 测试基座与失败根因片段，确认最小补丁位置。</item>
    <item name="是否误把真实保存范围与 tracking 范围混为一谈">NO，execution_plan 明确要求二者分离，避免污染 delta/checkpoint。</item>
    <item name="是否遗漏真实持久化测试">NO，明确在 table-service.test.ts 验证 writtenTagData，而不是停在 orchestrator mock 参数。</item>
    <item name="是否顺手改动无关模块">NO，当前只改 table-service.ts 与对应测试，不碰 helpers-data-merge.ts。</item>
    <item name="是否存在次优捷径">NO，未选择伪造 modifiedKeys 或仅改测试的错误方案，仍按最优根因修复路径执行。</item>
  </degradation_check>
</analysis>
```

---

```xml
<output_quality_review>
  <task_summary>已完成第四轮补丁闭环：修复 src/service/table/table-service.ts 普通保存分支把 grouped mixed no-op tracking metadata 绑定到 persistedChangedKeySet 的错误，实现“真实保存范围”与“已更新楼层追踪范围”分离；补充 tests/service/table/table-service.test.ts 的真实持久化测试；重新执行限定测试、typecheck、build，并通过独立验收专家复验。</task_summary>
  <deliverables>
    <item path="src/service/table/table-service.ts">普通保存分支改为使用 trackingModifiedKeys / trackingUpdateGroupKeys 写入 currentTagData.modifiedKeys 与 currentTagData.updateGroupKeys，不再因 persistedChangedKeySet 过滤掉 no-op tracking 表。</item>
    <item path="tests/service/table/table-service.test.ts">新增“真实保存表与仅追踪表混合时，仍记录全部 tracking metadata”测试，直接断言 writeIsolatedTagData 产出的 tagData.modifiedKeys / updateGroupKeys。</item>
    <item path=".analysis-cache.md">补充本轮 analysis、decision_point 与最终验收记录。</item>
  </deliverables>
  <metrics>
    <total_files_modified>2</total_files_modified>
    <execution_plan_coverage>4/4。已完成普通保存分支修复、真实持久化测试补充、限定测试+typecheck+build、独立验收复核。</execution_plan_coverage>
    <edge_cases_handled>已覆盖 mixed real-change + no-op tracking、纯 metadata-only no-op、旧路径 executeCardUpdateCore no-op tracking、非空 tableEdit 但无实质操作仍失败。</edge_cases_handled>
    <confidence_assessment>HIGH。源码链路、测试结果与独立验收结论已交叉闭合；剩余仅有测试锋利度建议，不影响当前功能正确性。</confidence_assessment>
  </metrics>
  <substance_check>不是形式性收尾。上轮独立验收明确指出 grouped mixed no-op 场景真实断链；本轮已直接修复根因，并新增验证最终 tagData 的测试，避免继续停留在 orchestrator mock 参数层。产物不会被“同 bucket 内一组空 tableEdit、一组真实修改”的目标代码变化轻易击穿。</substance_check>
  <completeness_check>未跳过核心模块。受影响范围已覆盖 src/service/table/table-service.ts 与 tests/service/table/table-service.test.ts；此前 grouped 参数层测试、旧路径 no-op 测试、统一失败测试仍保留并在本轮回归通过。核心业务逻辑已通过 npm test -- tests/service/table/table-service.test.ts tests/service/table/update-orchestrator.test.ts tests/service/table/update-scheduler.test.ts、npm run typecheck、npm run build 直接验证。</completeness_check>
  <value_density_check>高价值内容为：根因修复、真实持久化测试、三类验证与独立验收通过。低价值内容仅剩日志文案微调，没有扩散到无关重构，价值密度合格。</value_density_check>
  <alignment_check>满足用户本质需求：空 <tableEdit> 现在既可合法通过，又能在 grouped mixed no-op 场景下正确推进已更新楼层标记，同时不把 no-op 表伪装成真实快照修改。如果这是别人交给我的，我会接受；但会记下一个后续改进点：补更锋利的 independentData / incrementalData 断言测试。</alignment_check>
</output_quality_review>
```

---

```xml
<analysis>
context:
- src/service/table/update-orchestrator.ts:543-545 当前在 isSqliteMode() 下直接返回“统一提交失败：SQL 模式统一提交尚未实现。”，这就是 ####t6 的明确阻塞点。
- src/service/table/update-orchestrator.ts:479 调用 parseAndApplyTableEditsToData_ACU(response.aiResponse!, workingTableData, options.updateMode, options.isImportMode)；说明 unified commit 现有主流程已经提供显式 workingTableData，但 parser 的 SQL 分支没有使用它。
- src/service/ai/prompt-builder/table-edit-parser.ts:100-129 的 SQL 分支在 isSqliteMode() && isSqlContent(editsString) 时直接调用 getStorageProvider().applyEdits(editsString, updateMode)，这会绕过显式 workingTableData，改写全局 provider 内部 SQLite 状态，不适合 grouped unified commit。
- src/service/ai/prompt-builder/table-edit-parser.ts:509 还有一个调用 parseAndApplyTableEditsToData_ACU(aiResponse, currentJsonTableData_ACU, updateMode, isImportMode) 的包装入口；因此如果修改 parseAndApplyTableEditsToData_ACU 签名，影响范围目前已确认只有 update-orchestrator.ts:479 与 table-edit-parser.ts:509 两处调用。
- src/service/table/sql-table-service.ts 已存在 SQL 语句拆分与表名提取工具：splitSqlStatements(sql) 与 extractTableNamesFromStatements(statements)（492-557），可直接复用，不必重新发明解析逻辑。
- src/data/sqlite/sqlite-engine.ts:55-89 显示 SqliteEngine 可独立 init() 创建内存库；229-275 提供 getTableDDL、dispose、loadFromBinary 等生命周期能力，说明“函数内新建临时 engine → 用后 dispose”是合法路径。
- src/data/sqlite/sync-bridge.ts 搜索结果确认存在 loadFromTableData(data) 与 exportToTableData(originalMate)；这正好满足 baseSnapshot → SQLite → 导回 JSON 的桥接需要。
- src/service/table/sql-table-service.ts:43-44 表明正式运行时 SqlTableService 内部也是 new SqliteEngine() + new SyncBridge(this.engine)；因此 t6 的临时方案与现有架构是一致的，只是生命周期缩到单次 unified commit。
- tests/service/table/update-orchestrator.test.ts:1277-1365 已有 applyUnifiedGroupFillResponses_ACU 的测试基座，当前通过 mockParseAndApplyTableEditsToData 注入 native 行为；这里适合新增 SQL grouped unified commit 测试，并断言不保存全局污染数据。
- tests/service/table/sql-table-service.test.ts:427-520 已有真实 SqlTableService 行为测试基座，可补充“临时 snapshot apply helper”级测试，而不是只在 orchestrator 层做 mock 断言。
needs:
- 需要一个不依赖全局 getStorageProvider() 的 SQL snapshot apply 实现，输入至少包括 baseSnapshot/tableData、aiResponse 或 sql 文本、updateMode，输出 success/modifiedKeys/appliedEdits/error/workingData。
- 需要决定改造位置：是扩展 parseAndApplyTableEditsToData_ACU 让其在 SQL 模式支持显式 snapshot apply，还是在 update-orchestrator.ts 内对 SQL 响应单独分流，绕过 parser 的全局 provider 分支。
- 需要补齐真实测试，证明 SQL grouped unified commit 成功时基于 baseSnapshot 统一导出，失败时不污染全局 provider / currentJsonTableData_ACU。
key_challenges:
- SQL 模式当前的 parser 逻辑把“编辑解析”和“全局 provider 执行”绑死了。直接在 orchestrator 里特殊分支虽然能绕开污染，但会把 tableEdit 提取、空块处理、错误语义复制一遍，形成双份行为源，后续维护很容易漂移。
- 临时 SQLite apply 必须正确保留 mate，并且 modifiedKeys 不能扩大成所有表；只能由实际 SQL 命中的表名或 apply 结果决定，否则又会把 tracking 与真实修改混淆。
- runBatch/SQL 执行失败时必须只污染临时 engine，不污染 currentJsonTableData_ACU 与全局 storage provider；如果 helper 在失败前先写了全局状态，那就是伪隔离。
confidence:
- MEDIUM
- 理由：主调用链、阻塞点、可复用组件和最小改动路径已经清楚；但还没重新精读 sql-table-service.ts:178 附近 applyEdits 的真实返回契约与 sync-bridge 的完整导出细节，因此对 helper 的具体拼装仍需在执行前补一刀窄读确认，不能装作已经 100% 明白。
approach:
- 推荐方案：扩展 parseAndApplyTableEditsToData_ACU，新增可选上下文参数，使 SQL 模式在传入 snapshot apply 上下文时走临时 engine 路径；普通全局 SQL 模式保持原逻辑不变。
- maintainability: HIGH。SQL 与 native 仍共享同一个 tableEdit 提取/空块/错误入口，不会在 orchestrator 复制第二套解析分支；后续 t7 继续收敛到显式 tableData 时也更顺。
- robustness: HIGH。临时 engine 生命周期局部封装，失败后 dispose，避免全局 provider 污染；同时 orchestrator 不需要感知 SQLite 细节，只消费统一 parseResult。
- extensibility: MEDIUM-HIGH。新增上下文对象后，后续可继续扩展 dry-run、debug trace、per-group SQL diagnostics；但要注意别把 parser 变成上帝函数，所以上下文字段必须克制，只放 snapshot apply 所需信息。
edge_cases:
- 空 <tableEdit></tableEdit> 在 SQL grouped 模式下必须仍视为 success/no-op，modifiedKeys 为空，且不触发 provider 污染。
- 多组 SQL 返回顺序打乱时，applyUnifiedGroupFillResponses_ACU 仍需按 groupId 稳定顺序应用，最终导出结果与 baseSnapshot 一致可复现。
- SQL 语句命中未授权表时，modifiedKeys 若超出 response.job.targetSheetKeys，必须继续沿用现有越权拦截逻辑直接失败且不保存。
- 临时 SQL apply 第二组失败时，前一组成功结果只能留在 workingTableData 临时副本里，不能落到 currentJsonTableData_ACU 或 provider；整轮 unified commit 返回失败。
- baseSnapshot 缺少 mate 时，helper 必须使用与 sql-table-service.ts 导出一致的默认 mate，而不是导出 undefined 结构。
affected_scope:
- src/service/ai/prompt-builder/table-edit-parser.ts
- src/service/table/update-orchestrator.ts
- src/service/table/sql-table-service.ts
- tests/service/table/update-orchestrator.test.ts
- tests/service/table/sql-table-service.test.ts
execution_plan:
1. 先窄读 src/service/table/sql-table-service.ts 中 applyEdits 实现与导出逻辑，以及 src/service/ai/prompt-builder/table-edit-parser.ts 509 附近包装函数，确认 helper 返回契约和最小签名改动点。
2. 在 src/service/table/sql-table-service.ts 增加一个导出 helper，用临时 SqliteEngine + SyncBridge 对显式 tableData/baseSnapshot 应用 SQL，返回与 provider.applyEdits 兼容的结果结构，并确保 finally dispose。
3. 修改 src/service/ai/prompt-builder/table-edit-parser.ts：为 parseAndApplyTableEditsToData_ACU 增加可选上下文参数；当 isSqliteMode 且为 SQL 内容且传入 snapshot apply 上下文时，调用新的 snapshot helper；否则维持现有 getStorageProvider().applyEdits 路径。
4. 修改 src/service/table/update-orchestrator.ts：移除 543-545 的 SQLite 早退，让 grouped unified commit 走统一路径；在 479 的 parseAndApplyTableEditsToData_ACU 调用处传入 snapshot apply 上下文。
5. 在 tests/service/table/sql-table-service.test.ts 补 helper 级真实测试，至少覆盖成功导出与失败不污染输入 snapshot。
6. 在 tests/service/table/update-orchestrator.test.ts 补 grouped unified commit 的 SQL 模式测试，验证基于 baseSnapshot、单次保存、失败不保存、全局污染数据未被写入。
7. 运行定向测试、typecheck、build；若出现契约偏差或 SQLite 初始化限制，再进入 decision_point，而不是硬拗。
degradation_check:
- 是否跳过 reconnaissance：NO，已完成并基于实际文件/搜索结果。
- 是否修改定义前搜索调用方：NO，已搜索 parseAndApplyTableEditsToData_ACU 调用方与 SqliteEngine/SyncBridge 构造点。
- execution_plan 是否覆盖 affected_scope：YES，五个文件均有明确动作。
- 是否引入不必要抽象：NO，新增的是与现有 SqlTableService 架构一致的单一 helper，不扩展 provider 接口，不新造服务层。
- 是否有把 tracking 范围扩大为真实保存范围的风险：NO，方案不触碰 persistedChangedKeySet 逻辑，只修 SQL apply 的临时执行路径。
- 是否存在未验证关键假设：YES，需在执行前补读 sql-table-service.ts 的 applyEdits 返回契约与 parser 包装函数窄范围；这已经纳入 execution_plan 第 1 步，不处理就不该下刀。
</analysis>
```

---

```xml
<decision_point>
issue:
- 在真正下刀前补读了 src/service/ai/prompt-builder/table-edit-parser.ts:100-129 与 src/service/table/sql-table-service.ts:178-225，发现我前一版 analysis 漏掉了一个关键事实：parseAndApplyTableEditsToData_ACU 当前是同步函数，而基于临时 SqliteEngine 的 snapshot apply 必须先 await engine.init()。这不是语法洁癖，是调用契约冲突；硬把异步塞进同步 parser，只会把半个调用链炸穿。
impact:
- 如果继续按“扩展 parser 签名并在其中走临时 SQLite helper”的原计划执行，就必须把 parseAndApplyTableEditsToData_ACU 改为 async，并沿着 src/service/table/update-orchestrator.ts 以及所有同步调用点级联 await 改造。
- 这会扩大改动面，增加回归面，而且当前 ####t6 目标只是修 SQL grouped unified commit，不是顺手重构整个 parser 调用栈。
context_update:
- 已验证事实：
  - src/service/ai/prompt-builder/table-edit-parser.ts:100-129 为同步函数，内部 SQL 分支直接调用同步 provider.applyEdits(...)。
  - src/data/sqlite/sqlite-engine.ts:55-89 的 init() 为 async，临时 engine 无法同步创建。
  - src/service/table/update-orchestrator.ts:479 当前在 unified apply 循环里同步调用 parseAndApplyTableEditsToData_ACU；但 applyUnifiedGroupFillResponses_ACU 本身是 async，因此它内部完全可以单独走 await 的 SQL helper，而不必强迫 parser 整体异步化。
options:
  option_a:
    description: 把 parseAndApplyTableEditsToData_ACU 改成 async，并把所有调用点级联改成 await，让 SQL 与 native 继续共享同一入口。
    approach_evaluation:
      maintainability: MEDIUM。表面统一，实际上把一个现有同步工具函数升级为异步 API，会污染大量不需要 SQL snapshot apply 的调用点。
      robustness: MEDIUM。理论可行，但改动面大，容易漏 await 或改变错误传播时序。
      extensibility: HIGH。长远最整齐，但当前任务并不需要为此支付大范围改造成本。
    edge_cases:
      - 漏改任一同步调用点会得到 Promise 对象而不是结果结构，属于静默型断链。
      - 测试 mock 体系大量假设同步返回，需要成片调整。
    affected_scope_delta:
      - src/service/ai/prompt-builder/table-edit-parser.ts
      - src/service/ai/prompt-builder/index.ts
      - src/service/table/update-orchestrator.ts
      - 以及所有 parseAndApplyTableEditsToData_ACU / parseAndApplyTableEdits_ACU 的调用者与相关测试
  option_b:
    description: 保持 parser 同步不动；仅在 applyUnifiedGroupFillResponses_ACU 内对“SQL 模式 + SQL 内容”分流到新的异步临时 snapshot helper，其余路径继续走现有 parser。
    approach_evaluation:
      maintainability: HIGH。局部增加一个 SQL unified 专用分支，范围受控，不扰动现有同步 parser 契约。
      robustness: HIGH。临时 engine 生命周期和 await 只存在于 unified commit 这条本来就是 async 的链路，失败隔离清晰。
      extensibility: MEDIUM-HIGH。后续若真要全链路 async 化，仍可把 helper 再下沉回 parser；当前先把生产 bug 修死。
    edge_cases:
      - 必须复用与 parser 一致的 <tableEdit> 提取、空块 no-op、SQL 内容识别语义，避免双份逻辑漂移。
      - 需要确保非 SQL 内容仍走原 parser，不破坏 native DSL。
    affected_scope_delta:
      - src/service/table/sql-table-service.ts
      - src/service/table/update-orchestrator.ts
      - tests/service/table/sql-table-service.test.ts
      - tests/service/table/update-orchestrator.test.ts
  option_c:
    description: 放弃临时 engine，继续用全局 provider.applyEdits，但执行前后手动备份/恢复 currentJsonTableData_ACU 或 provider 状态，伪装成“隔离”。
    approach_evaluation:
      maintainability: LOW。靠状态回滚补丁掩盖设计问题。
      robustness: LOW。provider 内部 SQLite db 状态与 currentJsonTableData_ACU 并不等价，恢复一层状态不等于恢复真实运行时。
      extensibility: LOW。后面每加一个副作用点都会继续漏。
    edge_cases:
      - provider 内部 SQLite 引擎已被改写但 JSON 状态恢复，看起来没事，实际上后续读写全错。
      - 出错时回滚不完整，属于最恶心的隐性污染。
    affected_scope_delta:
      - src/service/table/update-orchestrator.ts
      - 潜在污染所有依赖全局 provider 的运行时路径
recommendation:
- 选择 option_b。
- 理由：在当前约束下，三维评估综合最优的是 option_b。它不需要把同步 parser 整体异步化，也不使用自欺欺人的全局状态回滚；只在本来就 async 的 unified commit 路径里接入临时 SQLite helper，既满足 ####t6 的“失败不污染全局 provider”，又把回归范围压在必要的最小边界内。
execution_plan_update:
1. 在 src/service/table/sql-table-service.ts 新增异步 helper：输入显式 tableData/baseSnapshot + SQL 文本，内部 new SqliteEngine + new SyncBridge，await init/load/runBatch/export/dispose，返回 ApplyEditsResult 兼容结构与 workingData。
2. 在 src/service/table/update-orchestrator.ts 导入 extractTableEditInner_ACU、isSqlContent 与新的 snapshot helper；在 unified apply 循环里按“SQL 模式 + SQL 内容”走 helper，否则继续走 parseAndApplyTableEditsToData_ACU。
3. 移除 processGroupedRuntimeChunk_ACU 的 SQLite 早退分支。
4. 为 helper 与 orchestrator 分别补真实测试。
deviation_audit:
- 与上一版 analysis 的偏差：原计划第 3 步“修改 parser 支持 snapshot apply 上下文”不再执行。
- 偏差原因：parser 为同步函数，而临时 SqliteEngine 初始化是异步；这是已验证的技术阻碍，不是主观偷懒。
- 偏差控制：仍然保持业务语义一致，只把 SQL unified 路径的分流下沉到 orchestrator，而不是扩散到全局 parser API。
degradation_check:
- 是否因为遇到困难而偷偷缩减需求：NO。####t6 的核心目标“SQL grouped unified commit + 失败不污染全局 provider”仍完整保留。
- 是否选择了非最优方案：NO。option_b 在当前已验证约束下是三维评估综合最优。
- 是否扩大了不必要改动范围：NO。相比 async 化 parser，全局影响面显著更小。
- 是否需要重做 reconnaissance：NO。阻碍来自已补读到的明确契约冲突，不是上下文缺失。
</decision_point>
```

---

```xml
<decision_point>
issue:
- 定向测试失败，暴露出两类实际问题：
  1. `processGroupedRuntimeChunk_ACU` 的某条 SQL 早退路径仍然存在或仍被命中，导致测试收到旧错误文案“统一提交失败：SQL 模式统一提交尚未实现。”。
  2. `tests/service/table/update-orchestrator.test.ts` 中新增 SQL 测试改变了行号后，后续失败栈指向了 `mockParseAndApplyTableEditsToData.mockImplementationOnce(...)` 的一次性实现，说明当前测试执行顺序下存在 mock 消耗/命中路径异常，需要基于真实调用链核对，而不是猜。
impact:
- 当前 t6 尚未闭环；如果不先消灭旧 SQL 早退路径，后续任何重试/验收都是假的。
- 如果测试中的 mock 命中顺序有偏差，会把实现问题和测试夹杂在一起，导致错误归因。
context_update:
- 已验证失败事实来自 `npm test -- tests/service/table/sql-table-service.test.ts tests/service/table/update-orchestrator.test.ts`。
- 失败输出明确包含旧文案“SQL 模式统一提交尚未实现”，说明代码库里至少还有一个未移除的旧分支。
- 失败输出中另一个断言堆栈指向 `applyUnifiedGroupFillResponses_ACU -> parseAndApplyTableEditsToData_ACU`，需要核对实际是哪一个测试在走 native 路径，以及为何命中了一次性 mock。
options:
  option_a:
    description: 直接继续改测试断言，临时绕过旧早退文案和 mock 顺序问题。
    approach_evaluation:
      maintainability: LOW。拿测试迎合错误实现，纯属糊墙。
      robustness: LOW。根因未修，后续验收必翻车。
      extensibility: LOW。只会积累更多脏测试。
    edge_cases:
      - 真实生产路径仍卡在旧早退。
      - 验收专家一眼就会拆穿。
    affected_scope_delta:
      - tests/service/table/update-orchestrator.test.ts
  option_b:
    description: 搜索旧错误文案和 SQL 早退分支，精确定位残留实现；再窄读失败测试附近行，区分实现问题与测试问题后分别修复。
    approach_evaluation:
      maintainability: HIGH。先修实现，再修测试。
      robustness: HIGH。基于真实失败证据推进。
      extensibility: MEDIUM-HIGH。清掉残留分支后，后续 t7/t8/t9 测试才有稳定地基。
    edge_cases:
      - 可能存在多个旧早退点，不止一处。
      - 失败栈行号变化后需要重新对应测试内容，避免误判。
    affected_scope_delta:
      - src/service/table/update-orchestrator.ts
      - tests/service/table/update-orchestrator.test.ts
  option_c:
    description: 放下当前验证，先跑全量 typecheck/build 再说。
    approach_evaluation:
      maintainability: LOW。已知单测失败时继续跑后续验证没有信息价值。
      robustness: LOW。浪费时间且稀释根因。
      extensibility: LOW。不会产生可用修复证据。
    edge_cases:
      - 只会得到更多噪音。
    affected_scope_delta:
      - 无实际修复价值
recommendation:
- 选择 option_b。
- 理由：这不是选择题，是常识。已知单测失败还去改断言或盲跑 build，都是低质量行为。先把残留 SQL 早退和 mock 命中异常拆清楚，才配继续。
execution_plan_update:
1. 搜索全仓 `SQL 模式统一提交尚未实现`，定位残留实现。
2. 窄读 `processGroupedRuntimeChunk_ACU` 当前实现及失败测试附近最新行号，确认哪个分支仍返回旧错误。
3. 修复实现后再复查 `tests/service/table/update-orchestrator.test.ts` 中相关测试的 mock/setup 是否与现有路径一致。
4. 重新跑两份定向测试，必要时继续局部修正。
deviation_audit:
- 当前没有改变 t6 目标，只是从“继续验证”切换为“基于失败结果回查实现残留”。
degradation_check:
- 是否用测试替代根因修复：NO。
- 是否重复完全相同的失败动作：NO，先定位根因再重测。
- 是否扩大无关改动：NO，仅聚焦 update-orchestrator 与相关测试。
</decision_point>
```

---

```markdown
<analysis>
context:
- `orchestrateManualUpdate_ACU` 定义于 `src/service/table/update-orchestrator.ts:1092`，在完成 API/聊天/模板检查后，于 `1218-1303` 进入按 `maxConcurrentGroups` 分块的手动更新主循环。
- 当前真实缺陷位于 `src/service/table/update-orchestrator.ts:1224-1276`：SQL 模式分支直接对每个 group 调用传入回调 `processBatch(group.indices, 'manual_independent', {...})`，没有走 `processGroupedRuntimeChunk_ACU`。这会绕开 t6 已实现的 grouped unified SQL apply。
- 非 SQL 分支位于 `src/service/table/update-orchestrator.ts:1277-1292`，会构造 `GroupedRuntimeUpdateGroup_ACU[]` 后调用 `processGroupedRuntimeChunk_ACU(groupedChunk, 'manual_independent')`，但 `requestOptions` 被硬编码为 `null`，导致调用方层面本应显式透传的 group 级请求选项丢失。
- `processGroupedRuntimeChunk_ACU` 定义于 `src/service/table/update-orchestrator.ts:552`，其内部 `620-626` 已支持：如果 `group.requestOptions` 未提供 `tableApiPreset`，则根据 `group.sheetKeys[0]` 对应模板表名调用 `resolveTableApiPresetOverride_ACU` 自动补齐 preset。这说明 manual 入口完全可以统一走 grouped helper，只要按 group 构造 `requestOptions`。
- `resolveTableApiPresetOverride_ACU` 定义于 `src/service/table/update-orchestrator.ts:32`，当前 SQL 分支 `1228-1235` 已有一套按首张表解析 preset 的逻辑；这套逻辑应该被搬进统一的 groupedChunk 构造，而不是只服务于 legacy SQL 分支。
- 现有测试末尾 `tests/service/table/update-orchestrator.test.ts:1745-1773` 已覆盖 manual native 路径“走 grouped helper / grouped helper 失败时不落盘”两条用例，但没有 manual SQL 真实入口测试。
- 验收专家指出的阻断级问题与我们实际读到的代码完全一致，不是误报：当前 manual SQL 入口确实绕过了 grouped unified helper。

needs:
- 重写 `orchestrateManualUpdate_ACU` 的 chunk 内分支，使 SQL/native 都走同一条 groupedChunk → `processGroupedRuntimeChunk_ACU` 路径。
- 保留并显式透传每个 group 的 `requestOptions`，至少保留当前已有的 `tableApiPreset` 解析结果，消除 `requestOptions: null` 的信息丢失。
- 新增 manual SQL 真实入口测试，证明：
  1. SQL 模式下 `orchestrateManualUpdate_ACU` 成功路径会落盘；
  2. 不会调用 native parser `mockParseAndApplyTableEditsToData`；
  3. 不会再调用 legacy `processBatch` 回调。
- 保持 chunk 结束后的 `loadAllChatMessages_ACU` + `refreshData`，以及任一 chunk 失败后 `break` 的语义不变。

key_challenges:
- 不能只删除 SQL 分支了事。若统一到 grouped helper 时遗漏 group 级 `requestOptions`，会把当前 SQL 分支已有的 preset 透传能力悄悄弄丢，这种回归非常低级。
- `orchestrateManualUpdate_ACU` 的第二个参数 `processBatch` 是公开调用签名的一部分，虽然本次改造后在 grouped 路径中可能不再被使用，但不能改签名，否则会波及 `src/presentation-v2/composables/useManualUpdate.ts:328` 与 `src/presentation/triggers/update-process.ts:273`。
- 新测试必须验证“真实入口不再调用 legacy processBatch”，否则只是证明 SQL grouped helper 本身可用，并不能证明验收专家点名的入口缺陷已修。
- 需要避免因 `isSqliteMode` mock 状态污染让后续 native 用例再次变得不稳定。

confidence:
- HIGH
- 理由：阻断点、修改位置、helper 能力和测试插入点都已通过实际读文件确认，改动局部且调用链清晰；不存在需要推测的核心实现空白。

approach:
- 可维护性：9/10。把 manual SQL/native 入口统一到同一 helper 路径，减少双分支重复逻辑和后续行为漂移；保留既有公共签名，不扩大影响面。
- 健壮性：9/10。统一后 SQL 手动入口会复用已验证的 grouped unified apply/失败聚合逻辑，避免再次出现“某入口没接上新语义”的分叉事故。
- 可扩展性：8/10。后续若 group 级 `requestOptions` 增加新字段，统一从 groupedChunk 传递即可，不必分别维护 SQL/native 两套入口分支。

edge_cases:
- SQL 模式成功时，`processBatch` 必须完全不被调用；否则说明仍有 legacy 入口残留。
- SQL 模式失败时，`mockPersistTablesToChatMessage` 必须不落盘，且 `result.error` 仍保持 grouped helper 的失败反馈语义。
- 单 group 场景下 `requestOptions.tableApiPreset` 为空时，helper 内部自动回填逻辑仍应可工作；调用方传 `null` 或显式 preset 都不能破坏该行为。
- chunk 执行后必须仍然刷新聊天与数据；否则后续 chunk 基于陈旧状态继续执行会再次制造覆盖风险。
- SQL 用例结束后需要恢复 `isSqliteMode=false`，避免影响 native 用例。

affected_scope:
- src/service/table/update-orchestrator.ts
- tests/service/table/update-orchestrator.test.ts
- .analysis-cache.md
- .limcode/plans/修复多组并发填表快照覆盖与串行落盘计划.md

execution_plan:
1. 修改 `src/service/table/update-orchestrator.ts:1222-1293`，删除 SQL/native 双分支，统一按 `chunkKeys` 构造 `GroupedRuntimeUpdateGroup_ACU[]`。
2. 在 groupedChunk 构造时，为每个 group 复用当前 `1228-1235` 的首表 preset 解析逻辑，生成 `requestOptions` 并写入 group；随后统一调用 `processGroupedRuntimeChunk_ACU(groupedChunk, 'manual_independent')`。
3. 保持 `failedGroups` 聚合、chunk 后 `loadAllChatMessages_ACU()` + `refreshData()`、失败后 `break` 以及函数尾部失败恢复逻辑不变。
4. 在 `tests/service/table/update-orchestrator.test.ts:1773` 前新增 manual SQL 成功入口测试，断言 `result.success === true`、`mockPersistTablesToChatMessage` 调用一次、`mockParseAndApplyTableEditsToData` 未调用、传入的 legacy `processBatch` mock 未调用。
5. 视实现需要再补一条 manual SQL 失败入口测试；若成功测试已足以覆盖验收阻断点且失败语义已有 manual native + grouped SQL 失败测试共同覆盖，则不额外扩展无必要测试。
6. 运行定向测试：`tests/service/table/update-orchestrator.test.ts` 与 `tests/service/table/sql-table-service.test.ts`。
7. 运行 `npm run typecheck` 与 `npm run build`。
8. 追加 `.analysis-cache.md` 本轮记录，随后同步 plan/TODO，并调用验收专家复验；若复验不通过，继续整改直到通过。

degradation_check:
- 是否跳过 manual SQL 真实入口修复而只补测试：NO，先修入口，再用测试锁定。
- 是否保留双分支并继续复制逻辑：NO，统一走 grouped helper，减少再次漂移。
- 是否修改公共函数签名或扩大到 presentation 调用方：NO，保持 `orchestrateManualUpdate_ACU` 签名稳定。
- 是否为了省事忽略 `requestOptions` 透传：NO，统一构造 group 级 `requestOptions`，避免 preset 回归。
- 是否引入不必要新抽象/helper：NO，本次只在现有函数内重组逻辑。
- 是否遗漏失败刷新与 chunk 中断语义：NO，这些行为明确要求原样保留。
</analysis>
```

---

```markdown
<decision_point>
issue:
- 定向测试失败，且失败不是新加 manual SQL 用例本身，而是旧的 `orchestrateManualUpdate_ACU` 相关测试仍假设入口会调用 legacy `processBatch`。
- 验收专家复核确认：主代码入口修复方向正确，但测试集没有同步迁移到 grouped helper 真实调用链，导致 `tests/service/table/update-orchestrator.test.ts` 现有多处断言失真并阻断交付。

impact:
- 当前 `npm test -- tests/service/table/sql-table-service.test.ts tests/service/table/update-orchestrator.test.ts` 未通过，t6 不能验收通过。
- 若只保留现有实现而不修测试，后续任何人都无法区分“真实功能回归”与“测试预期过时”，测试集会持续失去可信度。
- 旧的表级 API 预设覆盖测试如果继续盯着 `mockProcessBatch.mock.calls`，将永久和新的 grouped helper 入口语义冲突。

context_update:
- 失败输出已明确指向 `tests/service/table/update-orchestrator.test.ts:1111/1131/1150/1171` 等位置，相关 describe 为 `orchestrateManualUpdate_ACU — 表级 API 预设覆盖`。
- 这些测试此前验证的是 `orchestrateManualUpdate_ACU` 调用 `processBatch` 时传入的 `requestOptions.tableApiPreset`；但现在入口已经统一到 `processGroupedRuntimeChunk_ACU`，`processBatch` 不再是事实来源。
- 验收专家额外指出：`manual native 路径走 grouped helper 而不是 legacy processBatch` 这条测试目前只断言成功与落盘，没有显式断言 legacy `processBatch` 未被调用，强度不足。
- 已确认主代码仍在 grouped helper 内通过 `requestOptions` 透传/补齐 `tableApiPreset`，所以测试应改为观察真实调用链上的 `callCustomOpenAI_ACU(..., requestOptions)` 或等价证据，而不是继续观察 legacy mock。

options:
  option_a:
    description:
    - 仅删除或跳过失败的旧测试，保留新实现和新增 SQL 入口测试，然后重新跑定向测试。
    approach_evaluation:
    - 可维护性：2/10。删除断言不能证明预设覆盖仍成立，只是把告警器拆掉。
    - 健壮性：1/10。会放过真实的 preset 透传回归，属于掩耳盗铃。
    - 可扩展性：3/10。短期能让测试变绿，长期会让 manual 入口的契约无人看守。
    edge_cases:
    - 表级 preset 丢失时不会再有测试报警。
    - native 与 SQL 路径行为分叉时难以及时发现。
    affected_scope_delta:
    - tests/service/table/update-orchestrator.test.ts
  option_b:
    description:
    - 迁移过时测试：把 `orchestrateManualUpdate_ACU — 表级 API 预设覆盖` 从检查 `processBatch` 参数，改为检查真实 grouped helper 链路中 `callCustomOpenAI_ACU` 的第三参；同时补强 native 入口测试，显式断言 legacy `processBatch` 未被调用。
    approach_evaluation:
    - 可维护性：9/10。测试观察点与真实实现语义一致，不再绑定已废弃的入口分支。
    - 健壮性：9/10。既能验证 preset 透传，也能验证 legacy `processBatch` 不再被调用。
    - 可扩展性：8/10。后续若 `requestOptions` 增加新字段，可在同一真实链路上继续断言。
    edge_cases:
    - 表名为空时不应透传 preset。
    - 表名标准化匹配成功时应透传 preset。
    - native 和 SQL 路径都应不再调用 legacy `processBatch`。
    - 失败路径仍应保留 grouped helper 错误语义与刷新行为。
    affected_scope_delta:
    - tests/service/table/update-orchestrator.test.ts
  option_c:
    description:
    - 回退主代码，让 `orchestrateManualUpdate_ACU` 对 native/SQL 重新调用 `processBatch`，以兼容旧测试和旧契约。
    approach_evaluation:
    - 可维护性：0/10。直接推翻刚修好的 t6 入口修复。
    - 健壮性：0/10。SQL/manual 会再次绕过 grouped unified helper，验收阻断原样复活。
    - 可扩展性：1/10。把错误路径重新合法化，只会制造下一轮事故。
    edge_cases:
    - SQL grouped commit 重新失效。
    - requestOptions 继续依赖 legacy 路径，和当前 helper 契约分叉。
    affected_scope_delta:
    - src/service/table/update-orchestrator.ts
    - tests/service/table/update-orchestrator.test.ts

recommendation:
- 选择 option_b。
- 理由：这是三者里唯一既修复测试失真、又不撤销入口修复、还能够真正锁住 `tableApiPreset` 透传契约的方案。option_a 是删证据，option_c 是回滚正确修复，只有低质量实现才会选。

execution_plan_update:
1. 读取 `tests/service/table/update-orchestrator.test.ts:1077-1177`，精确定位 4 条过时的 preset 覆盖测试及其当前 mock 结构。
2. 搜索并确认 `callCustomOpenAI_ACU` 在测试文件中的 mock 名称与参数断言方式，避免凭想象改断言。
3. 将 4 条 preset 覆盖测试改为：执行真实 `orchestrateManualUpdate_ACU` 后，检查 `mockCallCustomOpenAI.mock.calls[0][2]` 的 `tableApiPreset` 是否符合预期，而不是检查 `mockProcessBatch.mock.calls[0]`。
4. 补强 `manual native 路径走 grouped helper 而不是 legacy processBatch` 测试，显式保存 legacy mock 并断言 `not.toHaveBeenCalled()`。
5. 重新跑定向测试；若仍有失败，再按失败事实继续局部修正，不允许扩大到无关模块。
6. 测试全绿后，再跑 `npm run typecheck` 与 `npm run build`，然后再次调用验收专家复验。

deviation_audit:
- 当前没有改变 t6 目标，也没有回退实现；只是根据真实测试失败，把“补入口修复”扩展为“同步迁移过时测试到真实调用链”。
- 这属于验收整改的必要收口，不是额外需求膨胀。

degradation_check:
- 是否用删除测试代替修复测试语义：NO。
- 是否为了兼容旧测试回滚正确实现：NO。
- 是否扩大到无关生产代码：NO，仅修测试与已有入口测试强度。
- 是否跳过真实调用链验证继续靠 legacy mock：NO。
- 是否忽略验收专家指出的 native 测试强度不足：NO。
</decision_point>
```

---


```markdown
<execution_log>
phase: 执行与验收
started: 继续

steps:
  1. 在两个 beforeEach (L764-L779, L1096-L1126) 末尾插入 4 个 grouped helper mock
  2. 给两个 beforeEach 的 mockCurrentJsonTableData 补 content
  3. 发现根因：parseTableTemplateJson_ACU 模块级 mock 只返回 { mate, sheet_0: { name, updateConfig } }，无 content
  4. 在两个 beforeEach 中 override parseTableTemplateJson_ACU 返回值，补 content
  5. 8 failed → 3 failed（自动合并触发、表有覆盖预设 x2）
  6. 修复"自动合并触发"：mockProcessBatch.mockResolvedValue → mockCallCustomOpenAI.mockResolvedValue
  7. 修复预设覆盖：beforeEach 中 parseTableTemplateJson_ACU 的 sheet_0.name 从"纪要表"改为"测试表"
  8. npm test: 140 passed, 0 failed

fixes_applied:
  - tests/service/table/update-orchestrator.test.ts L778: insert 4 mocks (prepareAIInput, updateReadableLorebookEntry, persistTablesToChatMessage, parseAndApplyTableEditsToData)
  - tests/service/table/update-orchestrator.test.ts L1096: insert 4 mocks
  - tests/service/table/update-orchestrator.test.ts L770: mockCurrentJsonTableData +content
  - tests/service/table/update-orchestrator.test.ts L1116: mockCurrentJsonTableData +content
  - tests/service/table/update-orchestrator.test.ts L764-L771: insert parseTableTemplateJson_ACU override with content
  - tests/service/table/update-orchestrator.test.ts L1102-L1108: insert parseTableTemplateJson_ACU override with content
  - tests/service/table/update-orchestrator.test.ts L922: mockProcessBatch → mockCallCustomOpenAI
  - tests/service/table/update-orchestrator.test.ts L1107: sheet_0.name '纪要表' → '测试表'

remaining_risks:
  - typecheck 通过，build 通过（architecture guard 全绿）
  - L895-L914 "自动合并触发" 测试中 mockProcessBatch.mockResolvedValue 已是死代码但保留
</execution_log>
```
