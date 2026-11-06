# 🔥 HotNow · 全网热榜

一个「今日热榜」式的全网热点聚合站：**一页看完微博、知乎、百度、抖音、头条、夸克、IT 之家、Hacker News、豆瓣、猫眼、网易云、Epic 等 20+ 个平台此刻在聊什么**。

参考 [rebang.today](https://rebang.today/) 的产品形态自行实现，数据来自开源项目 [60s API](https://github.com/vikiboss/60s)（无需密钥）。

![技术栈](https://img.shields.io/badge/技术栈-原生%20HTML%2FCSS%2FJS-blue) ![依赖](https://img.shields.io/badge/依赖-零依赖-green) ![服务](https://img.shields.io/badge/服务-Node.js%20(可选)-lightgrey)

---

## 快速开始

**方式一：双击 `启动.bat`**（推荐，Windows）

会启动本地服务并自动打开浏览器，地址 `http://127.0.0.1:8788/`。服务端带缓存，加载最快、最稳。

**方式二：命令行**

```bash
node server.mjs           # 默认 8788 端口，被占用会自动换端口
PORT=9000 node server.mjs # 指定端口
WARM=0 node server.mjs    # 关闭启动后台预热
```

**方式三：直接双击 `index.html`**

也能用——上游 API 允许跨域（`access-control-allow-origin: *`），浏览器直连即可。
缺点是没有本地缓存与合并请求，冷启动更慢、更容易被上游限流，且需要联网。

> 只要没有 Node.js，方式三依然可以完整体验全部功能。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 20+ 平台榜单 | 卡片式瀑布布局，每张卡一个平台，展示排名 / 标题 / 热度 / 标签 |
| 全网热议 | **跨平台同题聚类**：同一件事出现在 ≥2 个平台时自动聚合，按覆盖平台数与累计热度排序 |
| 分类筛选 | 资讯 / 社交 / 科技 / 视频 / 影视 / 社区 / 音乐 / 游戏 / 汽车 / 生活 |
| 全文搜索 | 跨全部榜单搜索标题与摘要，命中关键词高亮；按 `/` 快速聚焦 |
| 今日热词 | 从全部标题里按加权词频自动提取，点一下就搜 |
| 详情弹窗 | 摘要、封面、热度、回答数等元信息 + 打开原文 / 复制标题 / 复制链接 |
| 深色模式 | 浅色 / 深色 / 跟随系统，选择会被记住 |
| 自动刷新 | 5 / 10 / 30 分钟可选，也支持手动刷新（`R`）与单卡刷新 |
| 离线可用 | 本地缓存 + 服务端磁盘缓存，断网时展示上次的数据 |
| 自愈 | 上游偶发限流/失败时会自动重试补齐缺失的源 |
| 复制导出 | 单卡复制、一键复制全部榜单为 Markdown |
| 响应式 | 桌面多列、手机单列 |

**快捷键**：`/` 聚焦搜索 · `R` 刷新全部 · `Esc` 关闭弹窗 / 清空搜索

---

## 数据源

默认启用 22 个源：

| 平台 | 接口 | 平台 | 接口 |
| --- | --- | --- | --- |
| 微博热搜 | `/v2/weibo` | 百度热搜 | `/v2/baidu/hot` |
| 知乎热榜 | `/v2/zhihu` | 百度电视剧榜 | `/v2/baidu/teleplay` |
| 抖音热搜 | `/v2/douyin` | 百度贴吧话题榜 | `/v2/baidu/tieba` |
| 头条热搜榜 | `/v2/toutiao` | Hacker News | `/v2/hacker-news/top` |
| 夸克热点 | `/v2/quark` | 豆瓣口碑电影榜 | `/v2/douban/weekly/movie` |
| IT 之家热榜 | `/v2/it-news/rank` | 豆瓣华语剧集榜 | `/v2/douban/weekly/tv_chinese` |
| IT 之家资讯 | `/v2/it-news` | 豆瓣全球剧集榜 | `/v2/douban/weekly/tv_global` |
| AI 资讯快报 | `/v2/ai-news` | 豆瓣华语综艺榜 | `/v2/douban/weekly/show_chinese` |
| 猫眼全球票房总榜 | `/v2/maoyan/all/movie` | 豆瓣全球综艺榜 | `/v2/douban/weekly/show_global` |
| 网易云飙升榜 | `/v2/ncm-rank/19723756` | 每天 60 秒读懂世界 | `/v2/60s` |
| Epic 免费游戏 | `/v2/epic` | 摸鱼日报 | `/v2/moyu` |

另有 4 个**默认关闭**的可选源（B 站热搜、小红书热点、懂车帝热搜、猫眼实时票房）——这些接口上游常年返回 500，放在设置里用「加载不稳定源」开关按需打开，避免浪费上游配额。

---

## 目录结构

```
hotnow/
├── index.html      # 页面骨架（含内联 SVG 图标，无外部资源）
├── styles.css      # 设计系统：双主题变量、卡片、模态框、响应式
├── sources.js      # 数据源注册表：每个源一个 adapt() 把任意 JSON 归一化为 items
├── app.js          # 应用逻辑：取数队列、缓存、渲染、聚类、搜索、设置
├── server.mjs      # 可选本地服务：静态托管 + /v2/* 带缓存的代理
├── 启动.bat        # 一键启动
└── .cache/         # 服务端落盘缓存（自动生成，可随时删除）
```

### 三条设计主线

1. **归一化**：`sources.js` 里每个源只声明 `path` 和 `adapt(json) -> items[]`，UI 与聚类逻辑完全不关心上游字段差异。
2. **两层缓存**：浏览器 `localStorage`（首屏秒开 + 离线）+ 服务端内存/磁盘缓存（合并请求 + 兜底旧数据）。分级 TTL：实时榜 10 分钟、日更 30 分钟、周更榜 6 小时。
3. **严格串行取数**：上游对突发请求极敏感（并发一高就 429，实测约 1 请求/秒 且 1.5 秒间隔可全量成功），因此服务端串行 + 最小间隔 + 429 冷却与路径隔离，前端按视口懒加载。

---

## 配置

服务端环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8788` | 监听端口（占用则自动 +1 尝试，再退到 9080/8080） |
| `UPSTREAM` | `https://60s-api.viki.moe` | 上游地址，可换成自建实例 |
| `CACHE_TTL` | `600` | 实时榜缓存秒数 |
| `MIN_GAP_MS` | `1500` | 两次上游请求的最小间隔（调小会更容易被限流） |
| `UPSTREAM_CONCURRENCY` | `1` | 上游并发数，建议保持 1 |
| `WARM` | — | 设为 `0` 关闭启动后台预热 |

前端设置（右上角齿轮，存 `localStorage`）：每卡条数、自动刷新间隔、紧凑模式、隐藏异常源、加载不稳定源、条目点击行为、主题。

---

## 加一个自己的数据源

在 `sources.js` 的 `SOURCES` 数组里追加一项即可，无需改动其它文件：

```js
{
  id: 'my-source', name: '我的榜单', short: '我', color: '#3b82f6',
  category: 'tech',                 // 见文件底部 CATEGORIES
  path: '/v2/xxx',                  // 服务端会代理到 UPSTREAM + path
  site: 'https://example.com/',     // 卡片右上角「更多」链接
  desc: '一句话描述', max: 30,
  adapt: function (json) {
    return (json.data || []).map(function (d, i) {
      return {
        title: String(d.title),
        desc: d.summary,            // 可选：摘要
        heat: Number(d.hot),        // 可选：热度数值
        heatText: d.hot_desc,       // 可选：热度文案（优先显示）
        link: d.url,
        cover: d.cover,             // 可选：封面
        chip: d.tag,                // 可选：小标签
        meta: [d.author],           // 可选：附加信息
      };
    }).filter(function (o) { return o.title; });
  },
}
```

若是非 60s 的外部接口，把 `path` 写成完整 URL 并相应调整 `server.mjs` 的代理规则即可。

---

## 说明

- 榜单数据与版权归各平台所有，本项目仅做聚合展示，数据来自第三方开源接口，可能存在延迟或缺失。
- 上游接口有速率限制：**不要**把 `MIN_GAP_MS` 调得过小，也不要在短时间反复强制刷新。
- 上游接口失效时，对应卡片会显示异常并在 90 秒后自动重试；可在设置里隐藏异常源。
