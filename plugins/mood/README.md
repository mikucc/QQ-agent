# 心情（mood）

给角色一份**全局、跨群一致**的心情。不是群友印象，也不是 `inner-life` 的心事，而是“今天大概什么状态”。

## 状态

```json
{
  "valence": 0.2,
  "arousal": 0.4,
  "energy": 0.7,
  "socialBattery": 0.6,
  "moodLabel": "有点困但心情还行",
  "causes": ["昨天睡得晚"]
}
```

- `valence`：-1 不开心 .. 1 开心
- `arousal`：0 平静 .. 1 兴奋
- `energy`：精力
- `socialBattery`：想不想理人
- `moodLabel`：给提示词看的一句人话
- `causes`：为什么是这个心情

数据：`data/mood/state.json`，全局一份。

## 每天初始化

每天第一次运行：

- 读昨天日记（`data/日记/diary.jsonl`，如果存在）；
- 读昨天结束时的状态；
- 用主模型生成今天的 baseline + moodLabel + causes；
- 模型失败时退回规则（昨天状态 + 随机扰动）。

初始化在 `before-context` 里做，只有每天第一次会多一次模型调用。

## 当天调整

`after-response` 里做轻量调整：

- 被夸/聊得开心 → valence 小幅上升；
- 被怼/冲突 → valence 下降；
- 精力随互动下降；
- 社交电量随连续聊天下降；
- 有惯性，不会一句话过山车。

## 提示词

每轮注入：

```text
【你此刻的状态】
- 心情：有点困但还行
- 精力：中；社交电量：低
- 原因：昨天睡得晚
- 状态影响：今天不太想主动接话，能短就短
- 不要向群友报数值
```

## 对行为的影响

低心情/低电量时：

| 行为 | 最大概率 |
|---|---|
| 普通唤醒沉默 | **5%** |
| 主动消息被抑制 | **10%** |

保持 **1:2**，且只在心情分低于 `lowMoodThreshold`（默认 0.5），或社交电量/精力极低时启动；越低落越接近上限。

**硬相关不参与沉默**：@、回复、拍一拍、叫她的名字仍然必醒，只会回复更短。

## 恢复

- 安静一段时间后，`socialBattery`、`energy`、`arousal` 会向 baseline 回拉；
- 社交电量约 2 小时回满，精力约 3 小时；
- 不再出现“只掉不回、一整天都不想说话”的状态。

## 能力

- `mood.current`：注意力门读取 `suppress.reply`；
- `proactive.gate`：主动消息读取抑制概率；
- `status.mood`：面板状态。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `dailyInit` | true | 每天用模型初始化 |
| `replySuppressChance` | 0.05 | 普通回复沉默上限 |
| `proactiveSuppressChance` | 0.10 | 主动消息抑制上限 |
| `lowMoodThreshold` | 0.5 | 低于此值才计算沉默 |
| `maxCauses` | 3 | 原因保留条数 |
