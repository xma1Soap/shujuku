# JSON Sanitization Issue Review
- 日期: 2026-06-03
- 概述: Workspace review
- 状态: 已完成
- 总体结论: 通过

## 评审范围

# JSON Sanitization Unescaped Quotes Issue Review
Date: 2026-06-03

## Overview
Reviewing the JSON parsing failure caused by unescaped double quotes during native mode automatic concurrent group form-filling.

## Findings
(To be updated after investigation)

## 评审摘要

- 当前状态: 已完成
- 已审模块: 待定
- 当前进度: 已记录 1 个里程碑；最新：M1
- 里程碑总数: 1
- 已完成里程碑: 1
- 问题总数: 1
- 问题严重级别分布: 高 0 / 中 0 / 低 1
- 最新结论: The error logged during JSON sanitization is a false alarm. It is emitted during an expected and fully recoverable fallback path when AI-generated JSON contains unescaped quotes. The data is correctly recovered, parsed, and saved via the loose object parser (`coerceLooseRowObject_ACU`) and sanitization pipeline, without causing any functional impact or data loss. The only impact is developer/user confusion caused by an `ERROR` level log with a stack trace. The recommended fix is to downgrade `logError_ACU` to `logWarn_ACU` or `logDebug_ACU` at the initial `JSON.parse` failure block in `src/service/ai/prompt-builder/table-edit-parser.ts`.
- 下一步建议: Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.
- 总体结论: 通过

## 评审发现

### Recoverable JSON parse failure logged as ERROR, causing false alarm

- ID: F-maintainability-1
- 严重级别: 低
- 分类: 可维护性
- 跟踪状态: 开放
- 相关里程碑: M1
- 说明:

  在 `parseTableEditCommandLine_ACU` 函数中，当原生的 `JSON.parse(jsonPart)` 失败时，代码调用了 `logError_ACU` 输出错误日志。然而，这是 JSON 容错管线的一个预期触发点（紧接着会调用 `coerceLooseRowObject_ACU` 和 `sanitizeJsonPipeline_ACU` 尝试恢复）。从用户反馈和代码执行路径来看，由于 AI 生成的内容中包含未转义的内部双引号（`"看看"`），原生解析抛出了 `SyntaxError`，但紧接着 `coerceLooseRowObject_ACU` 成功通过松散解析以及底层按字段调用 `sanitizeJsonPipeline_ACU`（自动转义内部双引号）恢复了该对象，因此业务并未中断，表单也成功写入。

  当前的影响仅仅是“控制台出现了 ERROR 级别的报错，引起了用户/监控的恐慌（False Alarm）”，并无实质的业务功能影响。

  **建议修复**：
  将 `src/service/ai/prompt-builder/table-edit-parser.ts` 第 222 行的 `logError_ACU` 降级为 `logWarn_ACU` 或 `logDebug_ACU`，只在所有降级恢复手段（包括 `sanitizeResult` 乃至第二次 `coerceLooseRowObject_ACU`）均失败最终抛出异常前，才使用 `logError_ACU`。
- 证据:
  - `src/service/ai/prompt-builder/table-edit-parser.ts`

## 评审里程碑

### M1 · Analyze JSON Sanitization Pipeline False Alarm Error

- 状态: 已完成
- 记录时间: 2026-06-03T05:45:42.911Z
- 摘要:

  ## 分析过程
  用户反馈在并发分组填表时出现了一个报错：
  `Primary JSON parse failed for: "...". Attempting sanitization pipeline... SyntaxError: Expected ',' or '}' after property value in JSON...`
  但随后表单依然正确写入了。

  通过追踪日志堆栈 `at parseTableEditCommandLine_ACU` 以及查阅 `src/service/ai/prompt-builder/table-edit-parser.ts` 源码可以发现：
  1. **报错来源**：AI 生成的 JSON 中包含了未被转义的内部双引号（`...在这个公司里"看看"这个词...`），导致第 219 行的 `JSON.parse(jsonPart)` 抛出 `SyntaxError`。
  2. **为何成功写入**：异常被 `catch (jsonError)` 捕获后，触发了容错管线（第 224 行的 `coerceLooseRowObject_ACU`）。由于该松散解析器会按逗号切割属性段，并对单个属性的值单独包裹 `[...]` 后调用 `sanitizeJsonPipeline_ACU`，其中的 `escapeUnescapedQuotesLayer_ACU` 逻辑成功识别了内部的 `"看看"` 并自动转义为 `\"看看\"`，最终恢复出了完整的正确数据。
  3. **恐慌原因**：捕获初始报错时（第 222 行），代码立刻使用了 `logError_ACU` 将其打印在了控制台，带出了红色的 Error 栈。而此时降级恢复流程还没开始执行，因此表现为一个**假阳性（False Alarm）**错误。

  ## 结论与影响
  **无功能性影响**，一切数据落库、流转和容错恢复机制都在按预期完美工作。唯一的影响是控制台出现了吓人的错误日志，对开发者或高阶用户造成了困扰。

  建议修改日志级别以解决该困扰。
- 结论:

  The error log is a false alarm caused by `logError_ACU` being used for an expected, recoverable fallback path. The data is properly recovered and written without functional impact. Recommended to downgrade the log level to `logWarn_ACU` or `logDebug_ACU`.
- 下一步建议:

  Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.
- 问题:
  - [低] 可维护性: Recoverable JSON parse failure logged as ERROR, causing false alarm

## 最终结论

The error logged during JSON sanitization is a false alarm. It is emitted during an expected and fully recoverable fallback path when AI-generated JSON contains unescaped quotes. The data is correctly recovered, parsed, and saved via the loose object parser (`coerceLooseRowObject_ACU`) and sanitization pipeline, without causing any functional impact or data loss. The only impact is developer/user confusion caused by an `ERROR` level log with a stack trace.

The recommended fix is to downgrade `logError_ACU` to `logWarn_ACU` or `logDebug_ACU` at the initial `JSON.parse` failure block in `src/service/ai/prompt-builder/table-edit-parser.ts`.

## 评审快照

```json
{
  "formatVersion": 4,
  "kind": "limcode.review",
  "reviewRunId": "review-mpxn4hgn-cyeaz1",
  "createdAt": "2026-06-03T00:00:00.000Z",
  "updatedAt": "2026-06-03T05:45:53.969Z",
  "finalizedAt": "2026-06-03T05:45:53.969Z",
  "status": "completed",
  "overallDecision": "accepted",
  "header": {
    "title": "JSON Sanitization Issue Review",
    "date": "2026-06-03",
    "overview": "Workspace review"
  },
  "scope": {
    "markdown": "# JSON Sanitization Unescaped Quotes Issue Review\nDate: 2026-06-03\n\n## Overview\nReviewing the JSON parsing failure caused by unescaped double quotes during native mode automatic concurrent group form-filling.\n\n## Findings\n(To be updated after investigation)"
  },
  "summary": {
    "latestConclusion": "The error logged during JSON sanitization is a false alarm. It is emitted during an expected and fully recoverable fallback path when AI-generated JSON contains unescaped quotes. The data is correctly recovered, parsed, and saved via the loose object parser (`coerceLooseRowObject_ACU`) and sanitization pipeline, without causing any functional impact or data loss. The only impact is developer/user confusion caused by an `ERROR` level log with a stack trace.\n\nThe recommended fix is to downgrade `logError_ACU` to `logWarn_ACU` or `logDebug_ACU` at the initial `JSON.parse` failure block in `src/service/ai/prompt-builder/table-edit-parser.ts`.",
    "recommendedNextAction": "Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.",
    "reviewedModules": []
  },
  "stats": {
    "totalMilestones": 1,
    "completedMilestones": 1,
    "totalFindings": 1,
    "severity": {
      "high": 0,
      "medium": 0,
      "low": 1
    }
  },
  "milestones": [
    {
      "id": "M1",
      "title": "Analyze JSON Sanitization Pipeline False Alarm Error",
      "status": "completed",
      "recordedAt": "2026-06-03T05:45:42.911Z",
      "summaryMarkdown": "## 分析过程\n用户反馈在并发分组填表时出现了一个报错：\n`Primary JSON parse failed for: \"...\". Attempting sanitization pipeline... SyntaxError: Expected ',' or '}' after property value in JSON...`\n但随后表单依然正确写入了。\n\n通过追踪日志堆栈 `at parseTableEditCommandLine_ACU` 以及查阅 `src/service/ai/prompt-builder/table-edit-parser.ts` 源码可以发现：\n1. **报错来源**：AI 生成的 JSON 中包含了未被转义的内部双引号（`...在这个公司里\"看看\"这个词...`），导致第 219 行的 `JSON.parse(jsonPart)` 抛出 `SyntaxError`。\n2. **为何成功写入**：异常被 `catch (jsonError)` 捕获后，触发了容错管线（第 224 行的 `coerceLooseRowObject_ACU`）。由于该松散解析器会按逗号切割属性段，并对单个属性的值单独包裹 `[...]` 后调用 `sanitizeJsonPipeline_ACU`，其中的 `escapeUnescapedQuotesLayer_ACU` 逻辑成功识别了内部的 `\"看看\"` 并自动转义为 `\\\"看看\\\"`，最终恢复出了完整的正确数据。\n3. **恐慌原因**：捕获初始报错时（第 222 行），代码立刻使用了 `logError_ACU` 将其打印在了控制台，带出了红色的 Error 栈。而此时降级恢复流程还没开始执行，因此表现为一个**假阳性（False Alarm）**错误。\n\n## 结论与影响\n**无功能性影响**，一切数据落库、流转和容错恢复机制都在按预期完美工作。唯一的影响是控制台出现了吓人的错误日志，对开发者或高阶用户造成了困扰。\n\n建议修改日志级别以解决该困扰。",
      "conclusionMarkdown": "The error log is a false alarm caused by `logError_ACU` being used for an expected, recoverable fallback path. The data is properly recovered and written without functional impact. Recommended to downgrade the log level to `logWarn_ACU` or `logDebug_ACU`.",
      "evidence": [],
      "reviewedModules": [],
      "recommendedNextAction": "Downgrade the initial parsing failure log level from `ERROR` to `WARN` or `DEBUG` in `parseTableEditCommandLine_ACU` to prevent false alarms.",
      "findingIds": [
        "F-maintainability-1"
      ]
    }
  ],
  "findings": [
    {
      "id": "F-maintainability-1",
      "severity": "low",
      "category": "maintainability",
      "title": "Recoverable JSON parse failure logged as ERROR, causing false alarm",
      "descriptionMarkdown": "在 `parseTableEditCommandLine_ACU` 函数中，当原生的 `JSON.parse(jsonPart)` 失败时，代码调用了 `logError_ACU` 输出错误日志。然而，这是 JSON 容错管线的一个预期触发点（紧接着会调用 `coerceLooseRowObject_ACU` 和 `sanitizeJsonPipeline_ACU` 尝试恢复）。从用户反馈和代码执行路径来看，由于 AI 生成的内容中包含未转义的内部双引号（`\"看看\"`），原生解析抛出了 `SyntaxError`，但紧接着 `coerceLooseRowObject_ACU` 成功通过松散解析以及底层按字段调用 `sanitizeJsonPipeline_ACU`（自动转义内部双引号）恢复了该对象，因此业务并未中断，表单也成功写入。\n\n当前的影响仅仅是“控制台出现了 ERROR 级别的报错，引起了用户/监控的恐慌（False Alarm）”，并无实质的业务功能影响。\n\n**建议修复**：\n将 `src/service/ai/prompt-builder/table-edit-parser.ts` 第 222 行的 `logError_ACU` 降级为 `logWarn_ACU` 或 `logDebug_ACU`，只在所有降级恢复手段（包括 `sanitizeResult` 乃至第二次 `coerceLooseRowObject_ACU`）均失败最终抛出异常前，才使用 `logError_ACU`。",
      "recommendationMarkdown": null,
      "evidence": [
        {
          "path": "src/service/ai/prompt-builder/table-edit-parser.ts"
        }
      ],
      "relatedMilestoneIds": [
        "M1"
      ],
      "trackingStatus": "open"
    }
  ],
  "render": {
    "rendererVersion": 4,
    "bodyHash": "sha256:05867f1ae047220afe47af1252533d804ddf2971ce219610ff7435f18b19b524",
    "generatedAt": "2026-06-03T05:45:53.969Z",
    "locale": "zh-CN"
  }
}
```
