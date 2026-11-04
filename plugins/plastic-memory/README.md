# 可塑性记忆（plastic-memory）

给角色一套**会变化**的长期记忆，不是群友印象的替代品，也不经过人工复核。

## 三档

| 档位 | 记什么 | 怎么处理 |
|---|---|---|
| 普通 | 日常事件、临时偏好 | 3 天不用删除（测试期） |
| 重要 | 约定、承诺、雷点、身份关系、长期偏好 | 14 天不用归档（测试期） |
| 珍贵 | 不可替代、改变自我认知、经得起时间的瞬间 | 不自动删除；30 天不用只压缩归档 |

**反复使用只能把普通推到重要，永远推不到珍贵。** 珍贵由 agent 在冷却后自己反思决定。

## 自动流程

```
回复结束
  → 防抖 4 秒
  → 抽取 0~2 条候选
  → 普通/重要生效；珍贵进候选
  → 12 小时后（或想起 3 次）反思 + 挑刺
  → 通过 → 珍贵；不通过 → 重要
  → 每 7 天自审珍贵，可自己降为重要，但不删除
```

## 记忆怎么被用

- 默认 `injectMode: both`：
  - 每轮自动注入最多 4 条相关记忆到提示词；
  - 模型也可以主动 `memory_search` 深挖；
- `auto`：只自动注入；
- `tool`：不自动注入，完全由模型自己搜。

注入的是**模型上下文**，不是 QQ 回复文字；只有 `send_message` 的内容会发出去。

## 工具

- `plastic-memory__memory_search`：按关键词找记忆；
- `plastic-memory__memory_touch`：确认真的用到了某条；
- `plastic-memory__memory_reflect`：主动触发一次自审；
- `plastic-memory__memory_status`：看三档数量。

## 数据

- `data/plastic-memory/chats/<chatKey>.json`：记忆正文；
- `data/plastic-memory/journal.md`：只读日志，新增/晋升/降级/归档；
- 与 `data/memory/`（群友印象）完全独立。

## 跨群

`crossGroup`：

- `off`：只在本会话；
- `person`（默认）：只共享人物/agent 的稳定事实，不共享群内事件；
- `all`：全部共享（风险最高）。

私聊产生的记忆 `visibility=private`，不会跨群。

## 测试期参数

`ordinaryTtlDays=3`、`importantTtlDays=14`、`preciousArchiveDays=30`、
`candidateCooldownHours=12`、`preciousMaxPerChat=5`、`preciousMaxPerWeek=3`、
`reviewIntervalMinutes=15`、`injectTopK=4`、`injectMaxChars=1800`。

功能跑顺后可以调回：30 / 180 / 365 天、24~72 小时冷却、20 条珍贵、每 7 天 1 条。

## 说明

- 不训练、不微调；只是用主模型做抽取/反思的 API 调用；
- 所有模型调用失败都静默，不影响聊天；
- 不是人工审批：人只能看 journal 和数据文件。
