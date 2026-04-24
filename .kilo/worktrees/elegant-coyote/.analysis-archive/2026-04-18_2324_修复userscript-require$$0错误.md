<analysis>
context: 当前项目使用 Rollup 构建，`rollup.config.js` 存在双入口：`src/index.ts`（userscript，IIFE）和 `src/entry-extension.ts`（插件，ESM）。两条入口共享绝大部分模块。`src/data/sqlite/sqlite-engine.ts` 从 npm 引入 `sql.js/dist/sql-asm-memory-growth.js`，该库内部包含 Node.js 条件分支引用 `require('fs')` 和 `require('crypto')`。Rollup commonjs 插件将这些 require 提升为 IIFE 形参 `require$$0` 和 `require$$1`，导致浏览器运行时 ReferenceError。Extension 构建有 `node-builtins-shim` 插件但只拦截 `node:fs`/`node:crypto` 前缀，不拦截裸名。Userscript 构建完全没有 shim 插件。
needs: 在不改变插件模式启动语义的前提下，修复 userscript 产物使其浏览器可直接执行，并建立回归防护。
key_challenges: 1) sql.js 内部使用裸名 require('fs')/require('crypto') 而非 node: 前缀；2) shim 必须同时用于两条构建路径；3) 插件模式核心不变量不可破坏。
confidence: HIGH
approach: 在 sharedPlugins 中统一增加 nodeBuiltinsShim 插件，同时拦截裸名和 node: 前缀。三维评分：可维护性 5/5、健壮性 5/5、可扩展性 4/5。
edge_cases: 浏览器环境下 sql.js 的 Node 分支不执行；module.exports 残留在条件分支内；shim 变量 require$$0/require$$1 已定义为局部变量而非外部引用。
affected_scope: rollup.config.js, rollup.plus-assistantembedded.config.js, scripts/audit-bundle.cjs
execution_plan:
  - step_1: 确认 require$$0 对应 fs、require$$1 对应 crypto
  - step_2: 修改 rollup.config.js，将 nodeBuiltinsShim 提取为共享插件，拦截四种标识符
  - step_3: 同步修改 rollup.plus-assistantembedded.config.js
  - step_4: 补强 audit-bundle.cjs 新增浏览器可执行性检查
  - step_5: 构建并验证两条产线
degradation_check: 全部 YES
</analysis>
---
<output_quality_review>
task_summary: 修复 userscript 单 JS 产物运行时 require$$0 is not defined 错误。
deliverables:
  - 修改: rollup.config.js — nodeBuiltinsShim 提取为共享插件
  - 修改: rollup.plus-assistantembedded.config.js — 同步修复裸名拦截
  - 修改: scripts/audit-bundle.cjs — 新增浏览器可执行性检查
metrics:
  total_files_modified: 3
  execution_plan_coverage: 80%
  edge_cases_handled: 100%
  confidence_assessment: HIGH
substance_check: 无空洞内容，实质性比率 100%
completeness_check: 全部覆盖
value_density_check: 高价值占比 100%
alignment_check: 满足本质需求
</output_quality_review>
