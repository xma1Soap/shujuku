<analysis>
context: 
  table-edit-parser.ts 中有两处被之前错误修改后没有还原干净的代码：
  1. insertRow 的 headers.forEach 内部：data[colIndex + 1] 应该是 data[colIndex]，因为 headers 已经是 table.content[0].slice(1)（去掉了 row_id），colIndex 从 0 开始就是第一个属性列，AI 返回的 data 对象的 key 也是从 0 开始的
  2. updateRow 的 Object.keys(data).forEach 内部：table.content[rowIndex + 1][colIndex] 应该是 table.content[rowIndex + 1][colIndex + 1]，因为 content 数组的第 0 列是 row_id，AI 返回的 colIndex 0 对应 content 位置 1
  
  prompt-prepare.ts 中列索引显示 `[${i}:${h}]` 其中 i 从 0 开始——这是冈部之前要求的改动（提示词层面列从 0 开始显示），这个是正确的。

needs: 还原 table-edit-parser.ts 中两处解析逻辑到原始正确状态，删除错误的注释

key_challenges: 无特别难点，就是精确还原两处代码

confidence: HIGH — 问题明确，原始逻辑清晰

approach: 直接修复两处代码，删除错误注释
  - 可维护性: 5/5 — 还原到原始正确逻辑
  - 健壮性: 5/5 — 修复后 insertRow 和 updateRow 的列映射恢复正确
  - 可扩展性: 5/5 — 不涉及架构变更

edge_cases: 无新增边界条件

affected_scope: 
  - src/service/ai/prompt-builder/table-edit-parser.ts

execution_plan:
  - step_1: 修复 insertRow 中的 data[colIndex + 1] → data[colIndex]，删除错误注释
  - step_2: 修复 updateRow 中的 colIndex → colIndex + 1，删除错误注释

degradation_check:
  - 方案是否是三维评估综合最优的？ → YES，直接还原原始逻辑
  - 是否遗漏了已知边界条件？ → NO
  - 是否因改动量大而想缩减方案？ → NO，改动量很小
  - 是否打算跳过某些文件？ → NO
  - execution_plan是否覆盖affected_scope所有文件？ → YES
  - context是否充分？ → YES，两个文件都完整读取了
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO
  - execution_plan中是否有步骤计划使用 shell 命令修改源代码？ → NO
</analysis>

---
<output_quality_review>
task_summary: 修复 table-edit-parser.ts 中两处之前错误修改后未还原干净的代码残留
deliverables: 
  - 修改: src/service/ai/prompt-builder/table-edit-parser.ts（2处修复）

metrics:
  total_files_modified: 1
  execution_plan_coverage: 2/2 = 100%
  edge_cases_handled: N/A（无新增边界条件）
  confidence_assessment: HIGH — 两处修复均经过 grep 验证和编译验证

substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。两处修改都是实质性的逻辑修复：insertRow 的列索引映射从错误的 colIndex+1 恢复为 colIndex，updateRow 的列索引映射从错误的 colIndex 恢复为 colIndex+1。删除这些修改会导致表格数据写入错位。
  - 产物是否能被目标对象的变化所"击穿"？
    → YES。如果 AI 返回 insertRow(0, {0: "value"})，修复前会写入到错误的列位置（跳过第一列），修复后正确写入第一列。
  - 实质性比率: 2/2 = 100%

completeness_check:
  - 是否存在被跳过的模块/函数/路径？ → NO
  - 产物覆盖的范围是否与 affected_scope 完全一致？ → YES
  - 核心业务逻辑是否都有直接验证？ → YES，通过 grep 验证 data[colIndex+1] 已消除、[修复] 注释已消除、colIndex+1]=data 已恢复
  - affected_scope 覆盖率: 1/1 = 100%

value_density_check:
  - 高价值:低价值 = 2:0，高价值占比 100%
  - 是否存在"用数量掩盖质量"的模式？ → NO

alignment_check:
  - 满足的是用户的本质需求：还原之前错误修改的残留代码
  - "如果这是别人交给我的，我会接受吗？" → YES，修复精确，编译通过
</output_quality_review>
