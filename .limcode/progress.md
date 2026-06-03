# 项目进度
- Project: SP数据库
- Updated At: 2026-06-03T05:49:17.363Z
- Status: active
- Phase: implementation

## 当前摘要

<!-- LIMCODE_PROGRESS_SUMMARY_START -->
- 当前进度：尚无里程碑记录
- 当前焦点：spv3.9.8.1 已发布，等待 housekeeping / tsconfig / 下版本号决策
- 最新结论：The error logged during JSON sanitization is a false alarm. It is emitted during an expected and fully recoverable fallback path when AI-generated JSON contains unescaped quotes. T…
- 当前阻塞：无技术阻塞。
- 下一步：Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.
<!-- LIMCODE_PROGRESS_SUMMARY_END -->

## 关联文档

<!-- LIMCODE_PROGRESS_ARTIFACTS_START -->
- 计划：`.limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md`
- 审查：`.limcode/review/manual-update-toast.md`
<!-- LIMCODE_PROGRESS_ARTIFACTS_END -->

## 当前 TODO 快照

<!-- LIMCODE_PROGRESS_TODOS_START -->
- [ ] 修复 src/service/ai/api-call.ts 中 buildCustomApiRequestBody_ACU 的 maxTokens 兜底链，将 || 改为 ??，保持 0 值不被误回退  `#T1`
- [ ] 修复 callApiWithPlotPreset_ACU 与 callApi_ACU 两处 temperature: 0.7 覆盖，移除温度硬编码并让配置温度进入最终请求体  `#T2`
- [ ] 修复 callAIWithPreset_ACU 中 max_tokens/maxTokens、temperature、top_p/topP 的 || 误回退与别名缺失问题  `#T3`
- [ ] 修复 src/presentation/bootstrap/api-groups/worldbook-ai-api.ts 的 callAI 自定义 API 请求体温度 || 回退与 topP 别名缺失问题  `#T4`
- [ ] 修复 src/service/ai/prompt-builder/prompt-api-call.ts 酒馆预设 max_tokens || 4096 回退问题，并评估自定义 API overrides 是否需要最小化调整  `#T5`
- [ ] 修复 src/service/summary/merge-executor.ts 与 src/service/summary/merge-logic.ts 中 max_tokens || 4096 的同类误回退，覆盖 Tavern 与 custom 分支  `#T6`
- [ ] 补充 tests/service/ai/api-call.test.ts，覆盖 buildCustomApiRequestBody_ACU、callApi_ACU、callApiWithPlotPreset_ACU、callAIWithPreset_ACU 的参数透传与 0 值边界  `#T7`
- [ ] 补充或扩展 worldbook-ai-api 对应测试，验证 bootstrap callAI 的 temperature=0、topP/top_p 与 maxTokens 透传行为  `#T8`
- [ ] 补充 tests/service/summary/merge-executor.test.ts 与 tests/service/summary/merge-logic.test.ts，验证 max_tokens=0 不被 4096 覆盖  `#T9`
- [ ] 执行针对性测试：tests/service/ai/api-call.test.ts、summary merge 测试、worldbook-ai-api 相关测试，并执行 npm run typecheck  `#T10`
- [ ] 实施后进行独立验收，复查 src 中 temperature:0.7 与关键 || 回退残留、请求体参数优先级、Tavern/useMainApi/custom 路径兼容性  `#T11`
<!-- LIMCODE_PROGRESS_TODOS_END -->

## 项目里程碑

<!-- LIMCODE_PROGRESS_MILESTONES_START -->
<!-- 暂无里程碑 -->
<!-- LIMCODE_PROGRESS_MILESTONES_END -->

## 风险与阻塞

<!-- LIMCODE_PROGRESS_RISKS_START -->
<!-- 暂无风险 -->
<!-- LIMCODE_PROGRESS_RISKS_END -->

## 最近更新

<!-- LIMCODE_PROGRESS_LOG_START -->
- 2026-06-02T17:08:36.847Z | artifact_changed | plan | 同步计划 TODO 快照：.limcode/plans/修复填表增量base缺少稳定row_id退化checkpoint计划.md
- 2026-06-02T17:33:54.941Z | milestone_recorded | spv3.9.8 | spv3.9.8 发布完成：release commit 324c319 推送至 main，annotated tag 51bd12f 推送并指向 324c319；6 文件 244/244 测试通过，build exit 0，独立验收通过。
- 2026-06-02T17:33:54.941Z | updated | release-pipeline | 发布链路闭合：目标测试通过 → npm run build → 精确 git add 12 文件（dist/index.bundle.js 用 git add -f）→ git commit → git push origin main → git tag -a spv3.9.8 → git push origin spv3.9.8 → 远端与 tag object 校验。
- 2026-06-02T17:37:39.349Z | updated | spv3.9.8-cache-archive | spv3.9.8 发布收口：.analysis-cache.md 已归档到 .analysis-archive/2026-06-03_0136_spv3.9.8-发布完成归档.md，并从根目录删除。
- 2026-06-02T17:45:31.718Z | artifact_changed | plan | 同步计划文档：.limcode/plans/修复运行时base缺少稳定row_id退化checkpoint计划.md
- 2026-06-02T18:08:09.268Z | artifact_changed | plan | 同步计划 TODO 快照：.limcode/plans/修复运行时base缺少稳定row_id退化checkpoint计划.md
- 2026-06-02T18:26:07.579Z | artifact_changed | plan | 同步计划文档：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md
- 2026-06-02T18:34:44.670Z | artifact_changed | plan | 同步计划 TODO 快照：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md
- 2026-06-02T18:34:44.689Z | updated | 三项填表更新计数与新版API参数持久化优化已实现，定向测试与构建通过，等待独立验收。
- 2026-06-02T19:03:25.629Z | artifact_changed | plan | 同步计划 TODO 快照：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md
- 2026-06-02T19:20:05.487Z | milestone_recorded | spv3.9.8.1 | spv3.9.8.1 发布完成：release commit 2f743984bd0b03d4ddf52548e54a5b94b88963ea 推送至 main，annotated tag 905d8768864fcf328eef29f1f89be192b39c9092 推送并指向 2f74398；9 个发布文件（5 src + 3 tests + 1 dist/index.bundle.js + 1 index.js）精确不含污染，build exitCode 0，架构 guard 0 违规，dist/index.bundle.js 与 index.js SHA256 一致（BA212FD20295DF30AB312636B7C4C5D09FA2669FED4D285678384D60977AD7DA），首行 `// ==UserScript==`；8/8 业务修复 TODO 全部 completed。
- 2026-06-02T19:20:05.487Z | updated | release-pipeline | spv3.9.8.1 发布链路闭合：build 验证 → 精确 git add（src tests + git add -f dist/index.bundle.js + git add index.js）→ git commit → git push origin main → git tag -a spv3.9.8.1 → git push origin spv3.9.8.1 → 远端与 tag object 校验；publish-extension.sh 未触发。
- 2026-06-02T19:20:05.487Z | updated | spv3.9.8.1-cache-archive | spv3.9.8.1 发布收口：.analysis-cache.md 已归档到 .analysis-archive/2026-06-03_0318_spv3.9.8.1-发布完成归档.md（ASCII 文件名避 cmd 中文编码坑），并从根目录删除。
- 2026-06-02T19:20:05.487Z | updated | spv3.9.8.1-progress-sync | .limcode/progress.md 已同步：currentFocus = spv3.9.8.1 已发布，等待 housekeeping / tsconfig / 下版本号决策；nextAction 切换到具体收口决策。
- 2026-06-03T02:38:19.749Z | artifact_changed | plan | 同步计划文档：.limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md
- 2026-06-03T02:44:15.892Z | artifact_changed | plan | 同步计划文档：.limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md
- 2026-06-03T05:43:12.749Z | artifact_changed | review | 同步审查文档：.limcode/review/json-sanitization-issue-review.md
- 2026-06-03T05:45:42.918Z | artifact_changed | review | 同步审查里程碑：M1
- 2026-06-03T05:45:53.973Z | artifact_changed | review | 同步审查结论：.limcode/review/json-sanitization-issue-review.md
- 2026-06-03T05:49:17.363Z | artifact_changed | review | 同步审查文档：.limcode/review/manual-update-toast.md
<!-- LIMCODE_PROGRESS_LOG_END -->

<!-- LIMCODE_PROGRESS_METADATA_START -->
{
  "formatVersion": 1,
  "kind": "limcode.progress",
  "projectId": "sp数据库",
  "projectName": "SP数据库",
  "createdAt": "2026-05-29T14:19:16.082Z",
  "updatedAt": "2026-06-03T05:49:17.363Z",
  "status": "active",
  "phase": "implementation",
  "currentFocus": "spv3.9.8.1 已发布，等待 housekeeping / tsconfig / 下版本号决策",
  "latestConclusion": "The error logged during JSON sanitization is a false alarm. It is emitted during an expected and fully recoverable fallback path when AI-generated JSON contains unescaped quotes. The data is correctly recovered, parsed, and saved via the loose object parser (`coerceLooseRowObject_ACU`) and sanitization pipeline, without causing any functional impact or data loss. The only impact is developer/user confusion caused by an `ERROR` level log with a stack trace.\n\nThe recommended fix is to downgrade `logError_ACU` to `logWarn_ACU` or `logDebug_ACU` at the initial `JSON.parse` failure block in `src/service/ai/prompt-builder/table-edit-parser.ts`.",
  "currentBlocker": "无技术阻塞。",
  "nextAction": "Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.",
  "activeArtifacts": {
    "plan": ".limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md",
    "review": ".limcode/review/manual-update-toast.md"
  },
  "todos": [
    {
      "id": "T1",
      "content": "修复 src/service/ai/api-call.ts 中 buildCustomApiRequestBody_ACU 的 maxTokens 兜底链，将 || 改为 ??，保持 0 值不被误回退",
      "status": "pending"
    },
    {
      "id": "T2",
      "content": "修复 callApiWithPlotPreset_ACU 与 callApi_ACU 两处 temperature: 0.7 覆盖，移除温度硬编码并让配置温度进入最终请求体",
      "status": "pending"
    },
    {
      "id": "T3",
      "content": "修复 callAIWithPreset_ACU 中 max_tokens/maxTokens、temperature、top_p/topP 的 || 误回退与别名缺失问题",
      "status": "pending"
    },
    {
      "id": "T4",
      "content": "修复 src/presentation/bootstrap/api-groups/worldbook-ai-api.ts 的 callAI 自定义 API 请求体温度 || 回退与 topP 别名缺失问题",
      "status": "pending"
    },
    {
      "id": "T5",
      "content": "修复 src/service/ai/prompt-builder/prompt-api-call.ts 酒馆预设 max_tokens || 4096 回退问题，并评估自定义 API overrides 是否需要最小化调整",
      "status": "pending"
    },
    {
      "id": "T6",
      "content": "修复 src/service/summary/merge-executor.ts 与 src/service/summary/merge-logic.ts 中 max_tokens || 4096 的同类误回退，覆盖 Tavern 与 custom 分支",
      "status": "pending"
    },
    {
      "id": "T7",
      "content": "补充 tests/service/ai/api-call.test.ts，覆盖 buildCustomApiRequestBody_ACU、callApi_ACU、callApiWithPlotPreset_ACU、callAIWithPreset_ACU 的参数透传与 0 值边界",
      "status": "pending"
    },
    {
      "id": "T8",
      "content": "补充或扩展 worldbook-ai-api 对应测试，验证 bootstrap callAI 的 temperature=0、topP/top_p 与 maxTokens 透传行为",
      "status": "pending"
    },
    {
      "id": "T9",
      "content": "补充 tests/service/summary/merge-executor.test.ts 与 tests/service/summary/merge-logic.test.ts，验证 max_tokens=0 不被 4096 覆盖",
      "status": "pending"
    },
    {
      "id": "T10",
      "content": "执行针对性测试：tests/service/ai/api-call.test.ts、summary merge 测试、worldbook-ai-api 相关测试，并执行 npm run typecheck",
      "status": "pending"
    },
    {
      "id": "T11",
      "content": "实施后进行独立验收，复查 src 中 temperature:0.7 与关键 || 回退残留、请求体参数优先级、Tavern/useMainApi/custom 路径兼容性",
      "status": "pending"
    }
  ],
  "milestones": [],
  "risks": [],
  "log": [
    {
      "at": "2026-06-02T17:08:36.847Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划 TODO 快照：.limcode/plans/修复填表增量base缺少稳定row_id退化checkpoint计划.md"
    },
    {
      "at": "2026-06-02T17:33:54.941Z",
      "type": "milestone_recorded",
      "refId": "spv3.9.8",
      "message": "spv3.9.8 发布完成：release commit 324c319 推送至 main，annotated tag 51bd12f 推送并指向 324c319；6 文件 244/244 测试通过，build exit 0，独立验收通过。"
    },
    {
      "at": "2026-06-02T17:33:54.941Z",
      "type": "updated",
      "refId": "release-pipeline",
      "message": "发布链路闭合：目标测试通过 → npm run build → 精确 git add 12 文件（dist/index.bundle.js 用 git add -f）→ git commit → git push origin main → git tag -a spv3.9.8 → git push origin spv3.9.8 → 远端与 tag object 校验。"
    },
    {
      "at": "2026-06-02T17:37:39.349Z",
      "type": "updated",
      "refId": "spv3.9.8-cache-archive",
      "message": "spv3.9.8 发布收口：.analysis-cache.md 已归档到 .analysis-archive/2026-06-03_0136_spv3.9.8-发布完成归档.md，并从根目录删除。"
    },
    {
      "at": "2026-06-02T17:45:31.718Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划文档：.limcode/plans/修复运行时base缺少稳定row_id退化checkpoint计划.md"
    },
    {
      "at": "2026-06-02T18:08:09.268Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划 TODO 快照：.limcode/plans/修复运行时base缺少稳定row_id退化checkpoint计划.md"
    },
    {
      "at": "2026-06-02T18:26:07.579Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划文档：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md"
    },
    {
      "at": "2026-06-02T18:34:44.670Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划 TODO 快照：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md"
    },
    {
      "at": "2026-06-02T18:34:44.689Z",
      "type": "updated",
      "message": "三项填表更新计数与新版API参数持久化优化已实现，定向测试与构建通过，等待独立验收。"
    },
    {
      "at": "2026-06-02T19:03:25.629Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划 TODO 快照：.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md"
    },
    {
      "at": "2026-06-02T19:20:05.487Z",
      "type": "milestone_recorded",
      "refId": "spv3.9.8.1",
      "message": "spv3.9.8.1 发布完成：release commit 2f743984bd0b03d4ddf52548e54a5b94b88963ea 推送至 main，annotated tag 905d8768864fcf328eef29f1f89be192b39c9092 推送并指向 2f74398；9 个发布文件（5 src + 3 tests + 1 dist/index.bundle.js + 1 index.js）精确不含污染，build exitCode 0，架构 guard 0 违规，dist/index.bundle.js 与 index.js SHA256 一致（BA212FD20295DF30AB312636B7C4C5D09FA2669FED4D285678384D60977AD7DA），首行 `// ==UserScript==`；8/8 业务修复 TODO 全部 completed。"
    },
    {
      "at": "2026-06-02T19:20:05.487Z",
      "type": "updated",
      "refId": "release-pipeline",
      "message": "spv3.9.8.1 发布链路闭合：build 验证 → 精确 git add（src tests + git add -f dist/index.bundle.js + git add index.js）→ git commit → git push origin main → git tag -a spv3.9.8.1 → git push origin spv3.9.8.1 → 远端与 tag object 校验；publish-extension.sh 未触发。"
    },
    {
      "at": "2026-06-02T19:20:05.487Z",
      "type": "updated",
      "refId": "spv3.9.8.1-cache-archive",
      "message": "spv3.9.8.1 发布收口：.analysis-cache.md 已归档到 .analysis-archive/2026-06-03_0318_spv3.9.8.1-发布完成归档.md（ASCII 文件名避 cmd 中文编码坑），并从根目录删除。"
    },
    {
      "at": "2026-06-02T19:20:05.487Z",
      "type": "updated",
      "refId": "spv3.9.8.1-progress-sync",
      "message": ".limcode/progress.md 已同步：currentFocus = spv3.9.8.1 已发布，等待 housekeeping / tsconfig / 下版本号决策；nextAction 切换到具体收口决策。"
    },
    {
      "at": "2026-06-03T02:38:19.749Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划文档：.limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md"
    },
    {
      "at": "2026-06-03T02:44:15.892Z",
      "type": "artifact_changed",
      "refId": "plan",
      "message": "同步计划文档：.limcode/plans/修复剧情推进自定义API温度硬编码优化计划.md"
    },
    {
      "at": "2026-06-03T05:43:12.749Z",
      "type": "artifact_changed",
      "refId": "review",
      "message": "同步审查文档：.limcode/review/json-sanitization-issue-review.md"
    },
    {
      "at": "2026-06-03T05:45:42.918Z",
      "type": "artifact_changed",
      "refId": "review",
      "message": "同步审查里程碑：M1"
    },
    {
      "at": "2026-06-03T05:45:53.973Z",
      "type": "artifact_changed",
      "refId": "review",
      "message": "同步审查结论：.limcode/review/json-sanitization-issue-review.md"
    },
    {
      "at": "2026-06-03T05:49:17.363Z",
      "type": "artifact_changed",
      "refId": "review",
      "message": "同步审查文档：.limcode/review/manual-update-toast.md"
    }
  ],
  "stats": {
    "milestonesTotal": 0,
    "milestonesCompleted": 0,
    "todosTotal": 11,
    "todosCompleted": 0,
    "todosInProgress": 0,
    "todosCancelled": 0,
    "activeRisks": 0
  },
  "render": {
    "rendererVersion": 1,
    "generatedAt": "2026-06-03T05:49:17.363Z",
    "bodyHash": "sha256:5d88545971e206471a1a0be195fadc5bc8c9c77530293e65b5b30a507bd1aec9"
  }
}
<!-- LIMCODE_PROGRESS_METADATA_END -->
