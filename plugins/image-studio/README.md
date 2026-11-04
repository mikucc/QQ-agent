# 生图工作室（image-studio）

参考 `dsh-image-studio` 的思路，给 QQ Agent 做一版轻量生图：

- 本地参考库：人物 / 服饰 / 场景 / 道具；
- 模型判断该发图时调用 `image_generate`；
- 组合参考图 + 画面描述，调用生图 API；
- 生成后**直接发到当前 QQ 会话**；
- 不需要再调 `send_image` 发同一张。

## 接口

支持两种：

### OpenAI 兼容

```text
POST {baseUrl}/images/generations   无参考图
POST {baseUrl}/images/edits         有参考图（multipart）
```

适合 `gpt-image-1`、多数聚合网关。

### 65535 异步任务

```text
POST {baseUrl}/v1/tasks
GET  {baseUrl}/v1/tasks/{id}
```

参考图以 data URI 放进 `input.image_urls`。

## 配置

设置 → 生图工作室：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `policy` | smart | smart / explicit / off |
| `provider` | openai | openai / 65535 |
| `baseUrl` | `https://api.openai.com/v1` | 生图接口 |
| `apiKey` | 空 | 只存本机 |
| `model` | `gpt-image-1` | 模型 id |
| `aspect` | 1:1 | 1:1 / 3:4 / 4:3 / 9:16 / 16:9 |
| `maxRefs` | 6 | 最多参考图 |
| `cooldownMin` | 30 | 同一会话主动发图间隔 |
| `policy` | smart | 用户明确要图，或氛围适合时发 |

**没填 API Key 时不会注入发图说明，也不会调用接口。**

## 参考库

```text
data/image-studio/library/
  characters/小鲸鱼/
    entry.json
    front.png
  outfits/居家针织服/
    entry.json
  scenes/河边步道/
    entry.json
  props/手机/
    entry.json
```

`entry.json`：

```json
{
  "name": "小鲸鱼",
  "aliases": ["肥鱼"],
  "description": "蓝白配色、蓝色长发、鲸鱼尾巴的 Q 版少女……",
  "traits": "开心时尾巴会拍水",
  "defaultOutfit": "居家针织服"
}
```

图片文件放在同目录；没有图片也能用，只按文字描述画。

## 工具

- `image_generate`
  - `prompt`
  - `situation / expression / pose / shot / light`
  - `characters / outfits / scene / props`
  - `aspect`
  - `caption`
  - `user_requested`
- `image_library`
  - 按 `category / query / id` 查库

## 发图规则

- `smart`：用户明确要图，或聊天氛围适合时主动发；
- `explicit`：只有用户明确要图才发；
- `off`：不主动，只保留工具；
- 同一会话主动发图默认至少间隔 30 分钟；
- 每小时最多 6 张，每天最多 20 张；
- 用户明确要图时传 `user_requested: true`，绕过冷却，但仍受每小时/每天上限。

## 输出

```text
data/image-studio/outputs/YYYY-MM/img-....png
```

生成记录暂不落 `history.jsonl`，需要时再加。

## 注意

- 参考图只保证长相、服装设计、场景风格；姿势、表情、构图由文字重新安排；
- 画面描述不要写真实地址和隐私；
- 生图 API 可能较慢，默认超时 180 秒；
- 发送失败时工具会返回本地文件路径，但不会自动重试发送。
