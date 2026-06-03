```xml
<analysis>
  <context>
    <item>`tests/service/table/update-orchestrator.test.ts:1836-1866` 的 `describe('processGroupedRuntimeChunk_ACU')` 级 `beforeEach` 没有恢复 `mockCheckIfFirstTimeInit` 的默认值，只做了 `vi.clearAllMocks()` 和其他基础 mock 初始化。</item>
    <item>新补的 grouped 首楼全链路测试在 `tests/service/table/update-orchestrator.test.ts:2056-2085` 中显式设置了 `mockCheckIfFirstTimeInit.mockResolvedValue(true)`，之后的“非空 tableEdit 未形成实质性操作”测试没有再覆写，导致其错误继承首楼状态。</item>
    <item>失败输出指向 `tests/service/table/update-orchestrator.test.ts:2119`，表现为本应非首楼断言 `targetSheetKeys: []` 的用例收到了 `['sheet_0','sheet_1']`。这与当前 unified 代码的首楼分支完全一致，说明根因是测试串扰，不是业务逻辑回退。</item>
  </context>
  <needs>
    <item>在 `processGroupedRuntimeChunk_ACU` 的测试分组默认夹具中恢复 `mockCheckIfFirstTimeInit=false`。</item>
    <item>重跑 `tests/service/table/update-orchestrator.test.ts` 验证串测问题清零。</item>
    <item>通过后再次调用验收专家，拿到无保留通过结论。</item>
  </needs>
  <key_challenges>
    <item>不能为解决串测去修改业务逻辑，那是把测试问题伪装成产品修复。</item>
    <item>修复点必须放在 grouped describe 的公共夹具，否则后续新增测试还会继续踩同一个坑。</item>
  </key_challenges>
  <confidence>HIGH：失败位置、串测来源、最小修复点都已通过真实代码与测试读取确认。</confidence>
  <approach>
    <maintainability score="9/10">在 grouped describe 的 beforeEach 统一恢复默认值，避免散落到单个测试。</maintainability>
    <robustness score="9/10">公共夹具恢复能防止后续任意首楼测试污染同分组下的非首楼测试。</robustness>
    <extensibility score="8/10">后续继续补 grouped 相关测试时仍能复用稳定默认状态。</extensibility>
  </approach>
  <edge_cases>
    <item>首楼 grouped 用例仍可在单个测试内显式覆盖为 `true`，不会被公共默认值阻断。</item>
    <item>后续 no-op 非首楼测试必须回到 `targetSheetKeys: []` 的断言。</item>
  </edge_cases>
  <affected_scope>
    <item>tests/service/table/update-orchestrator.test.ts</item>
    <item>.analysis-cache.md</item>
  </affected_scope>
  <execution_plan>
    <item>1. 在 `describe('processGroupedRuntimeChunk_ACU')` 的 `beforeEach` 中加入 `mockCheckIfFirstTimeInit.mockResolvedValue(false)`。</item>
    <item>2. 重跑 `npx vitest run tests/service/table/update-orchestrator.test.ts`。</item>
    <item>3. 若通过，则再次调用验收专家；若失败，再基于新输出定点修正。</item>
  </execution_plan>
  <degradation_check>
    <item>是否改动业务逻辑：NO，只修测试夹具。</item>
    <item>是否给每个测试单独补丁：NO，统一在 describe 级恢复默认状态。</item>
    <item>是否跳过复验：NO，测试通过后仍需独立验收。</item>
  </degradation_check>
</analysis>
```

---
```xml
<output_quality_review>
  <task_summary>已完成三项产品行为修复的最终闭环，并补齐 unified grouped 主路径的首次初始化全链路测试。核心结果包括：首楼全表更新登记、参与但无实质修改仍计入本轮更新、新版 API 预设参数保存后同步到当前聊天配置；最终经独立验收专家复验通过。</task_summary>
  <deliverables>
    <item>`src/service/table/table-service.ts`：统一 tracking candidate 口径，仅扩大追踪元数据，不扩大实际保存表。</item>
    <item>`src/service/table/update-orchestrator.ts`：修复 legacy 与 unified 路径的首楼全表追踪、参与即更新、no-op group success 语义。</item>
    <item>`src/presentation-v2/stores/api-preset-store.ts`：修正当前活动预设/重命名同步当前聊天 API 配置，清理不存在函数的误导注释。</item>
    <item>`tests/service/table/table-service.test.ts`、`tests/service/table/update-orchestrator.test.ts`、`tests/presentation-v2/api/api-preset-store.test.ts`：补齐写侧追踪、grouped unified、API 持久化相关回归测试。</item>
    <item>`.limcode/plans/三项填表更新计数与新版API参数持久化优化计划.md`：TODO 已全部同步为 completed。</item>
  </deliverables>
  <metrics>
    <item>total_files_modified: 6 个业务/测试文件 + 计划/分析归档文件</item>
    <item>execution_plan_coverage: 100%，包括补救性 grouped 首楼全链路测试、定向 vitest、build、二次独立验收</item>
    <item>edge_cases_handled: 首楼全表保存/追踪、no-op group、非空但无实质修改、越权修改防线保留、活动预设重命名同步</item>
    <item>confidence_assessment: HIGH；已通过定向测试、相关回归、build 与两轮独立验收专家复核，最终结论为“通过”</item>
  </metrics>
  <substance_check>
    <item>不存在“只改测试不改逻辑”或“只改逻辑不锁测试”的空心交付。unified grouped 主路径实现与 `processGroupedRuntimeChunk_ACU` 全链路测试均已收口。</item>
    <item>产物没有靠放宽断言过关；测试明确区分 `targetSheetKeys` 与 `trackingSheetKeys/updateGroupKeys`，锁住了“实际保存”和“参与计数”分离语义。</item>
  </substance_check>
  <completeness_check>
    <item>affected_scope 中的核心业务文件均已覆盖：table-service、update-orchestrator、api-preset-store 及对应测试文件。</item>
    <item>核心业务逻辑已有直接验证：`tests/service/table/update-orchestrator.test.ts` 最终 89 passed；此前相关回归 58 passed；`npm run build` 最终通过且架构守卫 0 违规。</item>
    <item>独立验收专家最终明确给出“通过”，并确认 grouped 主入口首次初始化全链路测试已补齐。</item>
  </completeness_check>
  <value_density_check>
    <item>高价值内容占主导：所有改动都围绕三项产品缺陷及其回归面，没有顺手引入无关重构、配置化或兼容垫片。</item>
    <item>低价值内容仅限分析缓存、计划同步与归档，这些属于流程性必需，不是填充物。</item>
  </value_density_check>
  <alignment_check>
    <item>满足用户本质需求：按生产系统标准完成实现、验证、补测、构建与独立验收，而不是停留在“看起来能跑”。</item>
    <item>如果这是别人交给我的，我会接受吗？会。因为实现、测试、构建和独立验收链条都已闭合，且最后一个测试强度缺口也已补齐。</item>
  </alignment_check>
</output_quality_review>
```