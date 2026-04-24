<analysis>
context:
  - 当前向量召回链路分为四段：查询预处理、query embedding 生成、本地 chunk 相似度筛选、批次级结果排序与世界书注入。真正的召回入口在 vector-recall-service，后续由 orchestrator 接入发送前流程。
  - 现有所谓 rerank 不是模型能力，而是本地启发式重排：把 chunk 相似度、summary 文本命中、sourceRowKeys 命中、多 chunk 命中等规则拼成 finalScore。这意味着“加 rerank 模型”不是改个文案，而是要引入真实外部 rerank 调用，并决定它在现有链路中的插入点。
  - 配置模型集中在 defaultVectorMemoryConfig_ACU 与 VectorMemoryConfig_ACU，当前只包含 embeddingEndpoint、embeddingApiKey、embeddingModel 等 embedding 字段，没有任何 rerank 配置字段。
  - 配置规范化和校验都在 vector-memory-config 中。当前 validateVectorMemoryConfig 会强制 embeddingEndpoint 和 embeddingModel 存在；这对当前召回链路合理，因为 query 初筛仍依赖 embedding。
  - UI 侧有三处必须同步：页面结构 main-popup-table、事件绑定 popup-bindings-worldbook、状态回填 status-display。少改任何一处，都会出现“能保存不能显示”或“能填不能持久化”的半残状态。
  - 请求层当前已有 vector-embedding-gateway，可直接用 fetch + getHostRequestHeaders_ACU 访问外部 embedding endpoint。这个实现风格适合复用到 rerank gateway，避免把 rerank 请求散落到 service 层。
  - 当前还有一组已存在但语义会变化的配置：topK、minScore、recallCandidateLimit。引入真实 rerank 后，minScore 与 recallCandidateLimit 更适合定义为“embedding 预筛选参数”，而不是最终相关性控制参数；topK 仍然定义最终输出数量，不能粗暴删除。
  - status-display 已确认存在完整回填逻辑，后续新增 rerank 字段必须在这里补齐，否则 UI 刷新后会丢显示。
  - 当前项目已有关键词生成调用 AI 预设的链路，但 rerank 更适合走独立 HTTP gateway，而不是复用 chat completion。原因很直接：rerank 请求体通常是 query + documents，响应结构也完全不同，强行复用只会把调用层搞脏。

needs:
  - 为向量功能增加真实 rerank 模型配置与调用能力。
  - 在 UI 中增加 rerank 模型相关填写项，并完成默认值、回填、绑定、持久化全链路接入。
  - 在召回逻辑中把 rerank 放在“embedding 预筛选之后、最终 TopK 之前”，并保留现有启发式排序作为降级后备。
  - 重新梳理有了 rerank 后的旧配置职责，明确哪些保留、哪些优化文案、哪些不应取消，避免产生两套互相冲突的排序语义。
  - 保证旧配置数据可迁移、无 rerank 配置时不破坏原有功能、rerank 服务异常时可回退。

key_challenges:
  - 真实 rerank 与现有本地启发式排序并存时，必须定义清楚优先级和降级策略，否则结果会不可解释。
  - rerank 服务通常返回的是候选文档顺序或分数，而当前系统最终产物是按 batch 注入的 VectorRecallMatch；需要在 batch 粒度和 chunk 粒度之间做好映射，不然你只是在制造新的错配点。
  - 当前候选集来自 chunk 级相似度，最终展示和注入却是 batch 级 summary。真实 rerank 如果输入的是 batch summary，需要决定是否继续保留 chunk 级 bestChunk 元数据；如果输入的是 chunk 文本，又要处理多 chunk 合并后的 batch 排序问题。
  - 配置校验不能把 rerank 变成强制项，否则老用户一升级就直接把现有向量功能打废；但也不能完全不校验，否则用户填了半套配置时会得到不透明的失败。
  - UI 文案要同步调整。继续把 minScore 叫“最小分数”会误导用户以为它控制 rerank 最终分数，这种命名错误会把维护和排障都拖进泥里。

confidence: MEDIUM
approach:
  选择的方案是在现有 embedding 召回链路上新增“可选真实 rerank 模型重排”能力，并保留现有本地启发式重排作为无 rerank 配置或 rerank 调用失败时的后备路径。具体做法是：先用 embedding 对 chunk 做预筛选，聚合出 batch 候选；若 rerank 配置完整且候选数大于 1，则调用独立 rerank gateway 以 query + batch summary 列表进行重排；若配置缺失或调用失败，则回退到现有启发式排序。与此同时扩展全局配置与 UI，并把 minScore、recallCandidateLimit 的文案改成预筛选语义。

  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 4/5 — embedding 与 rerank 职责分层清晰，请求层放在 data gateway，UI/配置/召回逻辑各自归位；仍需保留启发式回退，因此存在双路径复杂度，但这是为了稳定性付出的合理成本。
  - 健壮性: 5/5 — rerank 仅在配置完整且候选足够时启用，调用异常、返回异常、索引异常都回退本地启发式，不会把整个发送前召回链路一起拖死。
  - 可扩展性: 5/5 — 后续可继续增加 rerankEndpoint、rerankApiKey、rerankModel、rerankTopN，甚至可扩展 query 改写或多路召回，而不需要重写归档和世界书同步模块。

edge_cases:
  - rerank 未配置时，系统必须保持现有召回行为，仅继续使用本地启发式重排。
  - rerank 已配置但 endpoint 为空、model 为空、documents 为空时，不得发请求，直接回退本地排序。
  - rerank 请求失败、返回非 2xx、返回 data 为空、返回索引越界、返回 relevance_score 非数值时，必须记录错误并回退。
  - 候选数为 0 或 1 时不发起 rerank 请求，避免无意义的额外延迟。
  - rerank 返回结果少于输入候选数时，未返回候选必须按原顺序追加到末尾，避免批量丢失。
  - recallCandidateLimit 仍必须大于等于 topK，因为 rerank 输入候选不能比最终输出更少。
  - 旧的 settings_ACU.vectorMemoryConfig 中不含 rerank 字段时，normalize 后必须自动补默认值，不能导致 undefined 访问或 UI 回填异常。
  - UI 页面、事件绑定、状态回填三处必须同步接入 rerank 字段；少任何一处都算实现不完整。
  - minScore 与 recallCandidateLimit 的文案必须强调“embedding 预筛选”，避免和 rerank 最终排序语义冲突。

affected_scope:
  - src/shared/defaults.ts
  - src/service/vector/vector-memory-config.ts
  - src/data/gateways/vector-rerank-gateway.ts
  - src/service/vector/vector-recall-service.ts
  - src/presentation/pages/main-popup-table.ts
  - src/presentation/pages/popup-bindings-worldbook.ts
  - src/presentation/components/status-display.ts

execution_plan:
  - step_1: 扩展默认配置与配置类型，新增 rerankEndpoint、rerankApiKey、rerankModel 等字段，并在 normalize 与校验逻辑中加入“可选但自洽”的处理。
  - step_2: 新增独立 rerank gateway，使用与 embedding gateway 一致的请求头与错误处理风格，封装 query + documents 的外部调用。
  - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径，并在异常时稳定回退。
  - step_4: 修改 UI 页面、事件绑定、状态回填，增加 rerank 配置输入框，并把 minScore、recallCandidateLimit 的文案改为预筛选语义。
  - step_5: 复查 rerank 引入后的旧配置职责，保留 topK、minScore、recallCandidateLimit，但调整其语义说明，不贸然取消仍有作用的配置项。
  - step_6: 运行构建或类型检查验证修改结果，确认没有引入编译错误或明显类型回归。

degradation_check:
  - 方案是否是三维评估综合最优的？ → YES。它在可维护性上做到了配置、网关、服务、UI 分层，在健壮性上具备失败回退，在可扩展性上为更多 rerank 参数预留空间，优于“只加 UI 字段”或“直接删除旧排序逻辑”的阉割方案。
  - 是否遗漏了已知边界条件？ → NO。已覆盖未配置、调用失败、异常返回、候选过少、旧配置迁移、UI 三处同步、参数语义变更等关键边界。
  - 是否因改动量大而想缩减方案？ → NO。用户要求的是完整功能接入与配置梳理，缩成“先加个输入框”属于明显失格。
  - 是否打算跳过某些文件？ → NO。默认值、配置、网关、召回、页面、绑定、回填都在范围内，没有偷懒跳过。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。七个目标文件均被 execution_plan 覆盖。
  - context是否充分？是否有未读但可能相关的文件？ → NO。当前实现所需的 UI、配置、召回、请求层关键信息已完成侦察，可以进入修改阶段。
  - 是否有发现了但被我判断为“无关紧要”而跳过的问题？ → NO。参数语义冲突、本地伪 rerank、UI 回填缺口风险都已纳入方案。
  - execution_plan中是否有步骤计划使用 shell 命令修改源代码？ → NO。所有源码修改都将使用标准编辑工具完成。
</analysis>
---
<decision_point>
issue: 修改 [`src/shared/defaults.ts`](src/shared/defaults.ts:28) 后，工具返回了与当前功能实现无直接关系的 TypeScript 诊断：[`tsconfig.json`](tsconfig.json:19) 中的 `"baseUrl"` 已弃用。这不是侦察阶段能直接看到的问题，因为它是在保存后由工程诊断链路冒出来的，而不是静态阅读代码就能确认的事实。
impact: NO。这个问题不会阻断当前 rerank 功能的可行性，影响的是“后续验证信号的纯净度”而不是 rerank 方案本身；如果处理不当，会让最终验证阶段混入与本次改动无关的噪音。
context_update:
  - 受影响字段: confidence、execution_plan.step_6
  - 更新内容:
      - confidence 维持 MEDIUM，但需要明确区分“本次改动引入的问题”和“项目基线已有的工程告警”。
      - execution_plan.step_6 不能只写“运行构建或类型检查”，还必须补上“区分基线告警与新增回归”的验证策略。
options:
  - option_a:
      description: 立即中断 rerank 实现，先修改 [`tsconfig.json`](tsconfig.json:19) 消除 `"baseUrl"` 弃用告警，再继续当前功能开发。
      approach_evaluation:
        - 可维护性: 2/5 — 会把本次需求无关的工程配置改动强行混入功能分支，污染变更边界。
        - 健壮性: 3/5 — 诊断输出会更干净，但这是通过扩大改动范围换来的，不是对当前功能本身的增强。
        - 可扩展性: 2/5 — 解决的是工具链噪音，不是 rerank 架构问题，对后续功能扩展帮助有限。
      edge_cases:
        - 可能引入与现有构建链不兼容的配置副作用。
        - 可能把“静音告警”误当成“修复问题”，掩盖真实的 TS 迁移工作。
      affected_scope_delta:
        - 新增修改 [`tsconfig.json`](tsconfig.json:19)
  - option_b:
      description: 继续按原方案实现 rerank 功能，不在本轮修改 [`tsconfig.json`](tsconfig.json:19)；将该告警明确标记为项目基线问题，并在最终验证时区分“已有告警”与“本次新增回归”。
      approach_evaluation:
        - 可维护性: 5/5 — 保持功能变更与工程基线问题边界清晰，提交内容可解释。
        - 健壮性: 4/5 — 不会因为无关告警打断功能交付，同时通过验证策略避免把基线噪音误判为新问题。
        - 可扩展性: 4/5 — 后续若要做 TS 配置升级，可以单独开任务处理，不和 rerank 功能耦合。
      edge_cases:
        - 最终验收必须明确说明该告警为基线问题，而不是遗漏。
        - 验证时要避免用“有一个旧告警”去掩盖新增类型错误。
      affected_scope_delta:
        - affected_scope 不变
        - execution_plan.step_6 需要补充“区分基线告警与新增回归”的验证说明
  - option_c:
      description: 回退刚刚对 [`src/shared/defaults.ts`](src/shared/defaults.ts:28) 的修改，先暂停实现，等待后续把工程诊断环境整理干净后再重新开始。
      approach_evaluation:
        - 可维护性: 1/5 — 直接打断已确认可行的方案，没有解决用户任务。
        - 健壮性: 1/5 — 回退并不能消除基线告警，只是停止前进。
        - 可扩展性: 1/5 — 对 rerank 功能没有任何正向推进。
      edge_cases:
        - 用户需求被无意义延后。
        - 后续仍然会再次遇到相同基线告警。
      affected_scope_delta:
        - 回退 [`src/shared/defaults.ts`](src/shared/defaults.ts:28) 的已完成修改
recommendation: 选择 option_b。它在三维评估里综合最优：可维护性最高，因为保持了功能边界清晰；健壮性足够，因为不会让无关告警打断 rerank 实现，同时要求在验收时区分基线问题与新增回归；可扩展性也更高，因为 TS 配置升级可以后续独立处理，不污染当前功能任务。
execution_plan_update:
  - step_1 至 step_5 保持不变。
  - step_6 更新为：运行构建或类型检查验证修改结果，并显式区分项目基线已有告警与本次改动引入的新增错误；不在本轮顺手修改无关的 [`tsconfig.json`](tsconfig.json:19)。
deviation_audit:
  original_plan_excerpt:
    - step_6: 运行构建或类型检查验证修改结果，确认没有引入编译错误或明显类型回归。
  current_proposal:
    - step_6: 运行构建或类型检查验证修改结果，并显式区分项目基线已有告警与本次改动引入的新增错误；不在本轮顺手修改无关的 [`tsconfig.json`](tsconfig.json:19)。
  diff_summary:
    - 没有新增或删减 affected_scope。
    - 没有改变 rerank 功能实现路径。
    - 仅为 step_6 增加了“区分基线告警与新增回归”的验证约束，并明确不把无关的工程配置修复混入本次任务。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。当前方案只是补强验证策略，没有降低原方案在可维护性、健壮性、可扩展性上的评分。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有砍掉任何原定文件或步骤。
degradation_check:
  - 推荐方案是否是三维评估综合最优的？ → YES。option_b 在可维护性 5/5、健壮性 4/5、可扩展性 4/5 上综合优于其他方案。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“基线告警不得掩盖新增错误”这一新增边界条件。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。没有缩减功能实现范围，只是拒绝把无关的工程配置修复混入当前任务。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。affected_scope 未变化，execution_plan 仍完整覆盖。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。这个告警不会被忽略，而是会在验收中被明确标注为基线问题。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。后续仍使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。不存在缩 scope、降质量或回避复杂度的偷懒行为。
</decision_point>
---
<decision_point>
issue: 新增文件 [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:1) 后，TypeScript 诊断报告在 [`extractRerankResults_ACU()`](src/data/gateways/vector-rerank-gateway.ts:52) 的 `.filter((item): item is VectorRerankResult_ACU => !!item)` 上出现“参数 item 隐式具有 any 类型”。这是执行阶段才暴露的问题，因为它依赖于 TS 对新文件的实际检查结果，侦察阶段无法直接推断该匿名函数签名会被当前编译设置判为 implicit any。
impact: NO。这个问题不影响当前 rerank 方案的可行性，但如果不先修正就继续改召回服务，会让后续新增错误与现有错误混在一起，破坏验证信号。
context_update:
  - 受影响字段: confidence、execution_plan.step_2
  - 更新内容:
      - confidence 仍为 MEDIUM，但 step_2 必须先把 gateway 文件修到类型干净，再进入 [`step_3`](.analysis-cache.md)。
      - 当前错误属于新引入回归，不是项目基线问题，必须立即修正。
options:
  - option_a:
      description: 直接在当前 `.filter()` 的参数上补显式联合类型，例如把参数声明为 `VectorRerankResult_ACU | null`，保持现有实现结构不变。
      approach_evaluation:
        - 可维护性: 5/5 — 改动最小且精确，直接消除 implicit any，不改变现有数据流。
        - 健壮性: 4/5 — 能稳定解决当前类型问题，但仍依赖前一层 `.map()` 返回联合类型推断正确。
        - 可扩展性: 4/5 — 后续若结果类型扩展，依旧容易维护。
      edge_cases:
        - 需要确保 `.map()` 产物确实是 `VectorRerankResult_ACU | null`，否则只是表面静音。
      affected_scope_delta:
        - 仅修改 [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:52)
  - option_b:
      description: 重构 [`extractRerankResults_ACU()`](src/data/gateways/vector-rerank-gateway.ts:52) 为显式 `for...of` 循环，避免在 `map + filter` 组合里依赖 TS 对联合类型和类型谓词的推断。
      approach_evaluation:
        - 可维护性: 4/5 — 逻辑更显式，但代码更长，纯为规避一个简单的类型问题而重写会增加样板。
        - 健壮性: 5/5 — 对 TS 推断依赖更低，行为直观。
        - 可扩展性: 4/5 — 后续可在循环里加更多过滤条件，但当前场景属于略微过度实现。
      edge_cases:
        - 容易在重写过程中引入无意义的行为变化。
      affected_scope_delta:
        - 仅修改 [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:52)
  - option_c:
      description: 暂时忽略这个类型错误，继续实现召回服务，最后统一修类型问题。
      approach_evaluation:
        - 可维护性: 1/5 — 会把新增错误带入后续步骤，污染问题定位。
        - 健壮性: 1/5 — 一旦后续再出现类型错误，根因边界会立刻变脏。
        - 可扩展性: 1/5 — 这是把债往后推，不是解决问题。
      edge_cases:
        - 后续多个类型错误叠加，难以判断是 gateway 本身问题还是召回服务接入问题。
      affected_scope_delta:
        - 不新增文件，但会让 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts) 的后续修改建立在错误基线上
recommendation: 选择 option_a。它在三维评估中综合最优：可维护性最高，因为只修正当前确切错误而不改动结构；健壮性足够，因为能直接消除 implicit any；可扩展性也不差，没有为一个简单类型回归引入不必要的重构复杂度。
execution_plan_update:
  - 在继续 [`step_2`](.analysis-cache.md) 之前，先精确修正 [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:52) 的 `.filter()` 参数类型。
  - 修正完成后继续原定 [`step_2`](.analysis-cache.md) 收尾，再进入 [`step_3`](.analysis-cache.md) 的召回服务接入。
deviation_audit:
  original_plan_excerpt:
    - step_2: 新增独立 rerank gateway，使用与 embedding gateway 一致的请求头与错误处理风格，封装 query + documents 的外部调用。
    - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径，并在异常时稳定回退。
  current_proposal:
    - step_2: 新增独立 rerank gateway，使用与 embedding gateway 一致的请求头与错误处理风格，封装 query + documents 的外部调用；在收尾前先精确修正 gateway 内新引入的 TypeScript implicit any 错误。
    - step_3: 在 gateway 类型干净后再改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径，并在异常时稳定回退。
  diff_summary:
    - 没有改变整体实现顺序，只是在 step_2 内新增“先修 gateway 新错误”的收尾动作。
    - 没有新增或删减 affected_scope。
    - 没有降低功能范围或取消任何原定步骤。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。只是增加 step_2 的类型修复收尾，不降低原方案评分。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有砍掉任何文件或步骤。
degradation_check:
  - 推荐方案是否是三维评估综合最优的？ → YES。option_a 以最小、最精确的改动解决当前新增错误，综合优于重写结构或放任错误继续传播。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“这是新增回归，不是基线噪音”这一关键边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。这里选择小改动是因为它在三维评估上确实最优，不是为了回避复杂度。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。affected_scope 未变化，原计划完整保留。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。当前类型错误会立即修正，不会被拖延。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。不存在缩 scope、降质量或回避复杂度的偷懒行为。
</decision_point>
---
<decision_point>
issue: 当前实现把“rerank 配置成对填写”的校验加进了 [`validateVectorMemoryConfig_ACU()`](src/service/vector/vector-memory-config.ts:230)。这会直接影响 [`isVectorMemoryEnabled_ACU()`](src/service/vector/vector-memory-config.ts:253) 的判断，从而在用户只填了一半 rerank 配置时，把整个向量记忆功能判为不可用。这个问题在侦察阶段无法完全暴露，因为它依赖于把配置校验真正接回现有调用链之后，才能看出 optional rerank 被错误提升成了全局致命配置。
impact: YES。它影响当前方案的正确性：如果不修正，用户一旦半填 rerank 字段，原本可用的 embedding 召回、世界书同步、远记忆能力都会被整体打废，违背“rerank 是可选增强，不是硬依赖”的设计目标。
context_update:
  - 受影响字段: approach、edge_cases、execution_plan.step_1、execution_plan.step_3
  - 更新内容:
      - rerank 校验必须从“全局致命校验”调整为“召回阶段的可选增强校验”。
      - 半填 rerank 配置时，系统应继续使用原有启发式重排，同时在 [`VectorRecallResult_ACU.errors`](src/service/vector/vector-recall-service.ts:27) 中返回明确错误，而不是直接把功能整体禁用。
options:
  - option_a:
      description: 保持当前做法，让 [`validateVectorMemoryConfig_ACU()`](src/service/vector/vector-memory-config.ts:230) 对半填 rerank 配置直接报错并禁用整个向量功能。
      approach_evaluation:
        - 可维护性: 2/5 — 规则看似集中，但把 optional 增强项错误地塞进核心开关判断，语义混乱。
        - 健壮性: 1/5 — 用户只填错一个 rerank 字段就会失去整个向量功能，降级路径被彻底破坏。
        - 可扩展性: 2/5 — 后续新增更多 rerank 配置项时，这种“半填即全挂”的耦合只会更糟。
      edge_cases:
        - 老用户升级后误填 rerank 字段会导致现有功能突然不可用。
        - UI 若允许逐项保存，用户在填写过程中会短暂触发整体失效。
      affected_scope_delta:
        - 无新增文件，但会让 [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:230) 持续承担错误职责
  - option_b:
      description: 将 rerank 自洽校验从全局校验中移出，新增独立的 rerank 可用性/校验函数；召回服务在执行真实 rerank 前检查该状态，若配置完整则调用模型，若半填或无效则记录错误并回退启发式排序。
      approach_evaluation:
        - 可维护性: 5/5 — 核心功能校验与可选增强校验职责分离，语义清晰。
        - 健壮性: 5/5 — 半填 rerank 配置不会打断主功能，且用户能得到明确错误信息。
        - 可扩展性: 5/5 — 后续增加 rerankTopN、provider 等字段时，只需扩展独立 rerank 校验逻辑。
      edge_cases:
        - 需要保证错误信息不会被静默吞掉，而是返回到 [`errors`](src/service/vector/vector-recall-service.ts:27)。
        - 需要保证“无 rerank 配置”和“半填 rerank 配置”行为不同：前者静默走旧逻辑，后者保留功能但附带错误提示。
      affected_scope_delta:
        - 修改 [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:181)
        - 修改 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:312)
  - option_c:
      description: 保留当前全局校验，但在 UI 层阻止用户分步保存 rerank 字段，要求三个字段一次性提交。
      approach_evaluation:
        - 可维护性: 2/5 — 用 UI 交互去掩盖底层设计错误，调用链职责依旧错位。
        - 健壮性: 2/5 — 任何非 UI 写入路径、旧配置迁移、脚本写配置都仍会触发整体失效。
        - 可扩展性: 2/5 — 后续增加其他配置入口时，这种限制会到处漏水。
      edge_cases:
        - 配置并不只从 UI 进入，迁移或脚本注入仍可能制造半填状态。
        - UI 一次性提交本身也不能替代后端校验。
      affected_scope_delta:
        - 新增修改 [`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts:103)
        - 但无法消除 [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:230) 的根因问题
recommendation: 选择 option_b。它在三维评估上综合最优：可维护性最高，因为把 optional rerank 与核心功能校验彻底分层；健壮性最高，因为半填配置不会打断主流程；可扩展性最高，因为未来 rerank 配置增长时无需再污染核心开关逻辑。
execution_plan_update:
---
<decision_point>
issue: [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21) 已经把 `warnings` 纳入返回结构，但上游 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 仍只按 `errors` 做阻断判定，也没有明确处理 `warnings` 的汇总语义。这个问题在前一轮分析里只被识别为“要改 orchestrator”，但没有在动手前重新对照缓存中的原始 `execution_plan` 与边界清单，继续直接改会把“非阻断降级”和“严格失败”混成一锅。
impact: YES。影响范围包括 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 的阻断语义、最终结果对象的 `errors` 聚合方式，以及后续 UI/状态展示是否能正确看到 rerank 降级告警。如果这里处理草率，结果就是：rerank 配置填错时要么错误阻断发送，要么告警被吞掉，两个都属于劣质实现。
context_update: 原 analysis 中“rerank 降级应走 warnings、不阻断主流程”的假设现在需要进一步落地为“上游编排层必须显式消费 recall warnings，并决定是否透传”；受影响字段包括 `approach`、`edge_cases`、`affected_scope`、`execution_plan`。
options:
  - option_a:
      description: 只在 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245) 保持现有逻辑不动，认为 `warnings` 只是召回内部细节，不向上游汇总。
      approach_evaluation: 可维护性 2/5——接口新增字段却不消费，等于制造死字段；健壮性 2/5——告警被静默吞掉，调用方无法区分“成功且完全正常”和“成功但已回退”；可扩展性 2/5——后续任何 UI 或日志想展示 rerank 降级都得再返工。
      edge_cases: rerank 半填配置、rerank 接口超时、rerank 返回空结果时，用户表面看到“成功”，但实际不知道已回退到启发式排序。
      affected_scope_delta: 不新增文件，但会故意放任 [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21) 的 `warnings` 处于半接线状态。
  - option_b:
      description: 在 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245) 中继续只用 `recallResult.errors` 作为阻断依据，但把 `recallResult.warnings` 合并进最终 `errors` 数组返回。
      approach_evaluation: 可维护性 2/5——把 warnings 塞进 errors 是语义污染；健壮性 3/5——至少不会阻断，但调用方无法再信任 `errors` 的含义；可扩展性 2/5——未来若需要区分真正失败与降级告警，还得拆回来。
      edge_cases: 结果对象里 `errors` 非空但 `shouldProceed=true`，会让任何依赖 `errors.length` 的调用方产生歧义。
      affected_scope_delta: 只改 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245)，但会把结果模型语义进一步弄脏。
  - option_c:
      description: 读取 [`.analysis-cache.md`](.analysis-cache.md) 刷新原 analysis 与既有 decision_point，然后在 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245) 中明确区分 `recallErrors`、`recallWarnings`、`syncErrors`：只有 `recallErrors` 或世界书同步失败才阻断，`recallWarnings` 仅透传或并入非阻断告警通道；随后再据此决定 UI 是否展示。
      approach_evaluation: 可维护性 5/5——错误与告警语义一致；健壮性 5/5——半填配置、空 rerank 结果、rerank 异常都能稳定降级而不误阻断；可扩展性 4/5——后续 UI、日志、调试都能直接消费 `warnings`。
      edge_cases: 需要确认 orchestrator 返回结构是否也要新增 `warnings`；需要检查现有调用方是否只读取 `errors`，避免上游再发生静默丢告警。
      affected_scope_delta: 继续影响 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16)，并可能扩展到其调用方/展示层。
recommendation: 选 option_c。理由很直接：它在可维护性、健壮性、可扩展性三项上都是综合最优，且没有客观技术阻碍。继续拿 `errors` 冒充 `warnings` 只是偷懒，不是设计。
execution_plan_update: 在修改 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 前，先重新读取 [`.analysis-cache.md`](.analysis-cache.md) 刷新原 analysis 与既有 decision_point，确认当前执行没有偏离“rerank 降级不阻断”的既定方案；随后再做 orchestrator 的结构修改，并把 UI 层是否展示 `warnings` 纳入后续步骤。
deviation_audit:
  original_plan_excerpt: “1. 先改 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16)，把 `warnings`/`errors` 语义闭环接上。 2. 再回读并检查 [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21) 最新 diff 是否有 TS 问题。 3. 然后一次性完成 UI 三件套：[`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts)、[`popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts)、[`status-display.ts`](src/presentation/components/status-display.ts)。”
  current_proposal: “先读取 [`.analysis-cache.md`](.analysis-cache.md) 刷新记忆，再修改 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 的 `warnings`/`errors` 闭环语义；其后继续执行原定的 service 校验和 UI 三件套步骤。”
  diff_summary: 新增了一步“读取 [`.analysis-cache.md`](.analysis-cache.md) 刷新 analysis/decision_point 记忆”；原本的核心修改目标未变，没有删减任何实现范围，也没有把后续 UI 步骤砍掉。
  deviation_motive_check:
    - 结论：未命中需要自我剖析的偷懒措辞；这次偏离不是缩 scope，而是补上技能要求的记忆刷新步骤，防止方案漂移。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。只是增加一次记忆刷新，不降低任何维度，反而提高健壮性。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有砍文件，只是先校准上下文。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_c 同时保留了错误/告警语义分层、降级可见性和后续扩展空间。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已明确覆盖 rerank 半填、调用异常、空返回，以及 `errors`/`warnings` 语义歧义。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，是拒绝 option_a/option_b 这种图省事的烂做法。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。[`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 先处理，后续 UI 三件套不变。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。`warnings` 语义错配就是当前最该处理的问题。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有出现偷懒降级。
</decision_point>
---
<decision_point>
issue: 读取 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 时，我按错误的高行号范围发起了读取，直接触发“line index does not exist”。这不是功能设计问题，而是执行期的侦察参数错误：文件真实行数比我预估短，说明不能再拿猜的范围去读 UI 结构。
impact: NO。它不影响 rerank 方案本身的可行性，但影响当前 UI 改造的执行精度。如果继续凭猜测插入 rerank 字段，后果就是把 DOM 结构改错位置，或者漏改文案。
context_update: 受影响字段包括 `execution_plan.step_4` 与当前执行顺序。更新内容是：在修改 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 前，必须先精确定位向量配置区块所在位置，而不是用拍脑袋的行号读取。
options:
  - option_a:
      description: 继续凭已知的 selector 命名规律直接修改 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1)，不再重新读取页面结构。
      approach_evaluation: 可维护性 1/5——属于盲改；健壮性 1/5——极易插错位置或破坏现有 HTML 结构；可扩展性 1/5——后续一旦发现 UI 错位还得返工。
      edge_cases: rerank 输入框可能被插进错误分组、label 文案可能和实际 selector 对不上、旧字段文案优化可能漏改。
      affected_scope_delta: 表面上只动 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1)，实则会把 UI、绑定、回填三处耦合一起搞乱。
  - option_b:
      description: 先用搜索精确定位 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 中向量记忆区块的锚点，再按实际位置读取小范围内容，确认 rerank 字段与旧文案的插入点后再修改。
      approach_evaluation: 可维护性 5/5——基于真实结构改动；健壮性 5/5——能避免因错误行号导致的盲改；可扩展性 4/5——后续若还要调整该区块的其他配置，也有准确锚点可复用。
      edge_cases: 需要确认该文件是否通过模板字符串生成 UI，搜索关键词要足够准，否则会定位到别的片段。
      affected_scope_delta: 只新增一次对 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 的精准搜索/读取，不改变原定修改范围。
  - option_c:
      description: 跳过 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1)，先去改 [`popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts:103) 和 [`status-display.ts`](src/presentation/components/status-display.ts:136)，等最后再回头补 UI 结构。
      approach_evaluation: 可维护性 2/5——顺序错了，先绑不存在的 DOM 只会制造半完成状态；健壮性 2/5——很容易忘记回补页面结构；可扩展性 2/5——后续排查“为什么没显示”会更麻烦。
      edge_cases: selector 提前接入但页面里没有对应元素，测试时只能看到“代码写了但 UI 不出现”的假象。
      affected_scope_delta: 使 [`popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts:103) 与 [`status-display.ts`](src/presentation/components/status-display.ts:136) 先于页面结构被修改，增加半接线风险。
recommendation: 选 option_b。这是唯一不靠猜的方案，也是三维评估综合最优的方案。UI 改造最忌讳盲插，先定位锚点再下刀，才像个像样的工程动作。
execution_plan_update: 在继续原定 `step_4` 前，先通过搜索定位 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 的向量记忆配置区块锚点，读取准确片段后再同步修改页面结构、事件绑定和状态回填；其余步骤顺序不变。
deviation_audit:
  original_plan_excerpt: “step_4: 修改 UI 页面、事件绑定、状态回填，增加 rerank 配置输入框，并把 minScore、recallCandidateLimit 的文案改为预筛选语义。”
  current_proposal: “在执行 step_4 前，先精确搜索并读取 [`main-popup-table.ts`](src/presentation/pages/main-popup-table.ts:1) 的向量记忆区块，再修改 UI 页面、事件绑定、状态回填，增加 rerank 配置输入框，并把 minScore、recallCandidateLimit 的文案改为预筛选语义。”
  diff_summary: 没有改动 step_4 的目标内容，只新增了一个“先定位锚点再修改”的前置动作，避免基于错误行号盲改。
  deviation_motive_check:
    - 结论：未命中需要替换的偷懒措辞；这次偏离是为了修正执行期侦察错误，不是缩减范围。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。增加精确定位只会提高健壮性。
    - 偏离是否导致 affected_scope 缩小？→ NO。UI 三件套仍全部在范围内。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 通过精确定位避免盲改，三维评分明显优于其他选项。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“文件行号估计错误导致读取失败”的执行期边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，是拒绝 option_a/option_c 这种图快的半残做法。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。只增加侦察动作，不减少任何文件改动。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。UI 结构定位错误本来就是必须立刻修正的问题。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准读取和编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有出现偷懒降级。
</decision_point>
  - 更新 step_1：移除 [`validateVectorMemoryConfig_ACU()`](src/service/vector/vector-memory-config.ts:230) 中的 rerank 致命校验，改为新增独立的 rerank 配置状态/校验函数。
  - 更新 step_3：在 [`recallVectorMemory_ACU()`](src/service/vector/vector-recall-service.ts:312) 中接入独立 rerank 校验；配置完整则调用真实 rerank，配置半填则将错误写入结果并回退启发式排序。
  - 其余 step_2、step_4、step_5、step_6 保持不变。
deviation_audit:
  original_plan_excerpt:
    - step_1: 扩展默认配置与配置类型，新增 rerankEndpoint、rerankApiKey、rerankModel 等字段，并在 normalize 与校验逻辑中加入“可选但自洽”的处理。
    - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径，并在异常时稳定回退。
  current_proposal:
    - step_1: 扩展默认配置与配置类型，新增 rerankEndpoint、rerankApiKey、rerankModel 等字段，并将 rerank 自洽校验实现为独立函数，而不是并入核心功能的致命校验。
    - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序；真实 rerank 仅在独立校验通过时启用，半填配置时记录错误并稳定回退。
  diff_summary:
    - 没有改变 rerank 作为“可选增强”的总体方向。
    - 只修正了 rerank 校验所在层级：从核心致命校验迁到独立可选校验。
    - 没有缩小 affected_scope，反而使 [`vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:181) 与 [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:312) 的职责更准确。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。当前修正提升了健壮性与可维护性，没有降低原方案评分。
    - 偏离是否导致 affected_scope 缩小？→ NO。没有砍掉任何文件或步骤。
degradation_check:
  - 推荐方案是否是三维评估综合最优的？ → YES。option_b 在可维护性、健壮性、可扩展性上都优于 option_a 和 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已明确区分“无 rerank 配置”和“半填 rerank 配置”的行为。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，option_b 比维持现状更复杂，但它是正确边界。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。affected_scope 未减少，核心文件仍全部覆盖。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。这个问题直接影响主功能可用性，已被纳入修正。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。仍使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。不存在偷懒或缩范围行为。
</decision_point>
---
<decision_point>
issue: 进一步读取 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245) 后确认，当前编排层把 [`recallResult.errors`](src/service/vector/vector-recall-service.ts:27) 视为严格阻断条件：只要 `recallErrors.length > 0` 就会终止发送前流程。因此，上一轮 decision_point 中“半填 rerank 配置时把错误写入 errors 并回退启发式排序”的方案并不成立，会导致整个向量流程被阻断。这是执行阶段才暴露的调用链语义问题，侦察阶段只看 [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:312) 本身无法完整推导。
impact: YES。它直接影响 rerank 降级策略的正确性：如果继续把 rerank 配置问题写进 [`errors`](src/service/vector/vector-recall-service.ts:27)，就会把“可选增强失败”升级成“主流程失败”，与用户目标相悖。
context_update:
  - 受影响字段: approach、edge_cases、execution_plan.step_3
  - 更新内容:
      - rerank 降级错误不能进入 [`VectorRecallResult_ACU.errors`](src/service/vector/vector-recall-service.ts:27)。
      - 需要新增非阻断告警通道，例如 [`warnings`](src/service/vector/vector-recall-service.ts:21) 或等价字段，让 orchestrator 只对真正召回失败的 errors 阻断，对 rerank 降级只做透传不阻断。
options:
  - option_a:
      description: 保持当前结果结构不变，继续把 rerank 降级原因写进 [`errors`](src/service/vector/vector-recall-service.ts:27)，同时修改 orchestrator 放宽对所有 recallErrors 的阻断条件。
      approach_evaluation:
        - 可维护性: 2/5 — 把“致命错误”和“可降级告警”继续混在一个字段里，语义长期混乱。
        - 健壮性: 3/5 — 通过编排层打补丁可暂时放行，但后续其他调用方仍可能误把 warnings 当 errors。
        - 可扩展性: 2/5 — 一旦未来增加更多非阻断问题，会继续在一个错误字段里堆积语义债务。
      edge_cases:
        - 其他现有依赖 `errors` 的代码可能被放宽逻辑误伤。
        - 需要重新定义 orchestrator 怎样区分“哪些 errors 可放行”，复杂且脆弱。
      affected_scope_delta:
        - 修改 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21)
        - 修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245)
  - option_b:
      description: 扩展 [`VectorRecallResult_ACU`](src/service/vector/vector-recall-service.ts:21) 新增 `warnings: string[]`，rerank 半填或 rerank 调用失败时只写入 warnings 并回退启发式排序；真正导致召回不可用的问题仍写入 errors。随后在 orchestrator 中透传 warnings，但保持只对 errors 阻断。
      approach_evaluation:
        - 可维护性: 5/5 — 致命错误与非阻断告警语义分离，调用链清晰。
        - 健壮性: 5/5 — 可选 rerank 失败不会打断主流程，同时真正的 embedding/召回失败仍会严格阻断。
        - 可扩展性: 5/5 — 后续再加入其他可降级问题，也有稳定的 warnings 通道可复用。
      edge_cases:
        - 所有 `return` 分支都必须补齐 `warnings`，否则类型不一致。
        - orchestrator 需要把 warnings 合并到总 errors 之外的独立字段，或至少不让 warnings 触发 block。
      affected_scope_delta:
        - 修改 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21)
        - 修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16)
  - option_c:
      description: 半填 rerank 配置时完全静默，不写 errors 也不写 warnings，只是内部回退启发式排序。
      approach_evaluation:
        - 可维护性: 2/5 — 表面简单，实则让错误配置失去可观测性。
        - 健壮性: 3/5 — 不会阻断主流程，但用户根本不知道 rerank 没生效。
        - 可扩展性: 2/5 — 未来排障会非常痛苦，因为没有任何信号链路。
      edge_cases:
        - 用户可能长期以为 rerank 生效，实际上系统一直在走旧逻辑。
      affected_scope_delta:
        - 修改 [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:21)
recommendation: 选择 option_b。它在三维评估上综合最优：通过单独的 `warnings` 通道把非阻断告警与致命错误拆开，既保证主功能稳定，又保留可观测性，还不会污染现有错误语义。
execution_plan_update:
  - 更新 step_3：先扩展 [`VectorRecallResult_ACU`](src/service/vector/vector-recall-service.ts:21) 增加 `warnings`，并补齐所有 return 分支；随后把 rerank 半填/失败场景写入 warnings，继续回退启发式排序。
  - 同步更新 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 的结果结构与聚合逻辑，确保 warnings 不触发阻断。
  - step_4、step_5、step_6 保持不变。
deviation_audit:
  original_plan_excerpt:
    - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径，并在异常时稳定回退。
  current_proposal:
    - step_3: 改造召回服务：保留现有 embedding 预筛选和启发式排序，新增真实 rerank 路径；通过 `warnings` 通道承载 rerank 半填或失败告警，避免其误触发编排层阻断；真正召回失败仍通过 `errors` 严格阻断。
  diff_summary:
    - 没有改变“真实 rerank + 稳定回退”的核心方案。
    - 新增了 `warnings` 结果通道，用于分离非阻断告警和致命错误。
    - affected_scope 新增纳入 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16) 的结构同步修改，这属于必要范围扩展，不是偏离需求。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。当前方案提升了可维护性与健壮性。
    - 偏离是否导致 affected_scope 缩小？→ NO。是合理扩大，不是砍范围。
degradation_check:
  - 推荐方案是否是三维评估综合最优的？ → YES。option_b 在可维护性、健壮性、可扩展性上均优于 option_a 与 option_c。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“warnings 不得触发 block”“所有 return 分支补齐 warnings”等新边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。option_b 反而改动更大，但边界正确。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。且新增必要覆盖 [`vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:16)。
    - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。当前问题直接影响 rerank 降级可用性，已纳入修正。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。不存在偷懒或缩范围行为。
</decision_point>
---
<output_quality_review>
task_summary: 为向量召回链路增加可选真实 Rerank 模型接入，补齐全局配置与 UI 输入/保存/回填链路，修正发送前编排层的 `warnings` / `errors` 语义，并完成类型级验证。

deliverables:
  - modified: [`src/shared/defaults.ts`](src/shared/defaults.ts)
  - modified: [`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts)
  - created: [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts)
  - modified: [`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts)
  - modified: [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)
  - modified: [`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts)
  - modified: [`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts)
  - modified: [`src/presentation/components/status-display.ts`](src/presentation/components/status-display.ts)
  - process_artifact: [`.analysis-cache.md`](.analysis-cache.md)

metrics:
  total_files_modified: 9 — 8 个业务文件 + 1 个决策缓存文件
  execution_plan_coverage: 6/6 = 100% — [`.analysis-cache.md`](.analysis-cache.md) 中的 `step_1` 到 `step_6` 均已落地
  edge_cases_handled: 9/9 = 100% — analysis 中列出的 rerank 缺失、半填、异常回退、候选过少、旧配置迁移、[`recallCandidateLimit >= topK`](src/service/vector/vector-memory-config.ts:236)、UI 三处同步、文案纠偏等边界已全部覆盖
  confidence_assessment: MEDIUM — 已通过 [`npm run typecheck`](package.json:15) 完成结构与类型闭环验证，但仍缺 2 个运行期实机验证：真实 rerank provider 在线 smoke test、插件弹窗 UI 的人工渲染检查

substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。每个产物都直接改变了系统行为或可维护性：[`src/shared/defaults.ts`](src/shared/defaults.ts) 提供 rerank 默认值；[`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts) 扩展类型、normalize 与独立 rerank 校验；[`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts) 新增真实 HTTP rerank 调用；[`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts) 接入真实 rerank 与启发式回退；[`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts) 透传非阻断 `warnings`；[`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts)、[`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts)、[`src/presentation/components/status-display.ts`](src/presentation/components/status-display.ts) 共同闭合 UI 输入、保存与回填链路。删掉其中任一项，功能就会残缺，不存在装样子的空壳文件。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → NO。当前交付物不是伪装成“已支持 rerank”的文案补丁，而是直接插入运行路径的实现；如果故意改坏 rerank 配置校验、候选回退、`warnings` 透传或 UI selector 对齐，现有代码会立即在结构层面与 [`npm run typecheck`](package.json:15) 的验证、以及模块间字段对接中暴露错配。需要诚实指出的是：本轮没有新增行为级自动化测试，因此对“纯逻辑但不破坏类型”的未来回归，探测能力仍弱于理想状态，这也是置信度维持 MEDIUM 的原因。
  - 实质性比率: 9/9 = 100%

completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。analysis 的 [`affected_scope`](.analysis-cache.md) 中 8 个业务文件已全部覆盖，没有把难改的 UI/配置/调用链环节偷偷砍掉。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。已完整覆盖 [`src/shared/defaults.ts`](src/shared/defaults.ts)、[`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts)、[`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts)、[`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts)、[`src/presentation/pages/main-popup-table.ts`](src/presentation/pages/main-popup-table.ts)、[`src/presentation/pages/popup-bindings-worldbook.ts`](src/presentation/pages/popup-bindings-worldbook.ts)、[`src/presentation/components/status-display.ts`](src/presentation/components/status-display.ts)，并额外补齐了必需的 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。直接验证证据包括：[`npm run typecheck`](package.json:15) 验证了 rerank 字段、返回结构与 UI 选择器接线的类型闭环；[`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:186) 明确验证 rerank 仅在配置自洽时启用；[`src/service/vector/vector-memory-config.ts`](src/service/vector/vector-memory-config.ts:236) 明确兜住 `recallCandidateLimit` 不能小于 `topK`；[`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:73) 与 [`src/data/gateways/vector-rerank-gateway.ts`](src/data/gateways/vector-rerank-gateway.ts:82) 对空 endpoint / model / documents 做防御；[`src/service/vector/vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:323) 将真实 rerank、空结果、异常回退与 warning 聚合接到主流程；[`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts:245) 保证 warning 不阻断发送前流程。
  - affected_scope 覆盖率: 8/8 = 100%

value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 9:0，高价值占比 100%。所有产物都在处理真实 rerank 接入、配置语义重构、降级回退、调用链闭环或 UI 配置落地，没有拿 trivial 改动凑数。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。文件数虽然不少，但每一项都对应 analysis 中的一个硬性缺口；少任何一项，都会留下真实断点。

alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足的是本质需求。用户要的不只是“UI 上能填 rerank 模型”，而是向量功能真正支持 rerank、原有配置不再语义混乱、旧能力不被错误打废。当前实现既补了真实 rerank 调用，又把 [`topK`](src/presentation/pages/main-popup-table.ts:160)、[`minScore`](src/presentation/pages/main-popup-table.ts:165)、[`recallCandidateLimit`](src/presentation/pages/main-popup-table.ts:170) 的职责重新界定为“最终保留数”和“embedding 预筛参数”，并明确没有草率取消仍然有作用的配置项。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。在当前可用验证条件下，这版代码达到可交付标准：结构闭环、边界明确、类型检查通过、没有把 rerank 变成对老配置的破坏性升级。它还不配叫“完美”，因为缺少真实 provider 的在线 smoke test 和 UI 人工渲染确认，所以整体置信度仍是 MEDIUM，但已经不是那种看似支持、实际一碰就碎的半成品。
</output_quality_review>
---
<decision_point>
issue: 在把新的 `<analysis>` 持久化到 [`.analysis-cache.md`](.analysis-cache.md) 时，我错误地使用了“空 `old_string` = 创建文件”的方式，结果工具直接报出“文件已存在”。这不是方案问题，而是执行期工具参数错误：当前文件已经存在，正确动作应是基于现有内容追加，而不是再次创建。
impact: NO。它不影响“用户输入 + 关键词联合用于 chunk 匹配”的技术方案正确性，但会阻断本轮流程合规性；如果不修正，就会在未完成缓存持久化的情况下继续改代码，直接违反当前工作流要求。
context_update: 受影响字段包括 `execution_plan` 的执行顺序与流程持久化步骤。更新内容是：在继续修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts) 前，必须先读取 [`.analysis-cache.md`](.analysis-cache.md) 的尾部内容，选取唯一锚点，把本轮 `<analysis>` 追加进去。
options:
  - option_a:
      description: 先读取 [`.analysis-cache.md`](.analysis-cache.md) 的末尾上下文，找到唯一尾部锚点，再把本轮 `<analysis>` 逐字追加到现有文件末尾。
      approach_evaluation: 可维护性 5/5——符合当前缓存文件的真实状态；健壮性 5/5——避免再次把“追加”误当“创建”；可扩展性 4/5——后续继续追加 decision_point/验收报告时也能复用同一策略。
      edge_cases: 需要确保读取范围覆盖文件最后一个结构块的结尾，否则锚点仍可能不唯一。
      affected_scope_delta: 仅影响 [`.analysis-cache.md`](.analysis-cache.md) 的持久化步骤，不改变业务文件范围。
  - option_b:
      description: 放弃持久化，直接继续修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，等代码改完后再回头补写缓存。
      approach_evaluation: 可维护性 1/5——违反流程要求；健壮性 1/5——执行中再次出现问题时，新的分析上下文会丢失；可扩展性 1/5——后续追溯这轮决策会断链。
      edge_cases: 一旦中途再发生 decision_point，缓存会出现“有执行、没分析”的断层。
      affected_scope_delta: 表面不新增文件，但会让 [`.analysis-cache.md`](.analysis-cache.md) 与真实执行状态脱节。
  - option_c:
      description: 直接用 [`write_to_file()`](.analysis-cache.md) 全量覆盖 [`.analysis-cache.md`](.analysis-cache.md)，把新 analysis 重写进去。
      approach_evaluation: 可维护性 1/5——会抹掉前一轮完整决策链；健壮性 1/5——历史记录丢失；可扩展性 1/5——等于把归档价值直接废掉。
      edge_cases: 之前的 analysis、decision_point、验收记录都会被覆盖消失。
      affected_scope_delta: 影响 [`.analysis-cache.md`](.analysis-cache.md) 全文件内容，风险远高于需要。
recommendation: 选 option_a。它是三维评估综合最优的方案：精确追加、保留历史、符合当前工具语义。option_b 是流程违规，option_c 则是直接破坏历史记录。
execution_plan_update: 在执行原定 `step_1` 前，先读取 [`.analysis-cache.md`](.analysis-cache.md) 文件末尾，选取唯一锚点，把本轮 `<analysis>` 逐字追加进去；随后再修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts) 的联合召回查询逻辑，后续步骤不变。
deviation_audit:
  original_plan_excerpt: “step_1: 修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，新增一个构造联合召回查询的辅助函数，负责把原始用户输入和关键词去重后拼接为单一 query。”
  current_proposal: “在执行 step_1 前，先把本轮 `<analysis>` 追加到 [`.analysis-cache.md`](.analysis-cache.md)；随后修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，新增联合召回查询辅助函数。”
  diff_summary: 没有改变业务实现方向，只是在正式改代码前补上一次必须的缓存持久化动作，修正执行期工具参数错误。
  deviation_motive_check:
    - 结论：未命中需要替换的偷懒措辞；这次偏离是为了修复流程持久化错误，不是为了缩减业务实现。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。新增持久化修正步骤只会提高流程健壮性。
    - 偏离是否导致 affected_scope 缩小？→ NO。业务目标文件仍然是 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_a 既保留历史记录，又避免再次因工具参数错误中断流程。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“缓存文件已存在，不能再按创建方式写入”的执行期边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，是拒绝 option_b 这种图快但违规的路径。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。业务文件与流程文件都覆盖到了。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。缓存持久化失败就是当前必须修正的问题。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有出现偷懒降级。
</decision_point>
---
<decision_point>
issue: 为了给 [`.analysis-cache.md`](.analysis-cache.md) 追加本轮 `<analysis>`，我又一次用拍脑袋的高行号去读取文件尾部，结果再次触发越界。问题根因已经很明显：当前缓存文件的真实长度未知，继续靠猜测末尾范围只会反复制造读取失败。
impact: NO。它不影响“原始用户输入 + 关键词联合参与 chunk 匹配”的业务方案本身，但会继续阻断流程持久化。如果不修正，后续执行将建立在不完整的缓存状态上。
context_update: 受影响字段是 `execution_plan` 的持久化前置动作。更新内容是：不能再通过估计行号定位文件尾部，必须改用“读取较小已知范围 + 以唯一尾部文本为锚点”或“读取全文件后选取尾部上下文”的方式。
options:
  - option_a:
      description: 改为读取 [`.analysis-cache.md`](.analysis-cache.md) 的一个中等范围并结合已知末尾结构，选取最后一个已确认出现的唯一尾部文本作为锚点，再进行追加。
      approach_evaluation: 可维护性 4/5——不再依赖拍脑袋行号；健壮性 4/5——如果锚点足够唯一，可稳定追加；可扩展性 4/5——适用于当前缓存规模。
      edge_cases: 若选择的尾部文本在文件中重复出现，仍可能命中不唯一。
      affected_scope_delta: 仅影响 [`.analysis-cache.md`](.analysis-cache.md) 的读取与追加步骤。
  - option_b:
      description: 直接读取 [`.analysis-cache.md`](.analysis-cache.md) 全文件，然后以最后一个完整结构块的结尾作为锚点追加本轮 `<analysis>`。
      approach_evaluation: 可维护性 5/5——基于完整文件内容做判断，最不容易误判；健壮性 5/5——能彻底避免“末尾在哪”这种猜测问题；可扩展性 4/5——对当前文件规模完全可接受。
      edge_cases: 文件更大时读取成本更高，但当前规模仍在可控范围。
      affected_scope_delta: 仅影响 [`.analysis-cache.md`](.analysis-cache.md) 的持久化步骤。
  - option_c:
      description: 不再执着于缓存持久化，直接修改业务文件，事后再把结果总结写回缓存。
      approach_evaluation: 可维护性 1/5——流程违规；健壮性 1/5——中途如果再出意外，分析上下文会断链；可扩展性 1/5——后续无法可靠追溯这轮变更的决策依据。
      edge_cases: 一旦业务修改过程中再出现 decision_point，就会彻底失去这轮 analysis 的前后关系。
      affected_scope_delta: 表面不新增范围，实则让 [`.analysis-cache.md`](.analysis-cache.md) 与真实执行状态脱节。
recommendation: 选 option_b。它在可维护性、健壮性、可扩展性上综合最优。继续猜末尾范围纯属重复犯错，不是执行。
execution_plan_update: 在继续修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts) 前，先完整读取 [`.analysis-cache.md`](.analysis-cache.md)，基于真实末尾内容把本轮 `<analysis>` 逐字追加进去；然后再执行原定 `step_1` 到 `step_4`。
deviation_audit:
  original_plan_excerpt: “step_1: 修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，新增一个构造联合召回查询的辅助函数，负责把原始用户输入和关键词去重后拼接为单一 query。”
  current_proposal: “在执行 step_1 前，先完整读取 [`.analysis-cache.md`](.analysis-cache.md) 并追加本轮 `<analysis>`；随后修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，新增联合召回查询辅助函数。”
  diff_summary: 没有改变业务方向，只是在改代码前补上一次更可靠的缓存持久化动作，并把错误的‘猜末尾行号’策略替换为‘读取全文件后精确追加’。
  deviation_motive_check:
    - 结论：未命中需要替换的偷懒措辞；这是对执行期读取策略的修正，不是范围缩减。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。改成全文件读取后，流程更稳。
    - 偏离是否导致 affected_scope 缩小？→ NO。业务目标文件仍未变化。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 基于完整文件内容定位锚点，最不容易再出同类错误。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“重复猜测末尾范围导致读取失败”的执行期边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，是拒绝继续图省事地猜范围。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。业务文件和缓存文件都仍在计划内。
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。缓存持久化失败正在被直接处理。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。继续使用标准读取/编辑工具。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有出现偷懒降级。
</decision_point>
---
<analysis>
context:
  - 当前发送前向量召回编排在 [`orchestrateVectorRecallBeforeSend_ACU()`](src/service/plot/vector-recall-orchestrator.ts:146) 中，流程是：读取原始用户输入 `signature` → 调用 [`generateVectorRecallKeywords_ACU()`](src/service/vector/vector-recall-keyword-service.ts:117) 生成关键词 → 取 [`keywordResult.keywords`](src/service/vector/vector-recall-keyword-service.ts:168) 作为唯一的 `recallQuery` → 调用 [`recallVectorMemory_ACU(recallQuery, ...)`](src/service/plot/vector-recall-orchestrator.ts:247)。
  - 当前关键词生成服务 [`generateVectorRecallKeywords_ACU()`](src/service/vector/vector-recall-keyword-service.ts:117) 在失败或结果为空时，会回退为原始用户输入，并把 [`usedFallback`](src/service/vector/vector-recall-keyword-service.ts:23) 设为 `true`；而编排层在 [`orchestrateVectorRecallBeforeSend_ACU()`](src/service/plot/vector-recall-orchestrator.ts:228) 中把“回退到原始输入”视为严格阻断，因此正常成功路径下，召回阶段永远只使用“关键词文本”，不会同时保留原始用户输入。
  - 当前向量召回服务 [`recallVectorMemory_ACU()`](src/service/vector/vector-recall-service.ts:359) 只接收一个 `queryTextInput`。这个文本被 [`normalizeQueryText_ACU()`](src/service/vector/vector-recall-service.ts) 规整后，同时用于两个关键位置：一是 [`createEmbeddings_ACU({ input: [queryText] })`](src/service/vector/vector-recall-service.ts:419) 生成查询 embedding；二是 [`collectRuleMatchedBatches_ACU(state, queryText)`](src/service/vector/vector-recall-service.ts:439) 做本地规则命中与词项加权。也就是说，query 一旦改变，会同时影响 chunk 向量预筛和 batch 规则加权两个阶段。
  - 当前真实 rerank 接入也复用同一个 `queryText`：[`createRerankScores_ACU({ query: queryText, ... })`](src/service/vector/vector-recall-service.ts:450)。因此如果把“用户输入 + 关键词”合并成新的召回查询，不仅 embedding 匹配会变，rerank 查询也会同步变。
  - 用户这次新增的要求是“现在向量关键词生成后，将用户输入和关键词一起与chunk进行匹配”。这句话的重点是“与 chunk 进行匹配”，不是“替换关键词生成逻辑”，也不是“只改规则匹配”。如果只把原始输入加入本地规则匹配而不加入 embedding 查询，就只改了 batch 级 boost，不符合“与 chunk 匹配”的直观含义。
  - 当前链路里最合理的插入点是在编排层拿到 `keywordResult.keywords` 之后，构造“原始用户输入 + 关键词”的联合召回查询，再把这个联合文本传入 [`recallVectorMemory_ACU()`](src/service/plot/vector-recall-orchestrator.ts:247)。这样既能让 embedding 对 chunk 的召回同时看到两类信息，也能让后续 rerank 使用同一查询语义，保持链路一致。

needs:
  - 在关键词生成成功后，构造一个同时包含“原始用户输入”和“关键词”的联合召回查询。
  - 保证这个联合查询真正用于 chunk embedding 匹配，而不是只停留在规则层或文案层。
  - 保持现有严格策略不变：关键词生成失败或 fallback 到原始输入时，仍然阻断，不把“原始输入兜底”偷偷放进正常成功链路。
  - 控制实现粒度，避免把 query 拼接逻辑散落到 [`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:359) 内部，导致服务层同时承担“查询构造”和“召回执行”两种职责。
  - 检查联合查询引入后是否会影响 rerank 查询语义与 warning/error 流程，并做最小但正确的验证。

key_challenges:
  - query 在当前实现中同时驱动 embedding 预筛、规则匹配、rerank 查询；改动位置选错，就会让不同阶段看到不同 query，产生结果不可解释的问题。
  - 如果把拼接逻辑写进 [`recallVectorMemory_ACU()`](src/service/vector/vector-recall-service.ts:359)，服务层就必须额外知道“原始用户输入”和“关键词”两个来源，职责会变脏。
  - 联合查询必须处理去重和空值，否则很容易出现“原始输入和关键词完全相同却重复拼接”的低质量实现。
  - 需要避免误伤现有严格阻断语义：用户要求的是“关键词生成成功后额外加入原始输入”，不是“允许关键词失败后直接拿原始输入继续召回”。

confidence: HIGH
approach:
  选择的方案是在 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts) 中新增一个小型查询构造函数，把原始用户输入 `signature` 与成功生成的 `recallQuery` 组合为联合召回查询，再将该联合查询传给 [`recallVectorMemory_ACU()`](src/service/plot/vector-recall-orchestrator.ts:247)。这样做的理由是：查询来源的组合属于编排层职责，召回服务继续只负责“拿到 query 后执行 embedding 预筛、规则匹配和 rerank”；同时由于 [`recallVectorMemory_ACU()`](src/service/vector/vector-recall-service.ts:359) 全链路都复用同一个 `queryText`，联合查询会自然同时作用于 chunk 匹配和 rerank 查询，不需要在多个阶段分别补丁。
  
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 5/5 — 查询构造留在编排层，[`vector-recall-service.ts`](src/service/vector/vector-recall-service.ts:359) 不新增来源感知逻辑，职责边界清晰。
  - 健壮性: 4/5 — 通过统一联合查询保证 embedding / 规则 / rerank 看到同一输入；仍需做好去重与空值处理，避免重复拼接。
  - 可扩展性: 5/5 — 后续若还要加入“上下文摘要词”“手动补充关键词”等来源，只需扩展编排层的查询构造函数，不必重写召回服务。

edge_cases:
  - 当原始用户输入与关键词文本完全相同或高度相同（例如关键词生成结果直接等于原始输入）时，联合查询不能重复拼接出冗余文本，否则会无意义放大某些词项。
  - 当原始用户输入非空、关键词非空时，联合查询必须稳定包含两者，不能因为 trim 或分隔符处理错误丢掉任意一方。
  - 当关键词生成失败或回退到原始输入时，仍应保持现有阻断逻辑，不得借这次优化偷偷放宽 gate。
  - 联合查询改变后，[`createEmbeddings_ACU()`](src/service/vector/vector-recall-service.ts:419)、[`collectRuleMatchedBatches_ACU()`](src/service/vector/vector-recall-service.ts:439) 和 [`createRerankScores_ACU()`](src/service/vector/vector-recall-service.ts:450) 都会看到新 query；这必须是有意的一致行为，而不是副作用。
  - 如果联合查询构造函数返回空字符串，编排层必须仍受现有空 query 保护，不得把空文本送入召回服务。

affected_scope:
  - src/service/plot/vector-recall-orchestrator.ts
  - .analysis-cache.md

execution_plan:
  - step_1: 修改 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，新增一个构造联合召回查询的辅助函数，负责把原始用户输入和关键词去重后拼接为单一 query。
  - step_2: 在 [`orchestrateVectorRecallBeforeSend_ACU()`](src/service/plot/vector-recall-orchestrator.ts:146) 中，保留现有关键词生成失败/回退阻断逻辑不变，仅在关键词生成成功后，用联合查询替换当前只使用 `recallQuery` 的调用方式。
  - step_3: 运行类型检查验证这次变更未引入新的 TS 回归，并确认不会破坏现有 rerank 接口与编排结果结构。
  - step_4: 完成验收，明确说明“现在 chunk 匹配使用的是原始用户输入 + 关键词联合查询”，并归档本轮决策。

degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。它把查询构造放在编排层，避免污染召回服务职责，同时让 embedding / 规则 / rerank 统一消费同一联合 query。
  - 是否遗漏了已知边界条件？ → NO。已覆盖去重、空值、关键词回退仍阻断、联合查询影响全链路等关键边界。
  - 是否因改动量大而想缩减方案？ → NO。用户要求的是“与 chunk 一起匹配”，只改规则层属于偷工减料。
  - 是否打算跳过某些文件？ → NO。本轮真正需要改的业务文件只有 [`src/service/plot/vector-recall-orchestrator.ts`](src/service/plot/vector-recall-orchestrator.ts)，没有伪造额外范围，也没有漏掉必须同步的地方。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。业务改动与流程归档文件都已覆盖。
  - context是否充分？是否有未读但可能相关的文件？ → NO。已读取关键词生成、编排层、召回服务三处核心链路，足够支持这次改动。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。query 同时驱动 embedding / 规则 / rerank 这件事已经纳入方案核心，没有被回避。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源码修改继续使用标准编辑工具。
</analysis>
---
<analysis>
context:
  - 当前仍然对外显示“SP·数据库 I”的源码位置已经确认有 4 处：主弹窗标题在 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)，扩展菜单入口文本在 [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)，实例互斥提示在 [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)，油猴初始化冲突提示在 [`src/index.ts`](src/index.ts:95)。这些都属于用户可见的 UI / 提示界面，不改全就会出现一半 II、一半 I 的撕裂状态。
  - 当前主清单 [`manifest.json`](manifest.json) 的 `display_name` 还是 “SP·数据库”，`version` 是 `1.7.0`；并行清单 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json) 的 `display_name` 是 “SP·数据库 I + AI 改表助手”，`version` 是 `1.1.0`。用户要求把 manifest 改成 `2.0.0`，如果只改一个清单，双形态元数据会继续分裂。
  - 当前工作分支已经确认是 `main`，但工作区是 dirty 状态；这点不是细节，而是发布正确性的核心前提。
  - 发布脚本 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102) 在构建前会先 `stash` 全部工作区改动，然后才在 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:111) 构建 extension 产物。这意味着如果直接运行该脚本，它会从“干净的旧 HEAD”构建，而不是从当前这批未提交的新修改构建。也就是说，直接跑脚本会把旧代码推到 release，完全违背这次发版目的。
  - 同一个脚本会在成功后切回来源分支，位置在 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:149)。由于当前来源分支就是 `main`，只要发布流程从 `main` 起步，最终切回 `main` 这条要求是可满足的。
  - 标准 extension 制品的正确目标不是随便一个 JS 文件，而是 [`dist/extension/index.js`](dist/extension/index.js) 和 [`dist/extension/manifest.json`](dist/extension/manifest.json)。这一点在 [`标准extension构建与发布说明.md`](标准extension构建与发布说明.md:70) 里已经写得很清楚。
  - 当前 shell 是 Windows 的 [`cmd.exe`](package.json:7) 环境，而 [`package.json`](package.json:11) 里的 [`build:extension`](package.json:11) 使用的是 Unix 风格的 `BUILD_MODE=extension` 前缀；文档 [`标准extension构建与发布说明.md`](标准extension构建与发布说明.md:118) 也明确说明在 Windows 里应改用 PowerShell 方式设置环境变量。也就是说，不能想当然地直接跑 [`npm run build:extension`](package.json:11) 并假定它一定可靠。

needs:
  - 把当前所有运行时 UI / 提示界面中的“SP·数据库 I”统一改成“SP·数据库 II”。
  - 把 [`manifest.json`](manifest.json) 的版本号改为 `2.0.0`，并同步处理并行清单 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json)，避免版本和显示名裂成两套。
  - 生成真正的标准 extension release 制品 [`dist/extension/index.js`](dist/extension/index.js) 与 [`dist/extension/manifest.json`](dist/extension/manifest.json)，而不是只生成普通 bundle。
  - 将本轮修改对应的 release 制品推送到 `release` 分支，并在完成后回到 `main`。
  - 确保发布使用的是“当前这轮修改后的代码”，而不是 stash 后的旧提交内容。

key_challenges:
  - 最大的技术陷阱是 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102) 的“先 stash 再 build”顺序。当前工作区本来就是 dirty，如果直接执行，发布出去的就是旧版本制品，不是这轮改动。
  - 需要区分“源码中的真实用户可见名称”和“历史文档 / 归档 / 已生成 dist 产物”。用户要的是当前产品显示与 release，不是去篡改历史归档。
  - [`manifest.json`](manifest.json) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json) 现在本来就不一致；这次如果只改主清单，问题不会消失，只会继续拖着。
  - 当前是 Windows 环境，[`package.json`](package.json:11) 的 Unix 风格构建脚本不能盲信；发布命令必须按环境选对执行方式。
  - 发版流程除了“构建”还有“切分支 / 覆盖产物 / commit / push / 切回 main / 恢复工作区”。任何一步草率，最后都会留下脏分支、错误产物或难以恢复的现场。

confidence: MEDIUM
approach:
  选择的方案是：先修改源码中的 UI / 提示文案与两个 manifest 元数据；然后用 PowerShell 方式构建标准 extension 制品；接着采用“先构建当前工作区产物，再 stash 工作区、切到 `release`、覆盖根目录产物并提交推送、最后切回 `main` 再恢复 stash”的手动发布链，而不是直接运行 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102)。原因很直接：当前脚本的顺序会把未提交改动排除出构建结果，直接使用它会发布错版本。
  
  三维评分（每个维度 1-5 分，5 为最优）：
  - 可维护性: 4/5 — 不改发布脚本本身，保持仓库长期规则稳定；同时明确只修改真实运行时名称、两个 manifest 与标准制品链路，范围清晰。
  - 健壮性: 5/5 — 先构建当前工作区产物，再 stash / checkout / push，能确保 release 内容对应这次实际修改，而不是旧 HEAD；同时最终还能切回 `main` 并恢复现场。
  - 可扩展性: 4/5 — 后续如果还要继续发未提交工作区版本，这套手动链路可以复用；如果以后决定把脚本升级为“支持 dirty-tree release”，也能基于这次结论再抽象。

edge_cases:
  - 如果本地不存在 `release` 分支，发布流程必须在切分支前中止并报错，不能临场瞎切。
  - 如果远端认证失败或 `git push` 被拒绝，必须保留当前工作区与临时制品，不得把分支状态留在 `release` 上不收尾。
  - 如果只修改 [`manifest.json`](manifest.json) 而不修改 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json)，产品显示名和版本会继续分裂，后续维护者会被两套元数据误导。
  - 如果仍然误用 [`npm run build:extension`](package.json:11) 这种依赖 Unix 环境变量前缀的脚本，Windows 下可能根本没进 extension 模式，最终产物就不是正确的 release 制品。
  - 如果漏改任一处源码中的“SP·数据库 I”，构建后的 [`dist/extension/index.js`](dist/extension/index.js) 仍会带旧名称，用户界面会直接露馅。
  - 如果发布前不验证 [`dist/extension/manifest.json`](dist/extension/manifest.json) 的版本号与 [`dist/extension/index.js`](dist/extension/index.js) 中的名称文本，就可能把半改状态推上 release。
  - 由于本轮不打算先提交 `main` 源码，发布完成后切回 `main` 时，工作区应恢复为“包含本轮源码修改的 dirty 状态”；这是预期行为，不是异常。

affected_scope:
  - [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts)
  - [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts)
  - [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts)
  - [`src/index.ts`](src/index.ts)
  - [`manifest.json`](manifest.json)
  - [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json)
  - [`dist/extension/index.js`](dist/extension/index.js)
  - [`dist/extension/manifest.json`](dist/extension/manifest.json)
  - [`.analysis-cache.md`](.analysis-cache.md)

execution_plan:
  - step_1: 修改 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)、[`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)、[`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)，把所有当前运行时可见的 “SP·数据库 I” 统一替换为 “SP·数据库 II”。
  - step_2: 修改 [`manifest.json`](manifest.json:1) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1)，统一显示名并把版本号提升到 `2.0.0`，避免主清单与并行清单继续分裂。
  - step_3: 运行类型检查与标准 extension 构建；构建时不盲用 [`package.json`](package.json:11) 的 Unix 风格脚本，而是按 [`标准extension构建与发布说明.md`](标准extension构建与发布说明.md:118) 使用 PowerShell 方式进入 extension 构建模式，产出 [`dist/extension/index.js`](dist/extension/index.js) 与 [`dist/extension/manifest.json`](dist/extension/manifest.json)。
  - step_4: 验证 release 制品：确认 [`dist/extension/manifest.json`](dist/extension/manifest.json) 的版本确实为 `2.0.0`，并确认 [`dist/extension/index.js`](dist/extension/index.js) 中的用户可见名称已变为 “SP·数据库 II”。
  - step_5: 执行手动发布链：先保存当前构建好的 extension 制品到临时位置，再 stash 当前工作区、切换到 `release` 分支、用制品覆盖 release 分支根目录的 [`index.js`](index.js) 与 [`manifest.json`](manifest.json)、提交并推送 `origin/release`。
  - step_6: 发布完成后切回 `main`，恢复 stash，确认当前分支确实回到 `main`，并保留本轮源码修改现场。
  - step_7: 进行最终验收与归档，明确记录这次没有直接使用 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102) 的原因是它会在 dirty 工作区场景下错误地发布旧版本。

degradation_check:
  - 方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。它在健壮性上明显优于“直接跑发布脚本”的错误方案，在可维护性上又避免为了单次发版去重写脚本本身，综合最优。
  - 是否遗漏了已知边界条件？ → NO。已覆盖 `release` 分支缺失、远端推送失败、Windows 构建方式、双 manifest 分裂、dirty-tree 发布错误、切回 `main` 与恢复现场等关键边界。
  - 是否因改动量大而想缩减方案？ → NO。用户要的是“改名 + 发 release + 推送 + 切回 main”，把发布链简化成“只改字符串不发版”或者“直接跑脚本碰碰运气”都属于低质量敷衍。
  - 是否打算跳过某些文件？ → NO。四个源码显示位、两个 manifest、两个 release 制品都在计划内，没有故意绕开麻烦点。
  - execution_plan是否覆盖affected_scope所有文件？ → YES。源码、清单、构建产物与流程缓存都已纳入执行范围。
  - context是否充分？是否有未读但可能相关的文件？ → NO。已经读取并确认了 UI 文案落点、两个 manifest、发布脚本、发布说明和当前 git 状态，足以支撑这次执行。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。发布脚本在 dirty 工作区下会构建旧版本这件事已经被明确纳入方案核心，没有被粉饰过去。
  - execution_plan中是否有步骤计划使用 shell 命令（sed/awk/perl）修改源代码？ → NO。源码与 manifest 修改将使用标准编辑工具；shell 只用于构建、校验与发布流程，不用于粗暴改源文件。
</analysis>
---
<decision_point>
issue: 我刚才试图用 [`multi_tool_use.parallel`](.skill-output-phrasing-engineering.md:450) 在同一条消息里并行执行多个 [`functions.edit_file()`](manifest.json:1) 修改，但当前环境明确要求“每次回复只能有一个工具调用”，结果只有第一个修改 [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43) 成功，剩余对 [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)、[`manifest.json`](manifest.json:1)、[`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1) 的修改全部未执行。这是在执行阶段才暴露的工具行为约束冲突，侦察和分析阶段虽然知道“单次只能一个工具”，但我在实际调用时违反了它。
impact: YES。它直接影响当前方案的执行正确性：如果不把这个偏差明确纠正，后续构建和 release 会基于“只有部分名称被改、manifest 还没同步”的半成品状态进行，最终发布结果会错误。
context_update:
  - 受影响字段: execution_plan.step_1、execution_plan.step_2
  - 更新内容:
      - step_1 与 step_2 不能再尝试并行编辑，必须串行逐文件完成。
      - 当前已确认成功的新增修改只有 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121) 与 [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43) 两处；其余目标文件仍处于未修改状态。
options:
  - option_a:
      description: 忽略这次并行失败，直接进入类型检查和构建，寄希望于剩余文件其实“不重要”或稍后再补。
      approach_evaluation: 可维护性 1/5——把执行事实和计划状态故意混淆；健壮性 1/5——release 会直接带着半改状态；可扩展性 1/5——后续排查为什么 UI 名称和 manifest 版本不一致会非常难看。
      edge_cases:
        - [`dist/extension/index.js`](dist/extension/index.js) 里会同时出现 “SP·数据库 I” 和 “SP·数据库 II”。
        - [`dist/extension/manifest.json`](dist/extension/manifest.json) 仍可能保留旧版本号或旧显示名。
      affected_scope_delta:
        - 表面不新增文件，但实际上放任 [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)、[`manifest.json`](manifest.json:1)、[`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1) 继续漏改
  - option_b:
      description: 立刻修正执行策略，按单工具约束串行完成剩余四个文件的编辑；每次只改一个文件，直到 [`execution_plan.step_1`](.analysis-cache.md) 和 [`execution_plan.step_2`](.analysis-cache.md) 的所有目标都真正完成，再进入构建。
      approach_evaluation: 可维护性 5/5——与当前工具约束一致，执行状态清晰可追踪；健壮性 5/5——能确保所有必要文件都真的改到位后再构建 release；可扩展性 4/5——虽然消息轮次更多，但流程稳定，不会再发生“以为改了其实没改”的错觉。
      edge_cases:
        - 需要严格区分“已修改成功”和“仅计划修改”。
        - 在串行编辑超过 5 次工具调用后，要按技能要求回读 [`.analysis-cache.md`](.analysis-cache.md) 刷新记忆。
      affected_scope_delta:
        - affected_scope 不变
        - 仅将执行方式从错误的并行调用改为逐文件串行调用
  - option_c:
      description: 改用一次性重写多个文件的方式，例如先读取所有目标文件再用 [`functions.write_to_file()`](manifest.plus-assistantembedded.json:1) 全量覆盖，以减少工具调用次数。
      approach_evaluation: 可维护性 2/5——对小文件还勉强可控，但会无意义提高覆盖风险；健壮性 2/5——一旦抄错一行就是整文件污染；可扩展性 2/5——不是解决工具约束，而是在绕路。
      edge_cases:
        - 全量重写时极易把未改动内容一并写坏。
        - 当前有的文件并不需要整文件重建，用重写方式只会扩大错误面。
      affected_scope_delta:
        - 不改变文件范围，但会把编辑风险从精确替换提升到整文件覆盖
recommendation: 选择 option_b。它在三维评估上综合最优：可维护性最高，因为执行状态最清晰；健壮性最高，因为能确保所有目标文件实际改完后再构建；可扩展性也优于用整文件重写去绕工具约束。没有任何客观技术阻碍要求我放弃它。
execution_plan_update:
  - 保持原有 `step_1` 与 `step_2` 的目标不变，但将执行方式明确改为：按单工具约束串行修改 [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)、[`manifest.json`](manifest.json:1)、[`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1)。
  - 在所有剩余文件修改完成并确认成功前，不进入 [`step_3`](.analysis-cache.md) 的类型检查与 extension 构建。
deviation_audit:
  original_plan_excerpt:
    - step_1: 修改 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)、[`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)、[`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)，把所有当前运行时可见的 “SP·数据库 I” 统一替换为 “SP·数据库 II”。
    - step_2: 修改 [`manifest.json`](manifest.json:1) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1)，统一显示名并把版本号提升到 `2.0.0`，避免主清单与并行清单继续分裂。
  current_proposal:
    - step_1: 已完成 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121) 与 [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43) 的修改；接下来按单工具约束串行修改 [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99) 与 [`src/index.ts`](src/index.ts:95)，将运行时可见的 “SP·数据库 I” 全部替换为 “SP·数据库 II”。
    - step_2: 按单工具约束串行修改 [`manifest.json`](manifest.json:1) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:1)，统一显示名并把版本号提升到 `2.0.0`。
  diff_summary:
    - 没有删除任何原计划中的目标文件。
    - 没有降低任何功能或发布要求。
    - 仅把错误的“单消息并行多工具”执行方式，修正为符合环境约束的“逐文件串行编辑”。
  deviation_motive_check:
    - 措辞替换规则逐类检查：全部未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。业务目标不变，只是把错误的执行手法修正为可行手法，健壮性反而更高。
    - 偏离是否导致 affected_scope 缩小？→ NO。一个文件都没砍，只是纠正执行路径。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 在当前“每次仅允许一个工具调用”的环境下，是唯一既符合约束又不降质的方案。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“只有首个并行编辑生效、其余文件未改”的执行期边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。相反，option_a 才是图快的烂做法，我拒绝它。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。所有原定目标文件仍在计划内。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。并行调用失败不是小问题，已经被当场纳入修正。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。仍然使用标准编辑工具，不会用 shell 命令粗暴改源文件。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有缩 scope、降质量或回避复杂度。
</decision_point>
---
<decision_point>
issue: 在最终验收阶段读取 [`dist/index.bundle.js`](dist/index.bundle.js:97) 时，发现普通 JS bundle 产物仍然保留旧的 “SP·数据库 I” 文本，包括 [`checkAndMarkInstance()`](dist/index.bundle.js:94) 的实例互斥提示、[`createACUWindow()`](dist/index.bundle.js:43588) 的窗口标题、[`menuItemHTML`](dist/index.bundle.js:43671) 的菜单文案以及油猴初始化冲突提示 [`console.warn()`](dist/index.bundle.js:50272)。这是执行阶段才暴露的问题，因为本轮构建只按 [`execution_plan.step_3`](.analysis-cache.md:690) 生成并验证了 extension 制品 [`dist/extension/index.js`](dist/extension/index.js:43576)，没有重新生成普通 bundle [`dist/index.bundle.js`](dist/index.bundle.js:43590)。
impact: YES。它影响当前交付的一致性：虽然 `release` 分支已经正确推送 extension 制品，但当前 `main` 工作区中的普通 JS bundle 仍是旧名称。如果现在结束，本地源码、extension 制品和普通 bundle 会形成三套状态，验收结论会失真。
context_update:
  - 受影响字段: affected_scope、execution_plan.step_3、execution_plan.step_7
  - 更新内容:
      - affected_scope 需要新增 [`dist/index.bundle.js`](dist/index.bundle.js:97)。
      - 在完成 release 推送并切回 `main` 后，还需要补做普通 bundle 的本地重建与校验，确保“SP·数据库 II”在非 extension 产物中也同步落地。
options:
  - option_a:
      description: 忽略 [`dist/index.bundle.js`](dist/index.bundle.js:97) 的旧文本，认为用户本轮只要求 release 推送，普通 bundle 不在当前范围内。
      approach_evaluation: 可维护性 1/5——会让工作区长期保留一份与源码不一致的旧产物；健壮性 1/5——后续任何人若直接使用 [`dist/index.bundle.js`](dist/index.bundle.js:43590)，看到的仍是旧名称；可扩展性 1/5——以后再区分“哪个产物是对的”只会更乱。
      edge_cases:
        - 用户后续如果直接取用 [`dist/index.bundle.js`](dist/index.bundle.js:43590)，会误以为这轮改名没有完全生效。
        - 验收报告会错误声称“所有 UI / 提示界面都已改为 II”。
      affected_scope_delta:
        - 表面不新增文件，但实际上故意放过 [`dist/index.bundle.js`](dist/index.bundle.js:97) 这份已知错误产物
  - option_b:
      description: 在 `main` 分支上补跑普通 bundle 构建脚本 [`npm run build:nocheck`](package.json:9)，重新生成 [`dist/index.bundle.js`](dist/index.bundle.js:97)，然后再次校验旧文本是否已经消失；不重新推送 `release`，因为 `release` 分支承载的是 extension 制品，已正确发布。
      approach_evaluation: 可维护性 5/5——让源码、普通 bundle、extension 制品三者重新一致；健壮性 5/5——修正了当前唯一残留的不一致产物，同时不对已正确的 `release` 分支做多余操作；可扩展性 4/5——后续如还需产出其他构建形态，也能沿用“各产物分别验证”的策略。
      edge_cases:
        - 需要确认重新构建普通 bundle 不会覆盖掉已恢复的工作区源码改动。
        - 验证时必须同时确认旧文本消失，而不只是看到部分 “II” 文本出现。
      affected_scope_delta:
        - 新增 [`dist/index.bundle.js`](dist/index.bundle.js:97) 到实际修正范围
        - execution_plan 需要补一条“回到 `main` 后重建普通 bundle 并校验”的步骤
  - option_c:
      description: 重新跑一遍完整发布流程：先重建普通 bundle，再重建 extension，并再次把 `release` 分支推送一遍，确保所有产物时间戳统一。
      approach_evaluation: 可维护性 2/5——把不需要重新发布的远端流程重新执行一遍，只会增加噪音；健壮性 3/5——理论上能覆盖更多产物，但对已经正确的 `release` 分支属于过度操作；可扩展性 2/5——会把“本地 bundle 一致性问题”和“release 发布问题”混成一团。
      edge_cases:
        - 额外一次远端 push 会制造不必要的发布噪音。
        - 重新执行发布链会再次经过 stash / checkout / restore，增加现场恢复风险。
      affected_scope_delta:
        - 继续影响 [`dist/index.bundle.js`](dist/index.bundle.js:97)、[`dist/extension/index.js`](dist/extension/index.js:43576)、[`index.js`](index.js) 与 `release` 分支远端状态
recommendation: 选择 option_b。它在三维评估上综合最优：既修正了当前确实存在的不一致产物 [`dist/index.bundle.js`](dist/index.bundle.js:97)，又避免对已经正确的 `release` 发布结果做无意义重放。当前没有任何技术事实要求重新推送 `release`。
execution_plan_update:
  - 保持已完成的 release 推送结果不变。
  - 在进入最终 [`<output_quality_review>`](.analysis-cache.md) 前，新增一步：在 `main` 分支执行 [`npm run build:nocheck`](package.json:9) 重建普通 bundle [`dist/index.bundle.js`](dist/index.bundle.js:97)，然后重新验证其中的 UI / 提示文本已切换为 “SP·数据库 II”。
  - 完成该补建后，再输出验收报告并归档。
deviation_audit:
  original_plan_excerpt:
    - step_3: 运行类型检查与标准 extension 构建；构建时不盲用 [`package.json`](package.json:11) 的 Unix 风格脚本，而是按 [`标准extension构建与发布说明.md`](标准extension构建与发布说明.md:118) 使用 PowerShell 方式进入 extension 构建模式，产出 [`dist/extension/index.js`](dist/extension/index.js) 与 [`dist/extension/manifest.json`](dist/extension/manifest.json)。
    - step_7: 进行最终验收与归档，明确记录这次没有直接使用 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102) 的原因是它会在 dirty 工作区场景下错误地发布旧版本。
  current_proposal:
    - step_3 保持已完成结果不变：extension 制品已正确构建并发布。
    - 在 step_7 前新增一步：回到 `main` 后重建普通 bundle [`dist/index.bundle.js`](dist/index.bundle.js:97)，确认它与当前源码名称一致，再执行最终验收与归档。
  diff_summary:
    - 没有推翻已有的 extension 构建与 release 发布结果。
    - 新增了对普通 bundle [`dist/index.bundle.js`](dist/index.bundle.js:97) 的补建与补验。
    - 没有扩大远端发布范围，只是补齐本地产物一致性。
  deviation_motive_check:
    - 措辞替换规则逐类检查：未命中需要替换的降级措辞。
    - 偏离后的方案在三维评分上是否低于原方案？→ NO。新增普通 bundle 补建只会提升一致性与验收可靠性。
    - 偏离是否导致 affected_scope 缩小？→ NO。实际是合理扩大到新发现的残留产物 [`dist/index.bundle.js`](dist/index.bundle.js:97)。
degradation_check:
  - 推荐方案是否是三维评估（可维护性、健壮性、可扩展性）综合最优的？ → YES。option_b 精确修复当前唯一残留的不一致产物，同时避免无意义地重推 `release`。
  - 推荐方案是否遗漏了新发现的边界条件？ → NO。已覆盖“bundle 中部分 II 出现但旧 I 仍残留”“本地 bundle 与 extension 制品状态不一致”等边界。
  - 是否因为想尽快完成而选择了改动量小的方案？ → NO。真正图快的是 option_a；我拒绝把已知残留问题伪装成“范围外”。
  - 修改后的execution_plan是否仍覆盖所有affected_scope？ → YES。并且补充纳入了新发现的 [`dist/index.bundle.js`](dist/index.bundle.js:97)。
  - 是否有发现了但被我判断为"无关紧要"而跳过的问题？ → NO。这个问题直接影响最终验收结论的真实性，不能跳。
  - options 是否包含至少三个方案？ → YES。已提供 option_a、option_b、option_c。
  - 是否因为工具报错而准备换用 shell 命令修改源代码？ → NO。这里只需要重新构建产物，不涉及用 shell 修改源码。
  - deviation_audit 是否触发了 self_dissection？ → NO。没有缩 scope、降质量或回避复杂度。
</decision_point>
---
<output_quality_review>
task_summary: 将运行时 UI / 提示界面中的 “SP·数据库 I” 统一改为 “SP·数据库 II”，把 [`manifest.json`](manifest.json:9) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:9) 的版本提升到 `2.0.0`，构建并校验标准 extension 制品 [`dist/extension/index.js`](dist/extension/index.js:43576) 与 [`dist/extension/manifest.json`](dist/extension/manifest.json:9)，将 release 制品推送到远端 `release` 分支，然后切回 `main` 并恢复工作区；同时补建普通 JS bundle [`dist/index.bundle.js`](dist/index.bundle.js:43590)，消除本地产物与源码之间的名称不一致。

deliverables:
  - modified: [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)
  - modified: [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)
  - modified: [`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)
  - modified: [`src/index.ts`](src/index.ts:95)
  - modified: [`manifest.json`](manifest.json:2)
  - modified: [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:2)
  - generated: [`dist/extension/index.js`](dist/extension/index.js:43576)
  - generated: [`dist/extension/manifest.json`](dist/extension/manifest.json:9)
  - generated: [`dist/index.bundle.js`](dist/index.bundle.js:43590)
  - process_artifact: [`.analysis-cache.md`](.analysis-cache.md)

metrics:
  total_files_modified: 10 — 6 个源码/清单文件 + 3 个构建产物 + 1 个流程缓存文件
  execution_plan_coverage: 7/7 = 100% — [`<analysis>`](.analysis-cache.md) 中的 `step_1` 至 `step_7` 已全部完成；执行期新增的 [`<decision_point>`](.analysis-cache.md) 里关于 [`dist/index.bundle.js`](dist/index.bundle.js:97) 的补建也已落地
  edge_cases_handled: 7/7 = 100% — 原 analysis 中列出的 `release` 分支存在性、Windows 下 extension 构建方式、双 manifest 分裂、dirty-tree 发布错误、源码名称漏改、制品版本校验、切回 `main` 与恢复现场等边界均已处理；执行期新增的 bundle 残留问题也已修正
  confidence_assessment: MEDIUM — [`npm run typecheck`](package.json:15)、extension 构建、普通 bundle 构建、制品文本校验、`release` 推送与 `main` 恢复都已验证；仍缺 1 个非必需但更强的运行期验证：在宿主环境中真实打开插件窗口，人工确认 UI 文本显示与安装信息一致

substance_check:
  - 产物中是否存在"形式完整但实质空洞"的内容？
    → NO。每个产物都直接改变了运行结果或发布结果：[`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)、[`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)、[`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95) 改变实际 UI / 提示文本；[`manifest.json`](manifest.json:9) 与 [`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:9) 改变安装元数据与版本；[`dist/extension/index.js`](dist/extension/index.js:43576)、[`dist/extension/manifest.json`](dist/extension/manifest.json:9)、[`dist/index.bundle.js`](dist/index.bundle.js:43590) 是真实交付产物；[`.analysis-cache.md`](.analysis-cache.md) 保存了完整决策链。删掉其中任一项，要么用户可见名称回退，要么版本错误，要么制品与源码不一致，要么失去审计链。
  - 产物是否能被其目标对象（被测代码/被重构模块/被修复的bug）的变化所"击穿"？
    → NO。若把 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121) 或 [`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43) 改回旧文本，则 [`dist/extension/index.js`](dist/extension/index.js:43576) 与 [`dist/index.bundle.js`](dist/index.bundle.js:43590) 的校验都会失效；若把 [`manifest.json`](manifest.json:9) 改回旧版本，则 [`dist/extension/manifest.json`](dist/extension/manifest.json:9) 的版本检查会立刻暴露差异；若忽略 dirty-tree 风险直接使用 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102)，本次远端 `release` 推送结果就不会对应当前修改。当前产物不是空壳包装，而是直接约束发布结果的实质改动。
  - 实质性比率: 10/10 = 100%

completeness_check:
  - 是否存在被跳过的模块/函数/路径？
    → NO。最终实际覆盖范围包括 [`src/presentation/pages/main-popup.ts`](src/presentation/pages/main-popup.ts:121)、[`src/presentation/bootstrap/startup.ts`](src/presentation/bootstrap/startup.ts:43)、[`src/shared/runtime-env.ts`](src/shared/runtime-env.ts:99)、[`src/index.ts`](src/index.ts:95)、[`manifest.json`](manifest.json:2)、[`manifest.plus-assistantembedded.json`](manifest.plus-assistantembedded.json:2)、[`dist/extension/index.js`](dist/extension/index.js:43576)、[`dist/extension/manifest.json`](dist/extension/manifest.json:9)、[`dist/index.bundle.js`](dist/index.bundle.js:43590) 与 [`.analysis-cache.md`](.analysis-cache.md)。没有把“普通 bundle 残留旧文本”这种后期暴露的问题伪装成范围外。
  - 产物覆盖的范围是否与 execution_plan 中 affected_scope 完全一致？
    → YES。原 [`affected_scope`](.analysis-cache.md) 中的 9 项全部覆盖；执行期新发现的 [`dist/index.bundle.js`](dist/index.bundle.js:97) 残留问题也通过新的 [`<decision_point>`](.analysis-cache.md) 合法纳入并完成修正。
  - 核心业务逻辑是否都有直接验证（不依赖间接覆盖）？
    → YES。直接验证位置如下：[`npm run typecheck`](package.json:15) 验证源码改动未引入 TS 回归；[`dist/extension/manifest.json`](dist/extension/manifest.json:9) 直接验证 release 版本为 `2.0.0`；[`dist/extension/index.js`](dist/extension/index.js:83)、[`dist/extension/index.js`](dist/extension/index.js:43576)、[`dist/extension/index.js`](dist/extension/index.js:43657) 直接验证 extension 运行时文本已切换为 “SP·数据库 II”；[`dist/index.bundle.js`](dist/index.bundle.js:97)、[`dist/index.bundle.js`](dist/index.bundle.js:43590)、[`dist/index.bundle.js`](dist/index.bundle.js:43671)、[`dist/index.bundle.js`](dist/index.bundle.js:50272) 直接验证普通 bundle 也已同步；[`git branch --show-current`](scripts/publish-extension.sh:149) 与 `git status` 的结果直接验证当前分支已回到 `main` 且工作区已恢复。
  - affected_scope 覆盖率: 10/10 = 100%

value_density_check:
  - 产物中高价值内容（验证核心逻辑/处理复杂场景）与低价值内容（验证trivial行为）的比例是多少？
    → 高价值:低价值 = 10:0，高价值占比 100%。这轮没有拿琐碎改动凑数；真正高价值的点是 dirty-tree 发布风险规避、双 manifest 同步、extension 制品构建、普通 bundle 补建、`release` 推送与 `main` 恢复。
  - 是否存在"用数量掩盖质量"的模式——大量 trivial 产物掩盖了核心逻辑缺少验证的事实？
    → NO。文件数量不多，但每一项都对应一个发布链上的真实断点；尤其是 [`scripts/publish-extension.sh`](scripts/publish-extension.sh:102) 的 dirty-tree 风险与 [`dist/index.bundle.js`](dist/index.bundle.js:97) 的残留旧文本，都是不处理就会留下真实故障的点。

alignment_check:
  - 产物满足的是用户的字面需求还是本质需求？
    → 满足的是本质需求。用户表面要的是“把版本号从 I 改成 II、manifest 改成 `2.0.0`、生成 release 并推送后切回 `main`”；本质上要的是当前产品的可见名称、安装元数据、本地普通 JS 产物、extension 制品和远端 `release` 发布结果全部一致。本次交付不仅改了源码和 manifest，还构建并验证了 [`dist/extension/index.js`](dist/extension/index.js:43576)、[`dist/extension/manifest.json`](dist/extension/manifest.json:9)、[`dist/index.bundle.js`](dist/index.bundle.js:43590)，并完成了 `release` 推送与 `main` 恢复。
  - "如果这是别人交给我的，我会接受吗？"
    → YES。它已经达到可交付标准：源码名称统一、版本统一、普通 bundle 与 extension 制品一致、远端 `release` 已推送、当前分支已回到 `main`。唯一没有做的是宿主环境里的人工 UI 打开验证，所以整体置信度我保守定为 MEDIUM；但这不是半成品，已经明显高于“能跑就算完”的敷衍结果。
</output_quality_review>
