# Bottega Veneta Women Bags Scraper (Apify Actor)

抓取页面：
- https://www.bottegaveneta.com/en-us/women-collection-us/women-bags

## 功能
- 使用 `PlaywrightCrawler`，对动态渲染页面更稳定。
- 默认启用 Session Pool + Proxy 配置，降低封禁风险。
- 自动滚动页面，尽量加载完整商品列表。
- 支持从 DOM 与 JSON-LD 双通道提取商品信息。

## 输出字段
每条商品输出到 Dataset，包含：
- `url`: 商品详情页链接
- `name`: 商品名称
- `price`: 价格文本
- `currency`: 币种（可识别时）
- `imageUrl`: 商品主图链接
- `sku`: SKU（JSON-LD提供时）
- `source`: 来源（`dom` 或 `jsonld`）
- `listingUrl`: 当前列表页链接
- `crawledAt`: 抓取时间（ISO）

## 本地运行
```bash
npm install
npm run start
```

## Apify 部署建议
- 代理建议优先使用 Residential（若账户可用），稳定性更高。
- 并发建议 3~8，避免目标站点触发风控。
- 建议定时运行并监控失败率。
