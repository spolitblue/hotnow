/* ============================================================================
 * HotNow · 全网热榜  —  数据源注册表
 * ----------------------------------------------------------------------------
 * 经典脚本（非 ES module），因此双击 file:// 打开 index.html 也能直接运行。
 *
 * 每个数据源统一归一化为一组 item：
 *   { title, desc?, heat?, heatText?, link?, cover?, chip?, meta?: string[], rank? }
 *
 * 数据来自开源项目 60s API (https://github.com/vikiboss/60s)，无需密钥。
 * 想加自己的源？照着下面的结构追加一条即可（adapt 负责把任意 JSON 变成 items）。
 * ==========================================================================*/

(function () {
  'use strict';

  /* ---------- 小工具 ---------- */
  var s = function (v) {
    return v === undefined || v === null ? '' : String(v);
  };
  var num = function (v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  var clip = function (v, n) {
    var t = s(v).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  var meta = function () {
    var out = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (a === undefined || a === null || a === '') continue;
      out.push(Array.isArray(a) ? a.join(' ') : s(a));
    }
    return out.length ? out : undefined;
  };
  /* 微博/抖音等的 hot_value 是热度的主数值 */
  var byHeat = function (get, opt) {
    return function (json) {
      return (json.data || []).map(function (d) {
        var o = get(d, json);
        var h = Number(o.heat);
        o.heat = Number.isFinite(h) && h > 0 ? h : undefined;
        if (!o.title) return null;
        return o;
      }).filter(Boolean);
    };
  };

  /* ---------- 数据源 ---------- */
  var SOURCES = [
    /* ===== 社交 / 社区 ===== */
    {
      id: 'weibo', name: '微博热搜', short: '微', color: '#ff8200',
      category: 'social', path: '/v2/weibo', site: 'https://s.weibo.com/top/summary',
      desc: '微博实时热搜榜，舆论风向标', max: 50,
      adapt: byHeat(function (d) {
        return { title: s(d.title), heat: d.hot_value, link: s(d.link) };
      }),
    },
    {
      id: 'zhihu', name: '知乎热榜', short: '知', color: '#0084ff',
      category: 'community', path: '/v2/zhihu', site: 'https://www.zhihu.com/hot',
      desc: '知乎全站热门讨论', max: 30,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title),
            desc: clip(d.detail, 160) || undefined,
            heatText: s(d.hot_value_desc) || undefined,
            cover: s(d.cover) || undefined,
            link: s(d.link),
            meta: meta(d.answer_cnt ? d.answer_cnt + ' 回答' : '', d.follower_cnt ? d.follower_cnt + ' 关注' : '', d.created),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'rednote', name: '小红书热点', short: '红', color: '#ff2442',
      category: 'social', path: '/v2/rednote', site: 'https://www.xiaohongshu.com/explore',
      desc: '小红书实时热点话题', max: 30, optional: true,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title),
            heat: num(d.score),
            heatText: s(d.score_desc) || undefined,
            link: s(d.link),
            chip: s(d.word_type) || undefined,
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'baidu-tieba', name: '百度贴吧话题榜', short: '贴', color: '#3385ff',
      category: 'community', path: '/v2/baidu/tieba', site: 'https://tieba.baidu.com/',
      desc: '贴吧正在热议的话题', max: 30,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            rank: num(d.rank),
            title: s(d.title),
            desc: clip(d.desc || d.abstract, 140) || undefined,
            heat: num(d.score),
            heatText: s(d.score_desc) || undefined,
            cover: s(d.avatar) || undefined,
            link: s(d.url),
          };
        }).filter(function (o) { return o.title; });
      },
    },

    /* ===== 资讯 / 搜索 ===== */
    {
      id: 'baidu', name: '百度热搜', short: '百', color: '#2932e1',
      category: 'news', path: '/v2/baidu/hot', site: 'https://top.baidu.com/board?tab=realtime',
      desc: '百度实时热搜榜', max: 50,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            rank: num(d.rank),
            title: s(d.title),
            desc: clip(d.desc, 160) || undefined,
            heat: num(d.score),
            heatText: s(d.score_desc) || undefined,
            cover: s(d.cover) || undefined,
            chip: s(d.type_desc) || undefined,
            link: s(d.url),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'toutiao', name: '头条热搜榜', short: '头', color: '#f04142',
      category: 'news', path: '/v2/toutiao', site: 'https://www.toutiao.com/',
      desc: '今日头条实时热搜', max: 50,
      adapt: byHeat(function (d) {
        return { title: s(d.title), heat: d.hot_value, cover: s(d.cover) || undefined, link: s(d.link) };
      }),
    },
    {
      id: 'quark', name: '夸克热点', short: '夸', color: '#5a5aff',
      category: 'news', path: '/v2/quark', site: 'https://123.quark.cn/',
      desc: '夸克 7×24 小时实时热点', max: 50,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title),
            desc: clip(d.summary || d.content, 200) || undefined,
            cover: s(d.cover) || undefined,
            chip: s(d.category) || undefined,
            link: s(d.link),
            meta: meta(d.source, d.like_count ? d.like_count + ' 赞' : ''),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'dongchedi', name: '懂车帝热搜', short: '车', color: '#1e6fff',
      category: 'car', path: '/v2/dongchedi', site: 'https://www.dongchedi.com/',
      desc: '懂车帝汽车热搜榜', max: 30, optional: true,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title || d.name),
            heat: num(d.hot_value || d.score),
            heatText: s(d.hot_value_desc || d.score_desc) || undefined,
            link: s(d.link || d.url),
          };
        }).filter(function (o) { return o.title; });
      },
    },

    /* ===== 科技 ===== */
    {
      id: 'ithome-rank', name: 'IT之家热榜', short: 'IT', color: '#d22222',
      category: 'tech', path: '/v2/it-news/rank', site: 'https://www.ithome.com/',
      desc: 'IT之家实时热门文章', max: 20,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return { title: s(d.title), link: s(d.link) };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'ithome-news', name: 'IT之家资讯', short: 'IT', color: '#e04a4a',
      category: 'tech', path: '/v2/it-news', site: 'https://www.ithome.com/',
      desc: 'IT之家实时科技资讯', max: 20,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title),
            desc: clip(d.description, 140) || undefined,
            link: s(d.link),
            meta: meta(d.created),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'hackernews', name: 'Hacker News', short: 'HN', color: '#ff6600',
      category: 'tech', path: '/v2/hacker-news/top', site: 'https://news.ycombinator.com/',
      desc: 'Hacker News 热门帖子', max: 20,
      adapt: byHeat(function (d) {
        return {
          title: s(d.title), heat: d.score, link: s(d.link),
          meta: meta(d.author ? 'by ' + d.author : '', d.created),
        };
      }),
    },
    {
      id: 'ai-news', name: 'AI 资讯快报', short: 'AI', color: '#10a37f',
      category: 'tech', path: '/v2/ai-news', site: 'https://ai-bot.cn/daily-ai-news/',
      desc: '每日 AI / 大模型领域重要资讯', max: 30,
      note: function (json) {
        return json.data && json.data[0] ? json.data[0].date + ' · 每日 AI 圈要闻' : null;
      },
      adapt: function (json) {
        var d = json.data && json.data[0];
        return ((d && d.news) || []).map(function (n) {
          return {
            title: s(n.title),
            desc: clip(n.detail, 180) || undefined,
            link: s(n.link),
            meta: meta(n.source),
          };
        }).filter(function (o) { return o.title; });
      },
    },

    /* ===== 视频 ===== */
    {
      id: 'douyin', name: '抖音热搜', short: '抖', color: '#fe2c55',
      category: 'video', path: '/v2/douyin', site: 'https://www.douyin.com/',
      desc: '抖音实时热搜榜', max: 50,
      adapt: byHeat(function (d) {
        return {
          title: s(d.title), heat: d.hot_value, cover: s(d.cover) || undefined, link: s(d.link),
          meta: meta(d.event_time ? '上榜 ' + d.event_time : ''),
        };
      }),
    },
    {
      id: 'bili', name: '哔哩哔哩热搜', short: 'B', color: '#fb7299',
      category: 'video', path: '/v2/bili', site: 'https://www.bilibili.com/v/popular/rank/all',
      desc: 'B 站实时热搜', max: 30, optional: true,
      adapt: byHeat(function (d) {
        return { title: s(d.title), heat: d.hot_value || d.score, link: s(d.link) };
      }),
    },

    /* ===== 影视 ===== */
    {
      id: 'douban-movie', name: '豆瓣口碑电影榜', short: '豆', color: '#2e963f',
      category: 'movie', path: '/v2/douban/weekly/movie', site: 'https://m.douban.com/subject_collection/movie_weekly_best',
      desc: '豆瓣每周口碑电影榜', max: 10,
      adapt: doubanAdapter,
    },
    {
      id: 'douban-tv-cn', name: '豆瓣华语剧集榜', short: '剧', color: '#3aa757',
      category: 'movie', path: '/v2/douban/weekly/tv_chinese', site: 'https://m.douban.com/subject_collection/tv_chinese_best_weekly',
      desc: '豆瓣每周华语口碑剧集', max: 10,
      adapt: doubanAdapter,
    },
    {
      id: 'douban-tv-global', name: '豆瓣全球剧集榜', short: '剧', color: '#4cb35f',
      category: 'movie', path: '/v2/douban/weekly/tv_global', site: 'https://m.douban.com/subject_collection/tv_global_best_weekly',
      desc: '豆瓣每周全球口碑剧集', max: 10,
      adapt: doubanAdapter,
    },
    {
      id: 'douban-show-cn', name: '豆瓣华语综艺榜', short: '综', color: '#5bbf6e',
      category: 'movie', path: '/v2/douban/weekly/show_chinese', site: 'https://m.douban.com/subject_collection/show_chinese_best_weekly',
      desc: '豆瓣每周华语口碑综艺', max: 10,
      adapt: doubanAdapter,
    },
    {
      id: 'douban-show-global', name: '豆瓣全球综艺榜', short: '综', color: '#6ec97f',
      category: 'movie', path: '/v2/douban/weekly/show_global', site: 'https://m.douban.com/subject_collection/show_global_best_weekly',
      desc: '豆瓣每周全球口碑综艺', max: 10,
      adapt: doubanAdapter,
    },
    {
      id: 'maoyan-all', name: '猫眼全球票房总榜', short: '猫', color: '#ff6a00',
      category: 'movie', path: '/v2/maoyan/all/movie', site: 'https://piaofang.maoyan.com/',
      desc: '猫眼全球电影票房总榜', max: 30,
      note: function (json) {
        var d = json.data && json.data[0];
        return d && d.update_time ? '更新于 ' + d.update_time : null;
      },
      adapt: function (json) {
        var d = json.data && json.data[0];
        return ((d && d.list) || []).map(function (m) {
          return {
            rank: num(m.rank),
            title: s(m.movie_name),
            heatText: s(m.box_office_desc) || undefined,
            heat: num(m.box_office),
            meta: meta(m.release_year),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'maoyan-movie', name: '猫眼实时票房', short: '票', color: '#ff8a3d',
      category: 'movie', path: '/v2/maoyan/realtime/movie', site: 'https://piaofang.maoyan.com/dashboard',
      desc: '猫眼电影实时票房排行', max: 20, optional: true,
      adapt: function (json) {
        var d = json.data && json.data[0];
        var list = (d && (d.list || d.movieList)) || [];
        return list.map(function (m) {
          return {
            title: s(m.movie_name || m.name || m.title),
            heatText: s(m.box_office_desc || m.box_office_rate_desc) || undefined,
            heat: num(m.box_office || m.box_office_rate),
            meta: meta(m.release_info || m.show_count_desc),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'baidu-teleplay', name: '百度电视剧榜', short: '视', color: '#2b5cff',
      category: 'movie', path: '/v2/baidu/teleplay', site: 'https://top.baidu.com/board?tab=teleplay',
      desc: '百度实时电视剧热度榜', max: 10,
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            rank: num(d.rank),
            title: s(d.title),
            desc: clip(d.desc, 140) || undefined,
            heat: num(d.score),
            heatText: s(d.score_desc) || undefined,
            cover: s(d.cover) || undefined,
            link: s(d.url),
          };
        }).filter(function (o) { return o.title; });
      },
    },

    /* ===== 音乐 / 游戏 ===== */
    {
      id: 'ncm-rank', name: '网易云飙升榜', short: '云', color: '#c20c0c',
      category: 'music', path: '/v2/ncm-rank/19723756', site: 'https://music.163.com/#/discover/toplist',
      desc: '网易云音乐飙升榜', max: 30,
      note: function (json) {
        var d = json.data && json.data[0];
        return d && d.rank_name ? d.rank_name : null;
      },
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          var artists = (d.artist || []).map(function (a) { return s(a.name); }).filter(Boolean).join(' / ');
          var album = d.album && d.album.name ? s(d.album.name) : '';
          return {
            rank: num(d.rank),
            title: s(d.title),
            desc: artists ? '歌手：' + artists : undefined,
            cover: (d.album && d.album.cover) || undefined,
            link: s(d.link),
            meta: meta(album, d.duration_desc),
          };
        }).filter(function (o) { return o.title; });
      },
    },
    {
      id: 'epic', name: 'Epic 免费游戏', short: 'E', color: '#2a2a2a',
      category: 'game', path: '/v2/epic', site: 'https://store.epicgames.com/zh-CN/free-games',
      desc: 'Epic 每周限时免费游戏', max: 10,
      note: function () { return '每周四 23:00 更新，记得领取'; },
      adapt: function (json) {
        return (json.data || []).map(function (d) {
          return {
            title: s(d.title),
            desc: clip(d.description, 160) || undefined,
            cover: s(d.cover) || undefined,
            link: s(d.link),
            chip: d.is_free_now ? '限时免费' : '即将免费',
            meta: meta(d.seller, d.original_price_desc ? '原价 ' + d.original_price_desc : '', d.free_end ? '截止 ' + d.free_end : ''),
          };
        }).filter(function (o) { return o.title; });
      },
    },

    /* ===== 生活 ===== */
    {
      id: 'sixty', name: '每天 60 秒读懂世界', short: '60', color: '#4a90d9',
      category: 'life', path: '/v2/60s', site: 'https://60s.viki.moe/',
      desc: '每天 15 条国内外要闻速览', max: 20,
      note: function (json) {
        var d = json.data && json.data[0];
        if (!d) return null;
        return [d.date, d.day_of_week, d.lunar_date].filter(Boolean).join(' · ');
      },
      adapt: function (json) {
        var d = json.data && json.data[0];
        if (!d) return [];
        var items = (d.news || []).map(function (t) { return { title: s(t) }; });
        if (d.tip) items.push({ title: '每日一言：' + s(d.tip), chip: '一言', link: s(d.link) });
        return items;
      },
    },
    {
      id: 'moyu', name: '摸鱼日报', short: '摸', color: '#f5a623',
      category: 'life', path: '/v2/moyu', site: 'https://60s.viki.moe/',
      desc: '距离下班 / 周末 / 假期还有多久', max: 12,
      note: function (json) {
        var d = json.data && json.data[0];
        if (!d) return null;
        var g = d.date && d.date.gregorian ? d.date.gregorian : '';
        var w = d.date && d.date.weekday ? d.date.weekday : '';
        var l = d.date && d.date.lunar ? d.date.lunar.monthCN + d.date.lunar.dayCN : '';
        return [g, w, l].filter(Boolean).join(' · ');
      },
      adapt: function (json) {
        var d = json.data && json.data[0];
        if (!d) return [];
        var out = [];
        var week = d.countdown && d.countdown.toWeekEnd;
        if (typeof week === 'number') {
          out.push({ title: week > 0 ? '距离周末还有 ' + week + ' 天' : '周末就在眼前，冲！', chip: '倒计时' });
        }
        var fri = d.countdown && d.countdown.toFriday;
        if (typeof fri === 'number' && fri > 0) out.push({ title: '距离周五下班还有 ' + fri + ' 天', chip: '倒计时' });
        if (d.nextHoliday) {
          out.push({
            title: '距离「' + s(d.nextHoliday.name) + '」还有 ' + d.nextHoliday.until + ' 天（放假 ' + d.nextHoliday.duration + ' 天）',
            chip: '假期',
            meta: meta(d.nextHoliday.date),
          });
        }
        var m = d.progress && d.progress.month;
        if (m) out.push({ title: '本月已过 ' + m.percentage + '%（' + m.passed + '/' + m.total + ' 天）', chip: '进度' });
        var y = d.progress && d.progress.year;
        if (y) out.push({ title: '今年已过 ' + y.percentage + '%（还剩 ' + y.remaining + ' 天）', chip: '进度' });
        var t = d.today || {};
        if (t.isHoliday && t.holidayName) out.push({ title: '今天是 ' + t.holidayName + '，放假中～', chip: '假期' });
        if (t.solarTerm) out.push({ title: '节气：' + t.solarTerm, chip: '节气' });
        if (t.lunarFestivals && t.lunarFestivals.length) out.push({ title: '农历节日：' + t.lunarFestivals.join('、'), chip: '节日' });
        if (d.moyuQuote) out.push({ title: '摸鱼语录：' + d.moyuQuote, chip: '语录' });
        return out;
      },
    },
  ];

  function doubanAdapter(json) {
    return (json.data || []).map(function (d) {
      return {
        rank: num(d.rank),
        title: s(d.title),
        desc: clip(d.description, 140) || undefined,
        heatText: d.rating ? Number(d.rating).toFixed(1) + ' 分' : undefined,
        heat: num(d.rating_count),
        cover: s(d.cover_proxy || d.cover) || undefined,
        chip: d.trend === 'up' ? '↑' + (d.rank_change || '') : d.trend === 'down' ? '↓' + (d.rank_change || '') : undefined,
        link: s(d.url),
        meta: meta(d.card_subtitle, d.rating_count ? d.rating_count + ' 人评价' : ''),
      };
    }).filter(function (o) { return o.title; });
  }

  /* ---------- 分类 ---------- */
  var CATEGORIES = [
    { id: 'all', name: '全部', icon: '🔥' },
    { id: 'news', name: '资讯', icon: '📰' },
    { id: 'social', name: '社交', icon: '💬' },
    { id: 'tech', name: '科技', icon: '💻' },
    { id: 'video', name: '视频', icon: '🎬' },
    { id: 'movie', name: '影视', icon: '🍿' },
    { id: 'community', name: '社区', icon: '👥' },
    { id: 'music', name: '音乐', icon: '🎵' },
    { id: 'game', name: '游戏', icon: '🎮' },
    { id: 'car', name: '汽车', icon: '🚗' },
    { id: 'life', name: '生活', icon: '☕' },
  ];

  /* 已知长期不稳定的源：默认不加载（可在设置里打开），避免浪费上游配额 */
  var FLAKY = ['bili', 'rednote', 'dongchedi', 'maoyan-movie'];

  window.HOT_SOURCES = SOURCES;
  window.HOT_CATEGORIES = CATEGORIES;
  window.HOT_FLAKY = FLAKY;
  window.HOT_UPSTREAM = 'https://60s-api.viki.moe';
})();
