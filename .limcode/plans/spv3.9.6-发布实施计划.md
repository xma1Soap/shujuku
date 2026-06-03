## TODO LIST

<!-- LIMCODE_TODO_LIST_START -->
- [ ] 按确认链路执行构建、覆盖 index、提交 main、创建并推送 tag spv3.9.6  `##rel-exec`
- [x] 制定基于真实构建/发布链路的 spv3.9.6 发布实施计划  `##rel-plan`
- [x] 确认 spv3.9.6 发布目标链路（userscript main/tag vs extension release/extension-only）与当前仓库状态  `##rel-recon`
- [ ] 验证 main/tag 指向、构建产物一致性与发布后状态  `##rel-verify`
<!-- LIMCODE_TODO_LIST_END -->

# spv3.9.6 发布实施计划

## 1. 计划来源

来源：助手的直接需求——“打包生成js，覆盖Index，推送到main和tag spv3.9.6”。

## 2. 已确认事实

### 2.1 当前仓库与分支
- `.git/config` 显示 `origin = https://github.com/AlbusKen/shujuku.git`
- `.git/HEAD` 显示当前分支为 `main`
- `.git/refs/heads/main` 当前本地 main 指向 `ea5f638c6e3cca1841dd7a3b4fb1653193069f80`

### 2.2 存在三条不同发布链，不能混用
1. **userscript/main+tag 链**
   - `rollup.config.js` 的 `userscriptConfig` 输出 `dist/index.bundle.js`
   - 并在 `writeBundle` 中复制覆盖仓库根 `index.js`
   - 这条链与“推送到 main + 打 tag”匹配
2. **extension/release 链**
   - `rollup.config.js` 的 `extensionConfig` 输出 `dist/extension/index.js`
   - 并复制覆盖仓库根 `index.js` 与 `manifest.json`
   - `scripts/publish-extension.sh` 推送的是 `release` 分支，不是 `main`
3. **旧 extension-only 直装仓库链**
   - `标准extension构建与发布说明.md` 记录了发布到 `niccolecantdoit-rgb/shujuku-extension-only` 的手工流程
   - 当前仓库脚本没有自动执行这条链

### 2.3 `spv3.9.6` 当前未发现现成发布记录
- 已搜索工作区与 `.git/`，未发现 `spv3.9.6` 现成文档/脚本痕迹
- `.git/packed-refs` 中未见 `refs/tags/spv3.9.6`

### 2.4 根 index.js 的语义有歧义，必须锁定产物类型
- userscript 构建会把 `dist/index.bundle.js` 覆盖到根 `index.js`
- extension 构建也会把 `dist/extension/index.js` 覆盖到根 `index.js`
- 所以“覆盖 Index”如果不说明是哪种产物，就是一句会制造事故的废话

## 3. 本次计划采用的发布假设

**采用假设 A：走 userscript main/tag 链路。**

理由：
- 用户明确要求“推送到 main 和 tag spv3.9.6”
- 这与历史 spv 标签发布链一致
- 这与 `publish-extension.sh` 的 release 分支链不一致

如果助手实际想发布的是插件直装产物，那么这份计划就不该执行，必须改成 extension/release 或 extension-only 计划。现在看，按 userscript 主链执行才是最符合证据的路径。

## 4. 实施目标

1. 基于当前工作树构建 userscript 产物
2. 让仓库根 `index.js` 与本次 userscript 产物一致
3. 将必要变更提交到 `main`
4. 创建并推送 `spv3.9.6` tag
5. 验证 `main` 与 `spv3.9.6` 指向正确提交

## 5. 实施步骤

### 步骤 1：发布前侦察与冻结基线
执行前必须记录：
- `git status --short --branch`
- `git rev-parse HEAD`
- `git rev-parse origin/main`
- `git tag --list spv3.9.6`
- `git diff -- index.js manifest.json package.json`

目的：
- 确认工作区是否 dirty
- 确认本地 main 是否落后远端
- 确认 tag 是否已存在
- 确认本次可能被发布的关键文件差异

### 步骤 2：按 userscript 链构建
执行 userscript 构建，而不是 extension 构建：
- 优先使用 `npm run build`
- 如需规避诊断噪音，至少确保 rollup 真实成功，且 `dist/index.bundle.js` 生成

构建后确认：
- `dist/index.bundle.js` 存在
- 根 `index.js` 已被同步覆盖
- `index.js` 内容与 `dist/index.bundle.js` 一致

### 步骤 3：构建后验证
至少检查：
- `git diff -- index.js`
- 根 `index.js` 首部应符合 userscript 产物特征，而不是 extension ESM 产物
- 如有需要，抽查 bundle 关键标记，确认本轮改动已进入产物

### 步骤 4：提交 main
前提条件：
- 工作区没有异常脏改动混入
- 构建验证通过
- 本地 main 与远端 main 没有未处理分叉

提交内容原则：
- 只提交本次应发布的源码/产物变更
- 不顺手夹带无关文件
- 若 `index.js` 变化来自本次构建，应与对应源码改动一起提交

提交后执行：
- `git push origin main`

### 步骤 5：创建与推送 tag
前提条件：
- `spv3.9.6` 不存在
- `main` 已推送成功

执行：
- 在本次发布提交上创建 tag `spv3.9.6`
- 推送 `git push origin spv3.9.6`

如发现远端已有同名 tag：
- 停止，不做强推
- 先回报冲突事实，由助手决定是否覆盖/改名

### 步骤 6：发布后验证
至少验证：
- `git rev-parse HEAD`
- `git ls-remote origin refs/heads/main`
- `git ls-remote origin refs/tags/spv3.9.6`
- 确认 main 与 tag 指向预期提交
- 再次确认工作区未残留异常构建副作用

## 6. 验收标准

满足以下条件才算发布完成：
1. userscript 构建成功，`dist/index.bundle.js` 生成
2. 根 `index.js` 已被 userscript 产物覆盖，而不是 extension 产物
3. `main` 推送成功
4. `spv3.9.6` tag 创建并推送成功
5. 远端 `main` 和 `spv3.9.6` 均指向本次发布提交
6. 过程中未误触发 release/extension-only 链路

## 7. 风险与控制

### 风险 1：误走 extension 链
后果：根 `index.js` 变成 extension 产物，但用户却要求 main/tag 发布。\
控制：构建阶段只走 userscript 链，不调用 `build:extension` 或 `publish:extension`。

### 风险 2：工作区 dirty，夹带无关改动
后果：main 发布不可追溯，tag 污染。\
控制：先看 `git status` 与关键 diff，只提交必要文件。

### 风险 3：本地 main 落后或分叉
后果：push 失败或覆盖他人提交。\
控制：发布前比较 `HEAD` 与 `origin/main`，必要时先处理同步。

### 风险 4：同名 tag 已存在
后果：推送失败；若强推会污染历史。\
控制：执行前先查 tag；若存在则停止，等待明确指令。

### 风险 5：诊断噪音误判为发布阻断
当前诊断：`tsconfig.json` 的 `baseUrl` 弃用提示。\
结论：这是已知迁移噪音，不等于本次发布阻断；但如果 build/typecheck 真实失败，则必须停止。

## 8. 不执行事项

本次计划**不包含**以下动作：
- 不推送 `release` 分支
- 不发布 `extension-only` 直装仓库
- 不修改发布链路脚本
- 不自动强推已有 tag
- 不在未确认冲突时擅自 rebase/merge/force push

## 9. 自我复查

这份计划是可执行的，但也有一个必须直说的前提：**它建立在“用户要求的是 userscript main/tag 发布”这个明确假设上**。如果这个假设错了，那么整份计划虽然步骤完整，目标却会跑偏。幸运的是，当前证据支持这个假设，至少比盲目跑 extension/release 链可靠得多。

换句话说，这版计划不是不能执行，而是**只有在 main+tag 语义已被锁定为 userscript 发布时才合格**。否则，漏洞明显得像是故意排给事故看的。
