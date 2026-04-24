<analysis>
context:
  1. 核心发现（从酒馆 SillyTavern 源码证实）：
     - 酒馆主窗口中 globalThis.SillyTavern = { libs, getContext } —— 主窗口的 window.SillyTavern 只暴露两个属性：libs 和 getContext（一个函数）
     - 所有真正的 API（chatId, eventSource, eventTypes, extensionSettings, chat, characters, saveSettingsDebounced 等）都必须通过 SillyTavern.getContext() 这个函数调用来获取
     - 对比之下，iframe 环境（油猴脚本模式）下，酒馆助手会把一个"扁平化"的 API 对象挂到 iframe 的 window.SillyTavern 上
     - 但插件模式运行在主窗口，面对的是原始的 {libs, getContext} —— 直接访问 SillyTavern.chatId / SillyTavern.eventSource 永远是 undefined

  2. 当前代码的致命缺陷：
     - attemptToLoadCoreApis_ACU (settings-ui-connect.ts:99) 直接把 hostWin.SillyTavern 赋给 SillyTavern_API_ACU
     - 插件模式下 hostWin === window，而 window.SillyTavern = {libs, getContext}
     - 所以 SillyTavern_API_ACU.chatId = undefined
     - SillyTavern_API_ACU.eventSource = undefined → "eventSource or eventTypes are missing"
     - SillyTavern_API_ACU.chat = undefined → getChatArray_ACU 永远返回 []
     - SillyTavern_API_ACU.saveChat = undefined

  3. saveSettings 的真相：
     - script.js 的 saveSettingsDebounced 是 ESM 导出，不是 window.saveSettingsDebounced
     - getContext().saveSettingsDebounced 才能拿到

  4. extensionSettings 同理：
     - extension_settings 是 scripts/extensions.js 的 ESM 导出
     - getContext().extensionSettings 才能拿到

  5. 日志证据：
     - "extensionSettings 未就绪（15000ms）"
     - "eventSource or eventTypes are missing"
     - "chatId still not available after 15000ms polling"
     - "找不到任何可用的 saveSettings 函数"

needs:
  - 插件模式下必须用 SillyTavern.getContext() 的返回值作为 SillyTavern_API_ACU
  - 所有对 SillyTavern_API_ACU 的读取必须改为每次都调用 getContext() 拿最新快照
  - saveSettingsDebounced 和 extensionSettings 必须从 getContext() 获取

key_challenges:
  - SillyTavern_API_ACU 是一个被全项目大量引用的模块级变量（export let），直接改变它的来源会影响所有消费者
  - getContext() 是一个函数调用，返回的对象是"当前快照"
  - 项目现有代码全都是 SillyTavern_API_ACU.chatId 这种直接字段访问
  - 不能影响油猴脚本模式

confidence: HIGH
  - 根因从酒馆源码直接证实：globalThis.SillyTavern = { libs, getContext }
  - 所有日志现象都能被这个根因完美解释

approach: 
  使用 Proxy 代理 + 首次初始化等待 方案。

  核心设计：
  - 插件模式下，用一个 Proxy 对象替代 SillyTavern_API_ACU 的直接赋值
  - Proxy 的 get 拦截器每次调用 window.SillyTavern.getContext() 取最新快照，然后从快照读取请求的属性
  - 油猴模式保持原样

  三维评分：
  - 可维护性: 5/5 — Proxy 方案零改动所有现有消费者代码，封装在 attemptToLoadCoreApis_ACU 一处
  - 健壮性: 5/5 — 每次读属性都是当前快照，不会有过期缓存问题
  - 可扩展性: 4/5 — 未来酒馆 API 增加新字段无需改代码

edge_cases:
  - getContext() 本身不存在（SillyTavern 还没完全加载）：Proxy 返回 undefined
  - getContext() 抛异常：Proxy 吞掉异常返回 undefined
  - 插件在 iframe 中被误加载：isExtensionMode 检测保证只在主窗口模式使用 Proxy
  - 油猴脚本模式不受影响：原逻辑保持
  - 函数属性 this 绑定：getContext() 返回的函数已经是绑定好的 ESM 导出

affected_scope:
  - src/presentation/triggers/settings-ui-sync/settings-ui-connect.ts
  - src/data/storage/tavern-storage.ts
  - src/entry-extension.ts

execution_plan:
  - step_1: 修改 settings-ui-connect.ts 的 attemptToLoadCoreApis_ACU 函数：在插件模式下，把 hostWin.SillyTavern 包装成一个 Proxy，每次属性读取都调用 hostWin.SillyTavern.getContext() 并从返回值取属性。油猴脚本模式保持原样。
  - step_2: 修改 tavern-storage.ts 的 initTavernSettingsBridge_ACU 插件模式分支：清理原有的三级 fallback 逻辑，统一改为调用 window.SillyTavern.getContext() 拿 extensionSettings 和 saveSettingsDebounced。
  - step_3: 修改 entry-extension.ts 的 waitForTavernHelper 函数：把就绪检查从 SillyTavern.extensionSettings || window.extension_settings 改为 SillyTavern.getContext?.().extensionSettings 的存在性检查。
  - step_4: 构建并本地验证 typecheck 通过、所有测试通过。
  - step_5: 通过 publish:extension 脚本发布到 release 分支。

degradation_check:
  - 方案是否是三维评估综合最优的？ → YES。Proxy 方案可维护性 5/5、健壮性 5/5、可扩展性 4/5。对比备选方案：手动改所有消费代码（可维护性 1/5）；或在初始化时缓存 getContext 返回值（健壮性 1/5，属性值不随酒馆状态更新）。
  - 是否遗漏了已知边界条件？ → NO
  - 是否因改动量大而想缩减方案？ → NO
  - 是否打算跳过某些文件？ → NO
  - execution_plan 是否覆盖 affected_scope 所有文件？ → YES
  - context 是否充分？ → YES，已读取酒馆源码
  - 是否有发现了但被判断为"无关紧要"而跳过的问题？ → NO。日志中的 worldbook 报错是下游症状，修复根因后自动消失。
  - execution_plan 中是否有步骤计划使用 shell 命令修改源代码？ → NO
</analysis>
