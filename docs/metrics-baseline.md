# 指标基线与 ref 口径(外部声音 T5 裁决落地)

## 为什么

4 周成功指标与**基线**对比,不与零对比。上线前两周,每周日晚花 10 分钟填下表。

## 基线记录模板(上线前两周,每周一行)

| 周(起止日期) | 订单数 | 订单金额合计(¥) | 微信沟通耗时估计(小时/周) | 其中「有什么/多少钱/怎么买」类 | 其中「到哪了」类 | 备注 |
|---|---|---|---|---|---|---|
| 例:7月27日–8月2日 | | | | | | |
| | | | | | | |

「到哪了」类占比 >20% 或每周耗数小时 → 1.5 期物流自查页立项判据(Open Question 3)。

## 上线后 4 周对照(每周一行)

| 周 | 发布期号 | 有打开记录的专属码数 / 发码总数 | 复制订单事件数 | 带期号+ref 的实际订单数 | 可归因新客数 | 沟通耗时(自评) |
|---|---|---|---|---|---|---|
| | | | | | | |

## ref 归因口径(读数前先读这段)

- **ref 标识分享链条的起点**,不是下单人身份:余杏的链接被转进姐妹群,群里所有人的打开/复制都归到 `yuxing01` 名下(多层转发会串码)。
- 打开/复制是**行为代理指标**;**成交与新客身份以创始人微信对账为准**。订单文本里的期号+ref 是对账钩子。
- 裸链接(丢参/直接输域名)记为 `direct`,不计入任何客户名下。未发放或已退役的码同样降级计入 `direct`(旧链接流量不丢,但不归任何码名下)——`direct` 数字偏高时先想到这两个来源。
- 数据用于**趋势判断**,不用于精确计数。同一码打开数虚高时,以微信侧订单核对修正。

## 数据怎么查

```bash
cd site
# 每周打开事件(按 ref)
npx wrangler d1 execute gogoducky-events --remote --command \
  "SELECT ref, COUNT(*) n FROM events WHERE type='open' AND ts > datetime('now','-7 days') GROUP BY ref ORDER BY n DESC"
# 每周复制订单事件
npx wrangler d1 execute gogoducky-events --remote --command \
  "SELECT ref, type, COUNT(*) n FROM events WHERE type LIKE 'copy%' AND ts > datetime('now','-7 days') GROUP BY ref, type"
```
