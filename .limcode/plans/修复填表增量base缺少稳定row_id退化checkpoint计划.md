## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [x] 设计公共 row_id 稳定化 helper：只补缺失/空值/重复冲突，不重写已有稳定 row_id  `#rowid-helper-design`
- [x] 在 persistTablesToChatMessage_ACU 落盘前对目标 sheet 快照执行 row_id 稳定化，保证 base/checkpoint 后续可 delta  `#rowid-persist-impl`
- [x] 确认 row_id 缺失日志来源、base/checkpoint/SQL DB 数据流与现有测试覆盖  `#rowid-recon-confirm`
- [x] 在模板 seedRows / Sheet Guide 物化与 getEffectiveSeedRowsForSheet_ACU 返回路径接入 row_id 稳定化  `#rowid-seed-guide-impl`
- [x] 在 SQL 首次初始化与按需建表路径确保 seedRows 写入 SQLite 前具备稳定 row_id  `#rowid-sql-init-impl`
- [x] 补充 seedRows、SQL 初始化、持久化 delta/checkpoint 回归测试，覆盖旧模板 row_id 缺失场景  `#rowid-tests`
- [x] 运行定向测试与构建验证，确认不再触发 base_no_stable_row_id 且不破坏主键冲突语义  `#rowid-verify`
<!-- LIMCODE_TODO_LIST_END -->

# 修复填表增量 base 缺少稳定 row_id 退化 checkpoint 计划

## 0. 计划来源

- 来源：助手直接需求。
- 用户目标：每次填表不再出现 `index.js:1667 [shujuku_v120] [表格增量] sheet_SystemRules: base 缺少稳定 row_id，退化为 checkpoint`；行为上要“跟建表时一样，始终用当前表格模板来充当 row_id 这些数值，写入 base、checkpoint、以及 SQL 数据库本身”。
- 当前模式：Plan Mode。只制定可执行计划，不直接修改代码。

## 1. 已确认事实

### 1.1 日志来源

- 文件：`src/service/table/table-delta.ts`
- 函数：`buildTableDelta_ACU`
- 行为：
  - `hasStableRowIds_ACU(baseContent)` 返回 false 时输出：`[表格增量] ${sheetKey}: base 缺少稳定 row_id，退化为 checkpoint`
  - `hasStableRowIds_ACU(nextContent)` 返回 false 时输出：`next 缺少稳定 row_id，退化为 checkpoint`
- 稳定 row_id 判定：`content[i][0]` 必须非 null、非空字符串、不可重复；空行也判失败。

### 1.2 退化触发数据流

- `src/service/table/table-service.ts:215-251` 中，保存到目标楼层时：
  - `baseSheet = prevTagData.independentData[sheetKey]`
  - `nextSheet = independentData[sheetKey]`
  - 调用 `buildTableDelta_ACU(baseSheet, nextSheet, sheetKey)`
  - 任意 sheet 退化会导致当前楼层整体 `_acu_storage_mode = 'checkpoint'`
- 因此用户看到的 `base 缺少稳定 row_id` 不是当前这次 AI 输出本身，而是上一楼层落盘后的 `independentData` 已经带着不稳定 row_id。

### 1.3 模板 / seedRows / SQL 初始化链路

- `src/service/template/chat-scope/chat-scope-guide.ts:447-471` 的 `getEffectiveSeedRowsForSheet_ACU` 会从以下来源返回 seedRows：
  1. `currentJsonTableData_ACU[sheetKey].seedRows`
  2. 当前 guideData 的 `seedRows`
  3. 任意历史 guide 的 `seedRows`
  4. 模板 `content.slice(1)` fallback
- 当前返回逻辑只是深拷贝，不修正 `row[0]`。
- `src/service/table/update-orchestrator.ts:434-536` 的 `buildSqlInitializationBase_ACU` 在 SQL 模式首次初始化时会把 seedRows 拼入 `targetSheet.content`。
- `src/service/table/sql-table-service.ts:443-462` 的按需建表路径也会把 seedRows 拼入 `sheetCopy.content`，再经 `SyncBridge.loadFromTableData` 写入 SQLite。
- `src/data/sqlite/schema-mapper.ts:122-164` 的 `generateInserts` 按当前 `content` 原样生成 INSERT，不修正 row_id。

### 1.4 当前测试位置

- `tests/service/table/table-delta.test.ts`：已有稳定 row_id 与退化分支测试，必须保留退化语义。
- `tests/service/template/chat-scope-guide.test.ts`：已有 `getEffectiveSeedRowsForSheet_ACU` 返回 seedRows 的测试，可新增“缺失 row_id 自动补齐”。
- `tests/service/table/table-service.test.ts`：已有 `persistTablesToChatMessage_ACU` 保存路径 mock，可新增落盘前 row_id 稳定化回归。
- `tests/service/table/update-orchestrator.test.ts`：已有 SQL 首次建表、seedRows 保留、主键冲突测试，可新增 row_id 缺失 seedRows 的 SQL 初始化测试。
- `tests/service/table/sql-table-service.test.ts`：可覆盖按需建表 seedRows 写入 SQLite 前 row_id 稳定化。

## 2. 根因判断

当前系统把 `row_id` 作为 delta 存储的行级主键，但模板 seedRows / guide seedRows / 落盘快照并没有统一保证 `content[i][0]` 稳定。结果是：

1. 首次建表或模板 seedRows 注入时可能带入 `null` / `''` / 重复 row_id。
2. SQLite 路径会把这些值写入 SQL DB 或由 SQLite 自动生成，但 JSON base/checkpoint 未必同步成稳定 row_id。
3. 下一次保存时，`prevTagData.independentData` 作为 base 被 `buildTableDelta_ACU` 检查，触发 `base_no_stable_row_id`。
4. 系统退化 checkpoint，用户每次填表都看到警告。

这不是日志级问题，是模板基础数据进入运行态之前缺少 row_id 稳定化协议。把警告关掉只会隐藏增量存储失效，蠢得很干净。

## 3. 实施目标

必须同时满足：

1. 模板 seedRows / guide seedRows 进入运行态时具备稳定 row_id。
2. SQL 首次建表 / 按需建表写入 SQLite 前具备稳定 row_id。
3. `persistTablesToChatMessage_ACU` 写入 checkpoint/base 前具备稳定 row_id，避免旧链路或非 SQL 路径继续污染下一轮 base。
4. 不破坏已有稳定 row_id。
5. 不吞掉真正的结构变化、旧数据严重冲突、AI 主键冲突错误。
6. 不改变 `buildTableDelta_ACU` 的安全退化判定职责。

## 4. 非目标

- 不删除或降级 `table-delta.ts` 的警告。
- 不让 `buildTableDelta_ACU` 在发现不稳定 row_id 时自动猜测修复；它应继续保持纯判定/构建 delta 的职责。
- 不修改 `manifest.json` / `package.json` 版本号。
- 不发布 tag、不打包、不推送。
- 不对 `.limcode/*`、`.analysis-archive/*`、`vitest-out.txt` 做 housekeeping commit。
- 不处理 `tsconfig.json:19 baseUrl` 弃用诊断。

## 5. 推荐设计

### 5.1 新增公共 row_id 稳定化 helper

建议放置位置：`src/service/template/chat-scope/chat-scope-guide.ts` 或更低层的 `src/shared/utils.ts`。

更稳的选择：新增到 `src/service/template/chat-scope/chat-scope-guide.ts` 并从 `src/service/template/chat-scope/index.ts` 导出。

原因：
- 当前直接消费 seedRows 的核心入口都已经依赖 `../template/chat-scope`。
- 避免把模板运行态业务规则塞进过于宽泛的 `shared/utils.ts`。
- 不引入 `table-service.ts` 与 `chat-scope` 之间的新循环，因为 `table-service.ts` 已经从 `../template/chat-scope` 导入多个函数。

建议函数：

- `normalizeSeedRowsRowIds_ACU(seedRows, options?)`
- `normalizeSheetContentRowIds_ACU(content, options?)`
- 或统一为 `ensureStableRowIdsForContent_ACU(content, options?)`

语义要求：

1. 输入 `content` 时，第一行是表头，数据行从 index 1 开始。
2. 输入 seedRows 时，不含表头，数据行从 index 0 开始。
3. 只补：`null`、`undefined`、`''`、空行第一列缺失。
4. 对重复 row_id：不重写第一个稳定值；仅修正后续重复项为新的唯一值。
5. 新 row_id 生成规则：
   - 优先使用当前行的自然序号字符串：`String(dataIndex + 1)`。
   - 若已被占用，递增寻找下一个未占用数字字符串。
6. 不重写已有稳定非空唯一 row_id，例如 `'r1'`、`'SystemRules'`、`'9'`。
7. 不修改原对象，返回深拷贝。

### 5.2 接入点 A：seedRows 返回路径

修改：`src/service/template/chat-scope/chat-scope-guide.ts:getEffectiveSeedRowsForSheet_ACU`

所有返回 seedRows 的分支统一走 `normalizeSeedRowsRowIds_ACU`：

- direct seedRows
- guideData seedRows
- historical seedRows
- template fallback `tplRows.slice(1)`

收益：
- prompt 构造、parser fallback、SQL 初始化、按需建表等所有 seedRows 消费者统一受益。

风险：
- 如果某些测试期待原样返回 `[[null, 'x']]`，需要调整为新契约。但当前读取到的测试只验证已有稳定 `[['1', ...]]`，不会冲突。

### 5.3 接入点 B：Sheet Guide 物化路径

修改：`materializeDataFromSheetGuide_ACU`

当 `includeSeedRows = true` 时，拼接 `headerRow + seedRows` 前先规范化 seedRows。

原因：
- 不是所有物化路径都经过 `getEffectiveSeedRowsForSheet_ACU`。
- `materializeDataFromSheetGuide_ACU` 被 `worldbook/pipeline.ts`、`runtime/helpers-data-merge.ts`、可视化保存等路径消费。

### 5.4 接入点 C：SQL 初始化 / 按需建表路径

修改：
- `src/service/table/update-orchestrator.ts:buildSqlInitializationBase_ACU`
- `src/service/table/sql-table-service.ts:_ensureTablesFromTemplate`

即使 `getEffectiveSeedRowsForSheet_ACU` 已规范化，也建议在拼入 `content` 后对整张 sheet content 再执行 `ensureStableRowIdsForContent_ACU`。

原因：
- 防止 source sheet / guided sheet / existing sheet 本身已有不稳定 content。
- 保证写入 SQLite 前 JSON snapshot 与 SQL DB 都使用同一套稳定 row_id。

注意：
- 对 `INTEGER PRIMARY KEY` 表，模板 row_id 缺失时补 `1/2/3` 会显式写入 SQLite；这符合“用当前表格模板充当 row_id 数值”的用户要求。
- 已有 SQL 主键冲突测试必须继续失败，不能为了“自动稳定化”把已有 `1` 改掉。

### 5.5 接入点 D：持久化落盘前兜底

修改：`src/service/table/table-service.ts:203-207`

当前代码：保存目标 sheet 时直接：

`independentData[sheetKey] = sanitizeSheetForStorage_ACU(JSON.parse(JSON.stringify(table)));`

计划改为：

1. 深拷贝 table。
2. 对 sheet content 执行 row_id 稳定化。
3. 再 sanitize。
4. 写入 independentData。

原因：
- 这是 base/checkpoint 的最终出口。
- 即使上游某条路径漏了，落盘前也能保证下一轮 base 不再缺 row_id。
- 这能覆盖原生 DSL、SQL、手动填表、旧聊天数据继续保存等路径。

风险控制：
- 不修改 `buildTableDelta_ACU`，它仍然能在真正不可安全 delta 的情况下退化。
- 只对本次保存的目标 sheet 做规范化，不批量迁移所有历史楼层，避免大规模历史数据重写。

## 6. 实施步骤

### Step 1：新增 row_id 稳定化工具

文件：`src/service/template/chat-scope/chat-scope-guide.ts`

新增 helper：

- `ensureStableRowIdsForSeedRows_ACU(seedRows)`
- `ensureStableRowIdsForSheetContent_ACU(content)`

或一个内部核心函数 + 两个薄封装。

验收标准：
- 输入 `[[null,'a'],['','b'],['2','c'],['2','d']]` 返回 `[['1','a'],['3','b'],['2','c'],['4','d']]` 或等价唯一稳定序列。
- 已稳定输入 `[['r1','a'],['r2','b']]` 原样返回值等价，但不是同一引用。

### Step 2：接入 `getEffectiveSeedRowsForSheet_ACU`

文件：`src/service/template/chat-scope/chat-scope-guide.ts`

修改所有 seedRows 返回分支，保证返回前 normalize。

验收标准：
- direct / guide / historical / template fallback 四类 seedRows 都不返回空 row_id 或重复 row_id。
- `allowTemplateFallback=false` 仍返回 `[]`，不额外读取模板。

### Step 3：接入 `materializeDataFromSheetGuide_ACU`

文件：`src/service/template/chat-scope/chat-scope-guide.ts`

当 `includeSeedRows=true` 时，seedRows 拼入 content 前 normalize。

验收标准：
- 物化后的 `content[1..]` 具备稳定 row_id。
- `includeSeedRows=false` 仍只返回表头，不引入 seedRows。

### Step 4：导出 helper

文件：`src/service/template/chat-scope/index.ts`

从 `chat-scope-guide.ts` 导出新增 helper，供 `table-service.ts`、`update-orchestrator.ts`、`sql-table-service.ts` 使用。

验收标准：
- 无循环依赖新增。
- 现有导出不破坏。

### Step 5：SQL 初始化路径兜底

文件：`src/service/table/update-orchestrator.ts`

在 `buildSqlInitializationBase_ACU` 拼 seedRows 后，对 `targetSheet.content` 执行 `ensureStableRowIdsForSheetContent_ACU`。

验收标准：
- 缺失表首次初始化时，模板基础数据 row_id 缺失也会变成稳定值。
- 已有运行数据的表不重复灌 seedRows，也不重写稳定 row_id。
- 主键冲突用例仍失败且不保存。

### Step 6：SQL 按需建表路径兜底

文件：`src/service/table/sql-table-service.ts`

在 `_ensureTablesFromTemplate` 构造 `partialData` 时，对 `sheetCopy.content` 执行稳定化后再 `syncBridge.loadFromTableData(partialData)`。

验收标准：
- 写入 SQLite 的 seedRows row_id 非空唯一。
- `generateInserts` 不需要承担 row_id 修复职责。

### Step 7：持久化落盘前兜底

文件：`src/service/table/table-service.ts`

在 `keysToSave.forEach` 内，sanitize 之前对目标 sheet content 做稳定化。

验收标准：
- checkpoint 的 `independentData[sheetKey].content` 稳定。
- 下一次保存时不会因上一楼层 base row_id 缺失触发 `base_no_stable_row_id`。
- 已稳定 row_id 不被改写。

## 7. 测试计划

### 7.1 单元测试：seedRows 规范化

文件：`tests/service/template/chat-scope-guide.test.ts`

新增用例：

1. direct `_seedRows` 中 row_id 为 `null` / `''` 时自动补 `1` / `2`。
2. guideData seedRows 中重复 row_id 时只修正后续重复项。
3. template fallback `content.slice(1)` 中缺失 row_id 时返回稳定 seedRows。
4. 已稳定 row_id 不被重写。

### 7.2 单元测试：持久化落盘

文件：`tests/service/table/table-service.test.ts`

新增用例：

1. 显式 `tableData` 中目标 sheet content 为 `[['row_id','A'], [null,'a'], ['', 'b']]`。
2. 调用 `persistTablesToChatMessage_ACU({ tableData })`。
3. 断言 `writeIsolatedTagData` 写入的 `independentData.sheet_0.content` 变为稳定 row_id。
4. 再模拟上一楼层为稳定 checkpoint、下一楼层修改数据，断言可进入 delta，不再 checkpoint。

### 7.3 SQL unified apply 回归

文件：`tests/service/table/update-orchestrator.test.ts`

新增/调整：

1. SQL 模式下，`getEffectiveSeedRowsForSheet_ACU` mock 返回 `[[null, 'tpl-a'], ['', 'tpl-b']]`。
2. 断言保存 payload 中对应 sheet content row_id 变为稳定数字。
3. 断言 `applySqlEditsToTableDataSnapshot_ACU` 结果也包含稳定 row_id。
4. 保留“模板基础数据与 AI INSERT 主键冲突时返回真实 SQL 错误且不保存”测试，确保不会重写已有稳定 `1` 来掩盖冲突。

### 7.4 SQL table service 回归

文件：`tests/service/table/sql-table-service.test.ts`

新增：按需建表时 seedRows 缺 row_id，最终 SQLite 导出的 content 具备稳定 row_id。

### 7.5 table-delta 不改语义测试

文件：`tests/service/table/table-delta.test.ts`

保留现有：
- `base 缺少稳定 row_id 时退化`
- `next 缺少稳定 row_id 时退化`
- `row_id 重复时退化`

不要把这些测试改成通过。`buildTableDelta_ACU` 的安全判定必须继续存在。

## 8. 验证命令

优先执行：

1. `npx vitest run tests/service/template/chat-scope-guide.test.ts`
2. `npx vitest run tests/service/table/table-service.test.ts`
3. `npx vitest run tests/service/table/update-orchestrator.test.ts`
4. `npx vitest run tests/service/table/sql-table-service.test.ts tests/integration/sqlite-full-chain.test.ts`
5. `npm run build`

注意：当前已知诊断 `tsconfig.json:19 baseUrl` 弃用不属于本任务阻断；若 build exit code 0，则记录为已知噪音，不在本任务处理。

## 9. 风险与回滚

### 9.1 风险：改变用户已有 row_id

缓解：只补缺失/空值/后续重复项，不改写已有唯一稳定 row_id。

### 9.2 风险：掩盖 SQL 主键冲突

缓解：已有稳定 row_id 不重写；AI INSERT 与模板 seedRows 同主键时仍应由 SQLite 抛出 unique/primary constraint 错误。

### 9.3 风险：旧历史楼层仍有不稳定 row_id

缓解：本计划只在新保存目标 sheet 落盘时稳定化，不批量迁移历史楼层。若旧楼层作为 base 仍有问题，第一次保存会 checkpoint，但写出的新 checkpoint 应稳定，后续不再重复退化。

### 9.4 风险：跨模块 helper 导出引入循环依赖

缓解：新增 helper 放在已被聚合导出的 `chat-scope-guide.ts`，由 `index.ts` 导出；改动后跑定向测试与 build。

### 9.5 回滚策略

若测试或运行异常：

1. 回滚新增 helper 与三处接入点。
2. 保留测试作为待修复用例或同时回滚测试。
3. 不修改已发布 tag，不触碰 dist/index.bundle.js / index.js，除非后续明确进入发布流程。

## 10. 自我复查

这份计划能执行，但必须强调：真正的关键不是“补一个 row_id 函数”，而是保证所有进入 base/checkpoint/SQL DB 的模板基础数据走同一稳定化协议。只改 `buildSqlInitializationBase_ACU` 会漏掉非 SQL 路径；只改 `table-service.ts` 又会让 SQL DB 写入前仍可能使用不稳定 row_id。三层接入看起来多，但各自职责不同：seedRows 源头、SQL 写入前、持久化出口。少一层都会给以后继续埋雷。
