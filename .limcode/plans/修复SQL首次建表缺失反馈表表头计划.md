## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 调整 applyUnifiedGroupFillResponses_ACU SQL 路径，使首次建表基底覆盖完整模板表与基础数据，再仅将 AI SQL edits 合并写入  `#sql-first-init-impl-apply`
- [x] 新增/调整 SQL 快照应用前的模板初始化基底构造，确保首次建表包含所有模板表表头、DDL 与模板基础数据  `#sql-first-init-impl-base`
- [x] 确认 SQL 首次建表、模板基底、模板基础数据、grouped unified apply、SyncBridge 建表链路与缺失反馈表根因  `#sql-first-init-recon`
- [x] 补充缺失反馈表首次建表、模板基础数据保留、仅部分表有 INSERT、非首次/原生路径不回归的单元测试  `#sql-first-init-tests`
- [x] 运行定向 SQL/table 测试、typecheck/build 或说明已知 tsconfig 诊断影响  `#sql-first-init-verify`
<!-- LIMCODE_TODO_LIST_END -->

# 修复 SQL 首次建表缺失反馈表表头与模板基础数据计划

## 1. 计划来源

来源：助手直接需求与补充要求：

1. “第一次填表时，如果部分表没有反馈数据（AI 认为不需要更新），会导致 SQL 建表时拿不到表头而建表失败；第一次需要建表直接用表格模板进行建表，建表完成后再将填表的数据合并写入。”
2. 补充要求：“如果模板有基础数据，建表时还需要带上这些基础数据。”

当前仍处于 Plan Mode。这里只修订计划，不进入实现。助手这个补充很关键：上一版计划里“不要带 seed rows”的判断过于保守，只适合防止示例数据误入；但当前产品语义明确把模板基础数据视作首次建表初始数据。继续坚持空表初始化就是理解偏了，典型的局部防污染、防到把合法数据也删掉。

## 2. 已验证现状与证据

### 2.1 SQL grouped 提交入口

`src/service/table/update-orchestrator.ts`：
- `processGroupedRuntimeChunk_ACU` 在 L590-L601 构造 `mergedBatchData`：先 `buildBatchMergeBase_ACU(batchNumber)`，再 `loadBatchBaseData_ACU(...)`，最后 `_set_currentJsonTableData_ACU(mergedBatchData)`。
- `applyUnifiedGroupFillResponses_ACU` 在 L477-L489 遍历 AI responses；SQL 模式下调用 `applySqlEditsToTableDataSnapshot_ACU(response.tableEditText, workingTableData, options.updateMode)`。
- L459-L470 会收集所有 response 的 `job.targetSheetKeys` 到 `allTargetSheetKeySet`，但当前 SQL 应用实际只基于 `responses` 中存在的表去执行 SQL edits。没有 AI response 的表不会进入 `responses`，这就是“AI 认为无需更新”的断点。

### 2.2 SQL 快照应用会先从 JSON 快照建 SQLite 表

`src/service/table/sql-table-service.ts`：
- `applySqlEditsToTableDataSnapshot_ACU` L545-L548：复制 `tableData` 后 `syncBridge.loadFromTableData(snapshotCopy)`，再执行 SQL statements。
- 所以 SQL 快照应用前，会把当前快照中的所有 `sheet_*` 先建进 SQLite。

`src/data/sqlite/sync-bridge.ts`：
- `loadFromTableData` L49-L58 遍历 `data` 中所有 `sheet_*` 并 `_loadSheet`。
- `_loadSheet` L117-L145：`generateDDL(sheet)` → `parseDDLTableName` → `engine.run(ddl)` → `generateInserts(sheet, tableName)`。
- `generateInserts` 会把 `content[1:]` 数据行灌入 SQLite。因此模板基础数据只要存在于首次建表基底的 `content` 中，就会随建表进入 SQLite。

`src/data/sqlite/schema-mapper.ts`：
- `generateDDL` L45-L63：优先用 `sheet.sourceData.ddl`；没有 DDL 时 fallback 到 `sheet.content?.[0]` 表头；如果表头也没有，退化成只有 `row_id` 的表。
- 这解释了用户报告的“拿不到表头导致建表失败/后续写入失败”：缺失反馈表没有被完整模板基底带入时，SQLite 没有正确 schema。

### 2.3 现有模板/seedRows 机制已经证明基础数据是合法初始化来源

`src/service/table/sql-table-service.ts`：
- `_ensureTablesFromTemplate` L443-L462 已经在缺失表建表时构造 `partialData` 并调用 `this.syncBridge.loadFromTableData(partialData)`。
- L450-L457：如果 sheet content 只有表头，会调用 `getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true })` 并把 seed rows 拼到表头后面。
- 注释 L444-L445 明确写着：`seedRows 是初版快照，应写入 SQLite 作为真实数据`。

这条证据非常硬：SQL 服务层已有设计把模板基础数据/seedRows 作为首次建表真实数据。上一版计划把 seed rows 一律排除，和这条现有设计冲突。现在必须修正。

### 2.4 现有测试缺口

`tests/service/table/update-orchestrator.test.ts` 已有：
- L1381-L1408：SQL 模式 unified apply 两张表都有 response 时成功。
- L1598-L1621：SQL 模式 `processGroupedRuntimeChunk_ACU` 两个 group 都有 AI SQL response 时成功。
- L1822-L1848：manual SQL 入口走 grouped helper，单表成功。

缺口：没有覆盖“模板含两张表且含基础数据，AI 只返回其中一张表 SQL，另一张表无反馈仍应随首次建表保存表头、DDL、基础数据”。漏洞明显得像是故意排给事故看的。

## 3. 根因判断

根因不是 SQL parser，而是 **SQL 首次初始化语义与 AI response 驱动的 modifiedKeys/save 范围耦合过紧**：

1. 首次填表时，系统应先按模板/guide 建出完整 schema。
2. 如果模板存在基础数据，这些基础数据也是首次 SQLite 初版快照的一部分。
3. 当前 unified apply 的“实质修改”只来自有 AI response 的 group。
4. AI 对某些表无反馈时，这些表不会进入 response，也不会进入 `modifiedKeys`。
5. 后续保存/追踪/再次加载时，缺失反馈表可能没有完整表头、DDL、基础数据快照，导致 SQL 建表或写入结构不完整。

换句话说：AI 没说要更新某张表，不等于这张表在首次 SQLite 初始化时不存在，也不等于模板基础数据可以丢。

## 4. 目标边界

### 必须做到

- SQL 模式首次建表时，使用模板/guide 的完整 `sheet_*` 结构建表。
- 建表基底必须包含每张模板表的 `sourceData.ddl` 和 `content[0]`。
- 如果模板/guide 有基础数据或有效 seedRows，首次建表必须带上这些基础数据。
- AI 只返回部分表 edits 时，只执行这些 edits；无反馈表保持模板初始状态，包括表头、DDL、基础数据。
- 持久化时首次初始化必须把完整结构和基础数据保存/跟踪，避免下一次 SQL 建表拿不到表头或基础数据丢失。
- 原生模式不受影响。
- 非首次已有数据场景不应把模板基础数据重新覆盖已有运行数据。

### 不做

- 不修改 SQL 语法生成规则。
- 不改 AI 提示词强迫 AI 对所有表返回空操作。
- 不把模板基础数据每次重复灌入已有表。
- 不扩大到 extension 发布链路。
- 不清理旧 spv3.9.6 TODO/dirty 文件，除非助手另行确认。

## 5. 推荐实现方案

### 5.1 新增 SQL 首次建表初始化基底 helper

在 `src/service/table/update-orchestrator.ts` 增加内部 helper，例如：

- `buildSqlInitialTableDataBase_ACU(baseSnapshot, targetSheetKeys?)`

职责：
1. 仅在 `isSqliteMode()` 的 unified apply 路径使用。
2. 优先从当前 chat sheet guide 获取结构与基础数据；没有 guide 时从模板读取。
3. 读取模板时需要区分两类用途：
   - 结构：必须有 DDL 与表头。
   - 基础数据：如果模板存在 seed rows/基础数据，首次建表必须带上。
4. 合并到 `baseSnapshot`：
   - 已有运行数据的 sheet 不覆盖数据行。
   - 缺失 sheet 或结构不完整 sheet：用模板 sheet 补齐，包括 `sourceData`、`content[0]`、基础数据、`uid/name/updateConfig/exportConfig/orderNo`。
   - 已有 sheet 只有表头但模板有基础数据，且判断为首次/缺失初始化时，可以补入基础数据。
   - 保留 `mate`。
5. 返回：
   - `tableDataBase`：用于 `applySqlEditsToTableDataSnapshot_ACU` 的完整首次初始化基底。
   - `addedOrInitializedSheetKeys`：这次因初始化需要纳入保存的 sheet。
   - `schemaAndSeedSheetKeys`：模板完整表集合，用于首次保存 tracking。

### 5.2 基础数据来源策略

实现时必须对“基础数据”来源有明确优先级：

1. chat sheet guide 中已保存的基础数据/seedRows。
2. 当前聊天模板快照或链接预设中的基础数据。
3. 全局模板 fallback。
4. `getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true })` 作为兜底补齐。

注意：如果模板基础数据已经通过 `stripSeedRowsFromTemplate_ACU` 被移除，那么 helper 不能只依赖 `parseTableTemplateJson_ACU({ stripSeedRows: true })`。需要在首次初始化场景额外读取未 strip 的模板，或复用 `getEffectiveSeedRowsForSheet_ACU` 补回基础数据。

### 5.3 调整 `applyUnifiedGroupFillResponses_ACU`

在 L474 创建 `workingTableData` 前判断：

- 若 `isSqliteMode()`：
  - 调用 helper 扩展 `baseSnapshot` 为完整首次初始化基底。
  - `workingTableData` 从扩展后的基底开始。
- 非 SQL 模式：保持现状。

在保存参数 L528-L536：

- SQL 模式且 helper 实际初始化/补齐了表时，`targetSheetKeys` 不能只用 `modifiedKeys`。
- 应保存：`modifiedKeys ∪ addedOrInitializedSheetKeys`。
- `trackingSheetKeys` 应至少包含：`allTargetSheetKeys ∪ addedOrInitializedSheetKeys`。
- 如果首次初始化需要把所有模板表连同基础数据写入聊天记录，则 `addedOrInitializedSheetKeys` 应包含完整模板表，而不是只包含有 AI edits 的表。

关键控制：非首次场景不要把模板基础数据重新塞回已有数据。判断应以“sheet 缺失/结构不完整/首次初始化基底为空”为准，而不是每次 SQL apply 都全量套模板。

### 5.4 避免假修复

不要让 `collectGroupFillResponse_ACU` 给无反馈表伪造 `<tableEdit></tableEdit>`。当前 L509-L510 对“无实质操作”会失败，这是正确质量闸。修复点应在首次 SQL 初始化基底，而不是在 AI response 层造假。

## 6. 测试计划

### 6.1 单元测试：unified SQL apply 首次缺失反馈表但保留模板基础数据

在 `tests/service/table/update-orchestrator.test.ts` 的 `applyUnifiedGroupFillResponses_ACU` describe 中新增测试：

场景：
- `isSqliteMode = true`。
- 模板/guide 有 `sheet_0 inventory` 与 `sheet_1 quest_log`，均有 DDL、表头和基础数据。
- `responses` 只有 `sheet_0` 的 INSERT。

断言：
- result success。
- 保存被调用一次。
- savedData.sheet_0 包含模板基础数据和 AI 插入数据。
- savedData.sheet_1 存在，保留 `content[0]`、`sourceData.ddl`、模板基础数据，无 AI 新增行。
- `targetSheetKeys` 包含 `sheet_0` 与 `sheet_1`。
- `mockParseAndApplyTableEditsToData` 未被调用。

### 6.2 单元测试：模板无基础数据时仍保存表头空表

场景同上，但模板只有表头。

断言：
- 无反馈表保存为 `[header]`，不会失败。
- 有反馈表正常合并 AI SQL。

### 6.3 单元测试：非首次不重复灌基础数据

场景：
- `baseSnapshot.sheet_1` 已有运行数据。
- 模板也有基础数据。
- responses 只改 `sheet_0`。

断言：
- savedData.sheet_1 不被模板基础数据覆盖或重复追加。
- `targetSheetKeys` 不因无实际初始化而无脑包含所有模板表。

### 6.4 回归测试

- 现有 L1381-L1408 两表都有 SQL response 必须继续通过。
- 现有 L1410-L1428 SQL 错误时不保存必须继续通过。
- 原生模式 apply tests 不应改变。
- `tests/service/table/sql-table-service.test.ts` 建表模板来源优先级与 seedRows 写入 SQLite 测试不应受影响。

## 7. 验证命令

优先定向验证：

1. `npx vitest run tests/service/table/update-orchestrator.test.ts`
2. `npx vitest run tests/service/table/sql-table-service.test.ts tests/integration/sqlite-full-chain.test.ts`
3. `npm run typecheck`
4. `npm run build:nocheck`

注意当前动态诊断已有 `tsconfig.json:19 baseUrl` 弃用提示。若 typecheck 因该已知诊断失败，需要记录为环境诊断，不要把它和本次 SQL 修复混为一谈。

## 8. 风险与控制

### 风险 1：基础数据重复灌入

控制：只在 sheet 缺失、结构不完整、或首次初始化时注入模板基础数据。已有运行数据的 sheet 不追加模板基础数据。

### 风险 2：全模板保存污染非首次增量

控制：只有 helper 实际初始化/补齐的 sheet 才加入保存集合。不要每次 SQL apply 都保存全模板。

### 风险 3：模板覆盖已有数据

控制：合并规则必须“补结构和首次基础数据，不覆盖已有运行数据”。已有 `content[1:]` 时保持运行数据优先。

### 风险 4：基础数据与 AI SQL 主键冲突

如果模板基础数据已有 `row_id=1`，AI 又插入 `row_id=1`，SQLite 会按现有约束报错。这是合理失败，不能吞。测试应覆盖至少不因为无反馈表失败；主键冲突另作为 SQL 错误返回。

### 风险 5：targetSheetKeys 越权检查误杀

schema/base-data 初始化 sheet 不应作为某个 response 的 parsedKeys；它只进入保存 keys。不要把 schema-only 表塞进 parsedKeys，否则会触发 L512-L521 越权检查。

## 9. 回滚方式

- 回滚 helper 与 `applyUnifiedGroupFillResponses_ACU` 保存集合调整。
- 删除新增测试。
- 不涉及数据迁移和发布脚本，回滚范围可控。

## 10. 实施顺序

1. 在 `update-orchestrator.ts` 增加首次 SQL 初始化基底 helper。
2. helper 内实现模板结构与基础数据读取/合并策略，优先不覆盖已有运行数据。
3. 在 `applyUnifiedGroupFillResponses_ACU` SQL 路径接入 helper，先建完整初始化基底，再执行 AI SQL edits。
4. 调整保存 keys：`modifiedKeys ∪ addedOrInitializedSheetKeys`。
5. 增加“无反馈表保留表头+基础数据”的 apply 层测试。
6. 增加“模板无基础数据时保存表头空表”和“非首次不重复灌基础数据”测试。
7. 跑定向测试，再跑相关 SQL 集成测试。
8. 若全绿，再进入实现验收；若失败，按失败事实局部修正，不扩大重构。

## 11. 自我复查

这版计划比上一版正确：它不再把模板基础数据误判成污染源，而是按现有 SQL 服务层设计，把基础数据视为首次 SQLite 初版快照。上一版如果直接执行，会修好表头却丢掉模板初始数据，属于半修半坏，质量只能算勉强及格以下。

仍需实现时确认的细节：如何准确区分“模板示例行”和“产品语义上的基础数据”。当前助手已明确“模板有基础数据就要带上”，因此默认模板 `content[1:]` / seedRows 都按基础数据处理。若未来需要区分示例数据与初始化数据，应单独设计字段，而不是在本次修复里靠猜。
