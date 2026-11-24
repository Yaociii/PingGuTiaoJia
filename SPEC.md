# 谷子看图自动调价（Gacha Pricer V2.0）开发规格说明书

> 本文档为项目唯一事实来源（SSOT），涵盖 V2.0 自动化与生态能力升级后的产品架构、数据模型、多源比价管线、宽幅冷烫平账引擎、时效治理规范、便捷盲抽二调、外部拼谷导出契约与站内多人实时拼谷系统。

---

## 1. 系统架构与核心闭环

- **前端工作台**：React 19 + TypeScript + Tailwind CSS v4 + Zustand + IndexedDB 本地工程存档。
- **后端服务**：Express + TypeScript（`server.ts` & `server/`），统一托管 `/api/v1/*` 接口及轻量移动端 H5 拼谷页 `/g/:shareCode`，持久化至本地结构化数据库文件（`GachaDatabase`）。
- **V2.0 完整闭环**：
  1. 截图 `Ctrl+V` 粘贴或上传谷子拼团图 → VLM 结构化识别单品坐标、`ip_name`、`label`、`series_hint`（系列/柄图特征）、`item_type`（品类）及 `jp_keywords`（日文原名 + 品类词）。
  2. **多源比价聚合引擎**并发查询真实二级市场价（联网搜索闲鱼/煤炉 + 代理数据源接口）→ 过滤引流价与打包总价 → 30/90 天时效过滤 → IQR 四分位去噪 → 计算人民币中位价与置信分层，归一化为权重输入平账引擎。
  3. **宽幅冷烫平账引擎**：支持 `[0.1, 10.0]` 权重区间（5x~10x 真实价差）与全局「冷烫温差系数 $\gamma \in [0.5, 2.5]$」，保证 $\sum (P_i \times Q_i) = T$ 严格守恒。
  4. **便捷盲抽二调**：支持端盒数一键均分、预期总件数核对条、单行 `[-1]/[+1]/[置0未出]` 与退补群公告生成。
  5. **双轨开团生态**：支持高清图导出、标准 Excel `.xlsx` / CSV 与自定义拼谷助手文本模板复制，以及程序内一键发布**在线多人实时拼谷**（二维码 + `/g/:shareCode` 移动端 H5 + 原子防超卖 + SSE 实时同步 + 团长分人肾表与二调退补同步）。

---

## 2. 数据库模型（V2.0）

| 集合 / 表名 | 核心字段 | 说明 |
| --- | --- | --- |
| `invite_codes` | `code`, `daily_limit`, `used_today`, `last_reset_date`, `is_active` | 访问邀请码与 UTC 跨日限流 |
| `character_market_stats` | `id`, `ip_name`, `character_name`, `normalized_key`, `category`, `avg_weight_ratio`, `sample_count`, `updated_at` | 本地历史行情库；V2.0 引入 **45 天半衰期指数时间衰减**，超 90 天未更新自动降权 |
| `market_price_cache` | `cache_key`, `ip_name`, `normalized_char`, `series_key`, `item_type`, `market_price_median`, `market_price_range`, `sample_count`, `sources`, `pricing_tier`, `freshness`, `cached_at`, `expires_at` | 比价短期缓存表，默认 TTL = `48 小时`（`PRICE_CACHE_TTL_HOURS`），支持 `force_refresh=true` 穿透 |
| `market_contributions` | `id`, `token_code`, `project_id`, `ip_name`, `item_count`, `created_at` | 匿名回流幂等去重表 |
| `group_orders` | `id`, `share_code`, `title`, `ip_name`, `owner_token`, `annotated_image_data_url`, `status` (`open`/`locked`/`settled`), `created_at`, `updated_at` | 在线多人拼团主表 |
| `group_order_items` | `id`, `order_id`, `source_item_id`, `label`, `price`, `prepaid_price`, `total_qty`, `claimed_qty`, `tag`, `box` | 拼团商品余量明细表 |
| `group_claims` | `id`, `order_id`, `item_id`, `buyer_name`, `buyer_contact`, `qty`, `claim_token`, `status` (`active`/`cancelled`), `created_at` | 团员排谷认领记录表 |
| `detect_logs` | `id`, `token_code`, `provider`, `model`, `detected_count`, `latency_ms`, `status`, `error_msg` | 识别与调价调用审计日志（绝不记录用户 API Key） |

---

## 3. P0 / P1 核心算法与 API 契约

### 3.1 VLM 结构化识图升级（`server/vlmParser.ts` & `server/vlmProvider.ts`）
- Prompt 输出新增字段：`series_hint`（系列/柄图特征）、`item_type`（品类）、`jp_keywords`（精准日文检索词，如 `"ハイキュー 孤爪研磨 缶バッジ"`）。
- VLM 权重分层标准放宽至 **`[0.1, 10.0]`**：
  - 现象级顶流/隐藏款：`3.0 ~ 6.0`
  - 热门主推：`1.5 ~ 2.8`
  - 中游正常角色：`0.8 ~ 1.3`
  - 冷门角色：`0.3 ~ 0.7`
  - 大冷/纯捆物：`0.15 ~ 0.3`

### 3.2 多源可插拔比价聚合引擎（`server/priceLookup.ts`）
- 抽象接口 `PriceSourceAdapter`（对应规格 `BasePriceSource`），支持并发超时熔断（默认 10s）与优雅降级：
  - **通道 A：`SearchGroundingPriceSource`**（默认启用）：
    - 支持 Gemini Google Search Grounding (`tools: [{ googleSearch: {} }]`)，或通用搜索 API（`SEARCH_API_PROVIDER=tavily|serper|bocha` + `SEARCH_API_KEY`）+ LLM 价格提取。
    - 自动构造中/日双语检索词：闲鱼单出价 + `site:jp.mercari.com "{jp_keywords}"`。
  - **通道 B：`MercariAdapter` / `XianyuAdapter`**：
    - 预留合规代理/第三方 API 接口（`MERCARI_PROXY_URL` / `XIANYU_PROXY_URL`），自动执行公网 HTTPS 安全校验，日元报价按 `DEFAULT_JPY_RATE * (1 + INTL_SHIPPING_FACTOR)` 折算为人民币。
- **样本清洗与去噪**：
  - 剔除打包/抱盒/捆出/拼团总价标题（正则过滤 `打包|抱盒|全套|一整盒|捆出|整组|まとめ売り|セット`）与明显引流异常价（`< ¥3` 或 `> ¥3000`）。
  - 强制时间窗口：优先取 **30 天内** (`fresh`) 样本；不足 2 条时自动放宽至 **90 天内** (`recent`)；超过 90 天一律丢弃（标记 `stale` 不参与计算）。
  - 执行 **IQR 四分位去噪（$Q_1 - 1.5\cdot\text{IQR} \sim Q_3 + 1.5\cdot\text{IQR}$）+ 截尾中位数**，输出 `market_price_median`、`market_price_range`、`sample_count`、`sources`、`freshness`、`pricing_tier`（`exact_market` > `char_market` > `local_db` > `vlm_fallback`）。
- **新增接口**：
  - `POST /api/v1/price-lookup`：支持单谷重查与全团批量比价（含 `force_refresh`、`jpy_rate`、自定义关键词微调），返回每项的比价详情、归一化权重及命中层级。

### 3.3 宽幅权重与冷烫温差系数 $\gamma$（`src/core/rebalancer.ts`）
- `CostConfig.gamma`（默认 `1.0`，范围 `[0.5, 2.5]`）。
- 平账计算使用有效权重：$w'_i = (\text{clamp}(\text{weight}_i, 0.1, 10.0))^\gamma$。
- 严格保持 $\sum (P_i \times Q_i) = T$（支持 `0.5 / 1 / 5` 步长、Water-filling 上下限、锁定保护、多数量余差最小化）。

### 3.4 历史行情时间衰减（`server/marketMatcher.ts`）
- 指数衰减因子：$\text{decay} = 0.5^{\Delta\text{days} / 45}$。
- 写入新样本前先衰减有效样本数：`effective_n = sample_count * decay`，新旧融合使用 `effective_n`；超过 90 天未更新的本地记录降权，不再强制覆盖外部新比价。

---

## 4. P2 便捷盲抽二调、外部导出与在线多人拼谷

### 4.1 便捷盲抽二调（`src/components/SecondarySettlementModal.tsx`）
- 支持输入**端盒数（`boxCount`）**或**总预期出货数**，一键按端盒数均分所有参与角色的 `quantity`（可选同步重算目标总价并快照一调价为 `prepaidPrice`）。
- 顶部常驻件数核对条：`当前录入 X / 预期 Y（差额 ±Z）`，每行支持 `[-1]` `[+1]` `[置0未出]` 快捷按钮与实时退补重算。

### 4.2 外部拼谷工具导出（`src/core/groupExport.ts` & `src/components/ExportModal.tsx`）
- **Excel `.xlsx` / CSV 表格导出**：标准列 `商品名称/角色, 单价, 总数量, 捆绑/标签, 备注`（内置 CSV 公式注入防护与标准 OOXML `.xlsx` 打包）。
- **多格式可编辑文本模板**：支持 `{{label}}` `{{price}}` `{{quantity}}` `{{tag}}` 变量，内置「拼谷小程序批量解析」与「QQ/微信群标准排表公告」预设。

### 4.3 内置多人同步拼谷（`server/app.ts` + `/g/:shareCode` H5 + `GroupBuyModal.tsx`）
- `POST /api/v1/groups`：桌面端一键发团，返回 `share_code`、`owner_token` 与分享链接 `/g/{share_code}`。
- `GET /api/v1/groups/:shareCode`：公开获取拼团详情、标注图、实时余量与公开认领列表（脱敏联系方式）。
- `POST /api/v1/groups/:shareCode/claim`：团员抢谷/排谷，服务端同步原子条件校验 `claimed_qty + qty <= total_qty`，不足时严格返回 `409 Conflict`。
- `DELETE /api/v1/groups/:shareCode/claims/:claimId`：团长（凭 `X-Owner-Token`）或团员（凭 `X-Claim-Token`）撤单并立即释放库存。
- `PATCH /api/v1/groups/:shareCode/sync`：团长在盲抽二调后同步更新最新单价与状态，自动生成按团员汇总的分人肾表与退补账单。
- `GET /api/v1/groups/:shareCode/events`：SSE 实时推送库存与认领变化（前端自动重连并辅以兜底刷新）。
- `GET /g/:shareCode`：服务端直接托管极简移动端 H5 排谷页面（零外部依赖、DOM 纯文本安全渲染、支持查看标注图、实时余量、一键排谷与个人待付汇总）。
