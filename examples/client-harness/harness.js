/*!
 * dsh-weread-moyu client harness
 *
 * 1) 模拟 DSH 的 window.__ModuleLoader__（队列式 load + 物化时执行 factory）
 * 2) 模拟宿主半的 /weread-moyu/api/*（?mock=1），验证真实数据流
 * 3) ?assert=1 时跑一组 DOM 契约断言，结果写到 #harness-assertions（JSON）
 *
 * 参数：
 *   ?mock=1     使用假宿主 API（已登录、有书架/章节/正文）
 *   ?panel=1    自动打开控制面板（截图用）
 *   ?qr=1       面板打开后点击“扫码登录”（截图用）
 *   ?theme=light 使用浅色主题（默认深色）
 *   ?speed=0    设置滚动档位（默认 2）
 *   ?peek=1     内容加载后打开“看清当前页”浮层（截图用）
 *   ?book=b4    启动后切到指定 mock 书籍（截图/手工验证用）
 *   ?jump=500   面板打开后在第 500 章跳转（截图用）
 *   ?cache=running|done|cancelled  预设当前书的缓存状态（截图/手工验证用）
 *   ?assert=1   运行契约断言并在结束后 dispose
 *   ?dispose=1  启动后立即 dispose（验证清理）
 */
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var harness = {
    rows: [],
    exports: null,
    effects: [],
    errors: [],
    ctx: null,
    mock: params.get("mock") === "1",
    lastContentUrl: null
  };
  window.__HARNESS = harness;

  // 捕获运行期未处理错误，用来断言 demo 模式不刷错误
  window.addEventListener("error", function (event) {
    harness.errors.push("window.error: " + (event.message || event.type));
  });
  window.addEventListener("unhandledrejection", function (event) {
    harness.errors.push("unhandledrejection: " + String(event.reason));
  });
  var nativeConsoleError = console.error.bind(console);
  console.error = function () {
    harness.errors.push("console.error: " + Array.prototype.map.call(arguments, String).join(" "));
    nativeConsoleError.apply(null, arguments);
  };

  /* ================================================================== *
   * 假 ModuleLoader（与真实 facade 行为一致：load 只登记 factory）
   * ================================================================== */

  var moduleCache = {};

  window.__ModuleLoader__ = {
    load: function (def) {
      harness.rows.push(def);
    },
    materialize: function (id) {
      if (Object.prototype.hasOwnProperty.call(moduleCache, id)) return moduleCache[id];
      var row = null;
      for (var i = 0; i < harness.rows.length; i++) {
        if (harness.rows[i].id === id) {
          row = harness.rows[i];
          break;
        }
      }
      if (!row) throw new Error("harness: module not registered: " + id);
      if (typeof row.factory !== "function") throw new Error("harness: module has no factory: " + id);
      var req = function (name) {
        throw new Error("harness: platform module not available: " + name);
      };
      req.async = function (name) {
        return Promise.reject(new Error("harness: platform module not available: " + name));
      };
      var exported = row.factory(req);
      moduleCache[id] = exported;
      return exported;
    },
    create: function () {
      return {
        load: window.__ModuleLoader__.materialize,
        require: window.__ModuleLoader__.materialize
      };
    }
  };

  /* ================================================================== *
   * 假宿主 API（?mock=1）
   * ================================================================== */

  var MOCK_BOOKS = [
    {
      bookId: "b1",
      title: "古文观止",
      author: "吴楚材 吴调侯",
      progress: 37,
      chapters: [
        // 微信读书 TOC 的典型前导非正文页（正文是 XML/版权页垃圾）
        { chapterUid: "c_cover", title: "封面", wordCount: 1, xml: true },
        { chapterUid: "c_copy", title: "版权信息", wordCount: 2, xml: true },
        { chapterUid: "c_toc", title: "目录", wordCount: 1, xml: true },
        {
          chapterUid: "c_intro",
          title: "序言",
          wordCount: 300,
          lines: [
            "序言：本书所选篇目，皆为先秦至明清的散文名篇，兼收史传、书序、杂记、辞赋诸体，取其文辞雅正、可诵可读者。",
            "阅读时不必拘泥于注释，先通读一遍，遇有会心处，随手记下即可。"
          ]
        },
        {
          chapterUid: "c1",
          title: "桃花源记",
          wordCount: 1200,
          lines: [
            "晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。渔人甚异之，复前行，欲穷其林。",
            "林尽水源，便得一山，山有小口，仿佛若有光。便舍船，从口入。初极狭，才通人。复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田美池桑竹之属。阡陌交通，鸡犬相闻。",
            "见渔人，乃大惊，问所从来。具答之。便要还家，设酒杀鸡作食。村中闻有此人，咸来问讯。自云先世避秦时乱，率妻子邑人来此绝境，不复出焉，遂与外人间隔。",
            "此人一一为具言所闻，皆叹惋。余人各复延至其家，皆出酒食。停数日，辞去。此中人语云：不足为外人道也。",
            "既出，得其船，便扶向路，处处志之。及郡下，诣太守，说如此。太守即遣人随其往，寻向所志，遂迷，不复得路。",
            "南阳刘子骥，高尚士也，闻之，欣然规往。未果，寻病终。后遂无问津者。"
          ]
        },
        {
          chapterUid: "c2",
          title: "兰亭集序",
          wordCount: 600,
          lines: [
            "永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭，修禊事也。群贤毕至，少长咸集。此地有崇山峻岭，茂林修竹，又有清流激湍，映带左右。",
            "是日也，天朗气清，惠风和畅。仰观宇宙之大，俯察品类之盛，所以游目骋怀，足以极视听之娱，信可乐也。",
            "夫人之相与，俯仰一世。或取诸怀抱，悟言一室之内；或因寄所托，放浪形骸之外。虽趣舍万殊，静躁不同，当其欣于所遇，暂得于己，快然自足。"
          ]
        },
        {
          chapterUid: "c3",
          title: "岳阳楼记",
          wordCount: 800,
          lines: [
            "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴，乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上，属予作文以记之。",
            "予观夫巴陵胜状，在洞庭一湖。衔远山，吞长江，浩浩汤汤，横无际涯，朝晖夕阴，气象万千，此则岳阳楼之大观也。",
            "至若春和景明，波澜不惊，上下天光，一碧万顷，沙鸥翔集，锦鳞游泳，岸芷汀兰，郁郁青青。",
            "嗟夫！予尝求古仁人之心，或异二者之为，何哉？不以物喜，不以己悲，居庙堂之高则忧其民，处江湖之远则忧其君。"
          ]
        }
      ]
    },
    {
      bookId: "b2",
      title: "人间词话",
      author: "王国维",
      progress: 12,
      chapters: [
        { chapterUid: "d0", title: "封面", wordCount: 1, xml: true },
        {
          chapterUid: "d1",
          title: "境界说",
          wordCount: 300,
          lines: [
            "词以境界为最上。有境界则自成高格，自有名句。五代、北宋之词所以独绝者在此。",
            "有造境，有写境，此理想与写实二派之所由分。然二者颇难分别。因大诗人所造之境，必合乎自然，所写之境，亦必邻于理想故也。",
            "有有我之境，有无我之境。泪眼问花花不语，乱红飞过秋千去，有我之境也；采菊东篱下，悠然见南山，无我之境也。"
          ]
        },
        {
          chapterUid: "d2",
          title: "三种境界",
          wordCount: 400,
          lines: [
            "古今之成大事业、大学问者，必经过三种之境界：昨夜西风凋碧树。独上高楼，望尽天涯路。此第一境也。",
            "衣带渐宽终不悔，为伊消得人憔悴。此第二境也。",
            "众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。此第三境也。"
          ]
        }
      ]
    },
    {
      bookId: "b3",
      title: "世说新语",
      author: "刘义庆",
      progress: 0,
      chapters: [
        {
          chapterUid: "e1",
          title: "咏雪",
          lines: [
            "谢太傅寒雪日内集，与儿女讲论文义。俄而雪骤，公欣然曰：白雪纷纷何所似？兄子胡儿曰：撒盐空中差可拟。兄女曰：未若柳絮因风起。公大笑乐。",
            "陈太丘与友期行，期日中。过中不至，太丘舍去，去后乃至。元方时年七岁，门外戏。客问元方：尊君在不？答曰：待君久不至，已去。"
          ]
        }
      ]
    }
  ];

  // 模拟“择日飞升”这类上千章的书，用于目录章号 / 快速跳章 / 自动滚到当前章断言
  var BIG_BOOK_TITLES = ["风起青萍", "夜航船", "旧梦", "归途", "山雨欲来", "长夜行", "剑出鞘", "人间烟火", "大梦一场", "无声处"];
  var bigBookChapters = [];
  for (var bi = 1; bi <= 1060; bi++) {
    bigBookChapters.push({
      chapterUid: "b4-c" + bi,
      chapterIdx: bi,
      title: BIG_BOOK_TITLES[(bi - 1) % BIG_BOOK_TITLES.length],
      wordCount: 520 + (bi % 7) * 15,
      lines: [
        "第 " +
          bi +
          " 章的正文：山风从远处吹来，带着湿润的草木气味。他沿着石阶向上走，衣角被风掀起，远处的城郭在暮色里只剩一道模糊的轮廓。",
        "他想起许多年前的那个清晨，也曾这样站在这里，看云从山脚漫上来。如今人事已非，只有石阶上的青苔还和记忆里一模一样。"
      ]
    });
  }
  MOCK_BOOKS.push({
    bookId: "b4",
    title: "择日飞升",
    author: "宅猪",
    progress: 42,
    chapters: bigBookChapters
  });

  // 所有 mock 章节补上 1-based 原始章号（真实宿主 /chapters 会返回 chapterIdx）
  MOCK_BOOKS.forEach(function (book) {
    book.chapters.forEach(function (chapter, index) {
      if (chapter.chapterIdx === undefined) chapter.chapterIdx = index + 1;
    });
  });

  var mock = {
    loggedIn: true,
    currentBookId: "b1",
    user: { vid: 10086, nickname: "摸鱼选手" }
  };

  /* ================================================================== *
   * 假宿主：整本缓存状态机（idle → running → done / cancelled → delete）
   * ================================================================== */

  var mockCache = {};
  var CACHE_TICK_MS = 300;
  var CACHE_STEPS = 6;

  function cacheTotalFor(bookId) {
    var book = findBook(bookId);
    return book ? book.chapters.length : 0;
  }

  function cacheInfo(bookId) {
    if (!mockCache[bookId]) {
      mockCache[bookId] = {
        state: "idle",
        total: cacheTotalFor(bookId),
        cached: 0,
        chars: 0,
        bytes: 0,
        complete: false,
        currentChapter: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        timer: null
      };
    }
    return mockCache[bookId];
  }

  function cacheStatusPayload(bookId) {
    var c = cacheInfo(bookId);
    var book = findBook(bookId);
    var meta = c.complete
      ? {
          title: book ? book.title : "",
          author: book ? book.author : "",
          chars: c.chars,
          bytes: c.bytes,
          updatedAt: Date.now(),
          complete: true
        }
      : null;
    return {
      ok: true,
      bookId: bookId,
      state: c.state,
      total: c.total,
      cached: c.cached,
      chars: c.chars,
      bytes: c.bytes,
      complete: c.complete,
      currentChapter: c.currentChapter,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      error: c.error,
      meta: meta
    };
  }

  function cacheTick(bookId) {
    var c = cacheInfo(bookId);
    if (c.state !== "running") return;
    var step = Math.max(1, Math.ceil(c.total / CACHE_STEPS));
    c.currentChapter = Math.min(c.total, c.cached + 1);
    c.cached = Math.min(c.total, c.cached + step);
    c.chars = c.cached * 4200;
    c.bytes = c.chars * 3;
    if (c.cached >= c.total) {
      c.state = "done";
      c.complete = true;
      c.finishedAt = Date.now();
      if (c.timer) {
        clearInterval(c.timer);
        c.timer = null;
      }
    }
  }

  function startMockCache(bookId) {
    var c = cacheInfo(bookId);
    if (c.state === "running" || c.complete) return cacheStatusPayload(bookId);
    c.state = "running";
    c.complete = false;
    c.startedAt = Date.now();
    c.finishedAt = null;
    c.error = null;
    if (c.timer) clearInterval(c.timer);
    c.timer = setInterval(function () {
      cacheTick(bookId);
    }, CACHE_TICK_MS);
    return cacheStatusPayload(bookId);
  }

  function cancelMockCache(bookId) {
    var c = cacheInfo(bookId);
    if (c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
    c.state = "cancelled";
    c.complete = false;
    return { ok: true, state: "cancelled" };
  }

  function deleteMockCache(bookId) {
    var c = cacheInfo(bookId);
    if (c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
    mockCache[bookId] = null;
    return { ok: true };
  }

  /** 把 URL 预设（?cache=running|done|cancelled）灌进 mock 状态，供截图/手工验证 */
  function applyCachePreset(cacheParam, bookId) {
    if (!cacheParam) return;
    var c = cacheInfo(bookId);
    c.total = cacheTotalFor(bookId);
    if (cacheParam === "running") {
      c.state = "running";
      c.complete = false;
      c.cached = Math.max(1, Math.round(c.total * 0.12));
      c.currentChapter = c.cached;
      c.startedAt = Date.now();
    } else if (cacheParam === "done") {
      c.state = "done";
      c.complete = true;
      c.cached = c.total;
      c.startedAt = Date.now() - 60000;
      c.finishedAt = Date.now();
    } else if (cacheParam === "cancelled") {
      c.state = "cancelled";
      c.complete = false;
      c.cached = Math.max(1, Math.round(c.total * 0.3));
    }
    c.chars = c.cached * 4200;
    c.bytes = c.chars * 3;
  }

  function jsonResponse(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });
  }

  function findBook(bookId) {
    for (var i = 0; i < MOCK_BOOKS.length; i++) if (MOCK_BOOKS[i].bookId === bookId) return MOCK_BOOKS[i];
    return null;
  }

  function statusPayload() {
    return {
      ok: true,
      loggedIn: mock.loggedIn,
      sessionExpired: false,
      wereadReady: true,
      hostError: null,
      shelfError: null,
      user: mock.loggedIn ? mock.user : null,
      books: mock.loggedIn
        ? MOCK_BOOKS.map(function (b) {
            return {
              bookId: b.bookId,
              title: b.title,
              author: b.author,
              cover: "",
              progress: b.progress,
              chapterCount: b.chapters.length
            };
          })
        : [],
      currentBookId: mock.loggedIn ? mock.currentBookId : null
    };
  }

  function fakeQrDataUrl() {
    var n = 25;
    var cells = [];
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var finder =
          (x < 7 && y < 7 && (x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4))) ||
          (x >= n - 7 && y < 7 && (x === n - 7 || y === 0 || x === n - 1 || y === 6)) ||
          (x < 7 && y >= n - 7 && (x === 0 || y === n - 7 || x === 6 || y === n - 1));
        var noise = (x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0;
        if (finder || noise) cells.push('<rect x="' + x + '" y="' + y + '" width="1" height="1"/>');
      }
    }
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges">' +
      '<rect width="25" height="25" fill="#ffffff"/><g fill="#141414">' +
      cells.join("") +
      "</g></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function contentPayload(bookId, chapterUid, pos, maxChars) {
    var book = findBook(bookId);
    if (!book) return { ok: false, code: "NOT_FOUND", error: "book not found" };
    var chapterIndex = -1;
    for (var i = 0; i < book.chapters.length; i++) {
      if (String(book.chapters[i].chapterUid) === String(chapterUid)) chapterIndex = i;
    }
    if (chapterIndex < 0) return { ok: false, code: "NOT_FOUND", error: "chapter not found" };
    var chapter = book.chapters[chapterIndex];
    // 微信读书非正文页（封面/版权/目录）实测返回 XML/版权页，用来验证客户端的垃圾正文兜底
    if (chapter.xml) {
      var nextXmlChapter = book.chapters[chapterIndex + 1];
      return {
        ok: true,
        title: book.title,
        chapterTitle: chapter.title,
        chapterIndex: chapterIndex,
        chapterCount: book.chapters.length,
        source: cacheInfo(bookId).complete ? "cache" : "online",
        lines: [
          '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="np1"><navLabel><text>' +
            chapter.title +
            "</text></navLabel></navPoint></navMap></ncx>"
        ],
        pos: 1,
        progress: 100,
        hasMore: false,
        nextChapterUid: nextXmlChapter ? nextXmlChapter.chapterUid : null
      };
    }
    var start = parseInt(pos, 10);
    if (!isFinite(start) || start < 0) start = 0;
    var limit = parseInt(maxChars, 10);
    if (!isFinite(limit) || limit <= 0) limit = 1200;
    var lines = [];
    var chars = 0;
    var cursor = start;
    while (cursor < chapter.lines.length && (lines.length === 0 || chars < limit)) {
      lines.push(chapter.lines[cursor]);
      chars += chapter.lines[cursor].length;
      cursor++;
    }
    var hasMore = cursor < chapter.lines.length;
    var nextChapterUid = null;
    if (!hasMore && book.chapters[chapterIndex + 1]) nextChapterUid = book.chapters[chapterIndex + 1].chapterUid;
    var totalLines = chapter.lines.length;
    return {
      ok: true,
      title: book.title,
      chapterTitle: chapter.title,
      chapterIndex: chapterIndex,
      chapterCount: book.chapters.length,
      source: cacheInfo(bookId).complete ? "cache" : "online",
      lines: lines,
      pos: cursor,
      progress: totalLines ? Math.round((cursor / totalLines) * 100) : 0,
      hasMore: hasMore,
      nextChapterUid: nextChapterUid
    };
  }

  function mockFetch(input, init) {
    harness.mockCalls = (harness.mockCalls || 0) + 1;
    try {
      return mockFetchInner(input, init);
    } catch (err) {
      harness.errors.push("mockFetch: " + String(err && err.stack ? err.stack : err));
      return Promise.reject(err);
    }
  }

  function mockFetchInner(input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    harness.lastMockUrl = url;
    var method = ((init && init.method) || "GET").toUpperCase();
    var parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch (e) {
      parsed = new URL(url, "file:///");
    }
    var path = parsed.pathname;
    // file:// 下相对绝对路径会带上盘符（/D:/weread-moyu/...），统一裁到 API 前缀
    var apiIndex = path.indexOf("/weread-moyu/api/");
    if (apiIndex > 0) path = path.slice(apiIndex);
    var search = parsed.searchParams;
    harness.lastMockPath = path;
    harness.lastMockHref = parsed.href;

    if (path === "/weread-moyu/api/ping") return Promise.resolve(jsonResponse({ ok: true, version: "0.1.0" }));

    if (path === "/weread-moyu/api/status") return Promise.resolve(jsonResponse(statusPayload()));

    if (path === "/weread-moyu/api/qr") {
      return Promise.resolve(
        jsonResponse({ ok: true, uid: "mock-uid", qrDataUrl: fakeQrDataUrl(), expiresAt: Date.now() + 180000 })
      );
    }
    if (path === "/weread-moyu/api/qr/poll") {
      return Promise.resolve(jsonResponse({ ok: true, state: "waiting", user: null }));
    }
    if (path === "/weread-moyu/api/login/cookie" && method === "POST") {
      mock.loggedIn = true;
      return Promise.resolve(jsonResponse({ ok: true, user: mock.user }));
    }
    if (path === "/weread-moyu/api/logout" && method === "POST") {
      mock.loggedIn = false;
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    // ---- 整本缓存 API（假状态机）----
    function readJsonBody() {
      try {
        return JSON.parse((init && init.body) || "{}");
      } catch (e) {
        return {};
      }
    }
    if (path.indexOf("/weread-moyu/api/cache/") === 0) {
      var cacheBody = method === "POST" ? readJsonBody() : {};
      var cacheBookId =
        method === "POST" ? cacheBody.bookId || search.get("bookId") || "" : search.get("bookId") || "";
      if (!mock.loggedIn) {
        return Promise.resolve(jsonResponse({ ok: false, code: "NOT_LOGGED_IN", error: "not logged in" }));
      }
      if (path === "/weread-moyu/api/cache/download" && method === "POST") {
        return Promise.resolve(jsonResponse(startMockCache(cacheBookId)));
      }
      if (path === "/weread-moyu/api/cache/status") {
        return Promise.resolve(jsonResponse(cacheStatusPayload(cacheBookId)));
      }
      if (path === "/weread-moyu/api/cache/cancel" && method === "POST") {
        return Promise.resolve(jsonResponse(cancelMockCache(cacheBookId)));
      }
      if (path === "/weread-moyu/api/cache/delete" && method === "POST") {
        return Promise.resolve(jsonResponse(deleteMockCache(cacheBookId)));
      }
      if (path === "/weread-moyu/api/cache/list") {
        return Promise.resolve(jsonResponse({ ok: true, books: [] }));
      }
    }

    var chaptersMatch = /^\/weread-moyu\/api\/books\/([^/]+)\/chapters$/.exec(path);
    if (chaptersMatch) {
      var book = findBook(decodeURIComponent(chaptersMatch[1]));
      if (!book) return Promise.resolve(jsonResponse({ ok: false, code: "NOT_FOUND", error: "book not found" }));
      return Promise.resolve(
        jsonResponse({
          ok: true,
          chapters: book.chapters.map(function (c, i) {
            return {
              chapterUid: c.chapterUid,
              chapterIdx: c.chapterIdx !== undefined ? c.chapterIdx : i + 1,
              title: c.title,
              level: i === 0 ? 1 : 2,
              wordCount: c.wordCount !== undefined ? c.wordCount : c.lines.join("").length
            };
          })
        })
      );
    }

    if (path === "/weread-moyu/api/content") {
      harness.lastContentUrl = url;
      return Promise.resolve(
        jsonResponse(
          contentPayload(
            search.get("bookId") || "",
            search.get("chapterUid") || "",
            search.get("pos") || "0",
            search.get("maxChars") || "0"
          )
        )
      );
    }

    return Promise.resolve(new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }));
  }

  /* ================================================================== *
   * 断言
   * ================================================================== */

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function waitFor(predicate, timeout, interval) {
    var started = Date.now();
    var limit = timeout || 4000;
    while (Date.now() - started < limit) {
      try {
        if (predicate()) return true;
      } catch (e) {
        /* keep polling */
      }
      await sleep(interval || 120);
    }
    try {
      return !!predicate();
    } catch (e) {
      return false;
    }
  }

  function alphaOf(color) {
    var match = /^rgba?\(([^)]+)\)/.exec(color || "");
    if (!match) return null;
    var parts = match[1].split(",").map(function (v) {
      return parseFloat(v);
    });
    return parts.length > 3 ? parts[3] : 1;
  }

  async function runAssertions() {
    var results = [];
    function ok(name, condition, detail) {
      results.push({ name: name, pass: !!condition, detail: detail === undefined ? "" : String(detail) });
    }

    var exp = harness.exports || {};
    var dbg = window.__wereadMoyu;
    var mockMode = harness.mock;

    // 等宿主/内容异步链路稳定（mock 模式等真实正文；demo 模式等演示文本 + 宿主失败）
    if (dbg) {
      if (mockMode) {
        await waitFor(function () {
          var current = window.__wereadMoyu && window.__wereadMoyu.getState();
          return current && current.loggedIn && current.contentHeight > 200;
        }, 6000);
      } else {
        await waitFor(function () {
          var current = window.__wereadMoyu && window.__wereadMoyu.getState();
          return current && current.hostReady === false && current.contentHeight > 200;
        }, 4000);
      }
    }
    await sleep(300);

    if (mockMode) {
      try {
        var pingRes = await window.fetch("/weread-moyu/api/ping");
        harness.manualPing = { status: pingRes.status, body: await pingRes.text() };
      } catch (err) {
        harness.manualPing = "ERR " + String(err && err.message ? err.message : err);
      }
    }

    ok("bundle-id", harness.rows.length === 1 && harness.rows[0].id === "dsh-weread-moyu", harness.rows.map(function (r) { return r.id; }).join(","));
    ok("exports-name", exp.name === "weread-moyu", exp.name);
    ok("exports-apply", typeof exp.apply === "function");
    ok("exports-inject", Array.isArray(exp.inject));
    ok("debug-api", !!dbg);

    var layer = document.getElementById("weread-moyu-layer");
    ok("layer-exists", !!layer);
    if (layer) {
      var layerStyle = getComputedStyle(layer);
      ok("layer-position-fixed", layerStyle.position === "fixed", layerStyle.position);
      ok(
        "layer-inset-0",
        layerStyle.top === "0px" && layerStyle.right === "0px" && layerStyle.bottom === "0px" && layerStyle.left === "0px",
        [layerStyle.top, layerStyle.right, layerStyle.bottom, layerStyle.left].join(",")
      );
      ok("layer-pointer-events-none", layerStyle.pointerEvents === "none", layerStyle.pointerEvents);
      ok("layer-z-index-0", layerStyle.zIndex === "0", layerStyle.zIndex);
      ok("layer-font-size-var", layerStyle.getPropertyValue("--wm-size").trim() === "16px", layerStyle.getPropertyValue("--wm-size").trim());
      var text = layer.textContent || "";
      ok("layer-has-cjk-text", text.replace(/\s/g, "").length > 100 && /[\u4e00-\u9fa5]/.test(text), "len=" + text.length);
      var page = layer.querySelector(".wm-page");
      var pageOpacity = page ? parseFloat(getComputedStyle(page).opacity) : NaN;
      var initialOpacity = dbg ? dbg.getConfig().opacity : 0.18;
      ok(
        "layer-default-opacity",
        page && Math.abs(pageOpacity - initialOpacity) < 0.001 && pageOpacity >= 0.12 && pageOpacity <= 0.2,
        pageOpacity
      );
      ok("layer-not-in-root", !document.getElementById("root").contains(layer));
      ok("layer-does-not-block-clicks", document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2) !== layer);
    }

    ok("body-background-transparent", getComputedStyle(document.body).backgroundColor === "rgba(0, 0, 0, 0)", getComputedStyle(document.body).backgroundColor);
    var root = document.getElementById("root");
    ok("root-background-transparent", getComputedStyle(root).backgroundColor === "rgba(0, 0, 0, 0)", getComputedStyle(root).backgroundColor);
    var frame = document.querySelector(".BynINW_frame");
    var frameAlpha = frame ? alphaOf(getComputedStyle(frame).backgroundColor) : null;
    ok("frame-semi-transparent", frameAlpha !== null && frameAlpha < 1 && frameAlpha > 0, frame && getComputedStyle(frame).backgroundColor);

    var dot = document.getElementById("weread-moyu-dot");
    ok("dot-exists", !!dot);
    if (dot) {
      var dotRect = dot.getBoundingClientRect();
      ok("dot-size-14", Math.round(dotRect.width) === 14 && Math.round(dotRect.height) === 14, dotRect.width + "x" + dotRect.height);
      ok("dot-low-opacity", Math.abs(parseFloat(getComputedStyle(dot).opacity) - 0.25) < 0.001, getComputedStyle(dot).opacity);
      ok("dot-bottom-right", dotRect.right > window.innerWidth - 40 && dotRect.bottom > window.innerHeight - 40);
    }

    // 宿主数据流（mock）或 demo 模式
    var st = dbg ? dbg.getState() : {};
    if (mockMode) {
      ok("host-ready", st.hostReady === true, st.hostReady);
      ok("logged-in", st.loggedIn === true, st.loggedIn);
      ok("real-content-mode", st.demo === false, st.demo);
      ok("content-request-uses-maxchars", !!harness.lastContentUrl && /maxChars=\d+/.test(harness.lastContentUrl), harness.lastContentUrl);
      ok("real-content-loaded", (st.contentHeight || 0) > 200, st.contentHeight);
      ok("real-chapter-title", !!st.chapterTitle, st.chapterTitle);
      // TOC 前 4 项是封面/版权/目录/序言(300字)，自动起读应落到第一个非垃圾且 >=500 字的正文章节 c1
      ok("auto-start-skips-junk-pages", st.chapterTitle === "桃花源记", st.chapterTitle);
      ok("auto-start-prefers-long-chapter", st.chapterTitle !== "序言", st.chapterTitle);
    } else {
      ok("host-not-ready-demo", st.hostReady === false, st.hostReady);
      ok("demo-mode", st.demo === true, st.demo);
      ok("demo-content-loaded", (st.contentHeight || 0) > 200, st.contentHeight);
      ok("demo-no-error-spam", harness.errors.length === 0, harness.errors.join("; "));
      if (layer) {
        var statusText = layer.querySelector(".wm-status");
        ok("demo-layer-hint", !!statusText && /演示/.test(statusText.textContent || ""), statusText && statusText.textContent);
      }
      // demo 模式也能用 peek：直接显示内置演示文本
      var demoPeekBtn = document.getElementById("weread-moyu-peek");
      var demoPeekPanel = document.getElementById("weread-moyu-peek-panel");
      ok("demo-peek-exists", !!demoPeekBtn && !!demoPeekPanel);
      if (demoPeekBtn && demoPeekPanel) {
        demoPeekBtn.click();
        await sleep(160);
        ok("demo-peek-opens", demoPeekPanel.hidden === false, demoPeekPanel.hidden);
        ok(
          "demo-peek-body",
          (demoPeekPanel.querySelector(".wm-peek-body").textContent || "").replace(/\s/g, "").length > 80
        );
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(120);
        ok("demo-peek-esc-closes", demoPeekPanel.hidden === true && dbg.getState().peekOpen === false);
      }
      // demo / 未登录：跳章控件存在于 DOM，但章节区隐藏，不应报错
      dbg.openPanel();
      await sleep(160);
      var demoJumpInput = document.getElementById("wm-jump-input");
      ok("demo-jump-controls-hidden", !!demoJumpInput && demoJumpInput.closest(".wm-sec").hidden === true);
      ok(
        "demo-cache-hidden",
        !!document.querySelector(".wm-cache-sec") && document.querySelector(".wm-cache-sec").hidden === true
      );
      dbg.closePanel();
      ok("demo-jump-no-error", harness.errors.length === 0, harness.errors.join("; "));
    }

    var panel = document.getElementById("weread-moyu-panel");
    ok("panel-hidden-by-default", !!panel && panel.hidden === true);
    if (dbg && panel) {
      dbg.openPanel();
      await sleep(150);
      ok("panel-opens", panel.hidden === false);
      ok("panel-width-360", Math.abs(panel.getBoundingClientRect().width - 360) < 0.5, panel.getBoundingClientRect().width);
      ok("panel-has-login", !!panel.querySelector(".wm-btn") && !!panel.querySelector("textarea"));
      ok("panel-has-3-sliders", panel.querySelectorAll(".wm-slide input[type=range]").length === 3, panel.querySelectorAll(".wm-slide input[type=range]").length);
      ok("panel-has-2-toggles", panel.querySelectorAll(".wm-toggle input[type=checkbox]").length === 2);
      ok("panel-is-interactive", getComputedStyle(panel).pointerEvents !== "none");
      var sourceHint = panel.textContent || "";
      if (mockMode) {
        await sleep(500);
        var bookItems = panel.querySelectorAll(".wm-list .wm-item");
        ok("panel-books-rendered", bookItems.length >= 3, bookItems.length);
        var chapterItems = panel.querySelectorAll(".wm-sec:nth-of-type(4) .wm-item");
        ok("panel-chapters-rendered", panel.querySelectorAll(".wm-list")[1] && panel.querySelectorAll(".wm-list")[1].children.length >= 3);
        ok("panel-user-logged-in", /已登录/.test(sourceHint));

        // 章节过滤：非正文页默认折叠灰显；wordCount 汇总；可手动展开
        var visibleChapterRows = panel.querySelectorAll(".wm-list")[1].querySelectorAll(".wm-item").length;
        ok("chapters-junk-hidden-by-default", panel.querySelectorAll(".wm-item-junk").length === 0, panel.querySelectorAll(".wm-item-junk").length);
        ok("chapters-readable-count", visibleChapterRows === 4, visibleChapterRows);
        var junkToggle = panel.querySelector(".wm-junk-toggle");
        ok(
          "chapters-junk-toggle-visible",
          !!junkToggle && junkToggle.hidden === false && /显示非正文页面（3）/.test(junkToggle.textContent || ""),
          junkToggle && junkToggle.textContent
        );
        var wordsEl = panel.querySelector(".wm-chapters-words");
        ok("chapters-word-total", !!wordsEl && /2900字/.test(wordsEl.textContent || ""), wordsEl && wordsEl.textContent);
        var countEl = panel.querySelector(".wm-chapters-count");
        ok("chapters-header-count", /共\s*7\s*章/.test(countEl && countEl.textContent || ""), countEl && countEl.textContent);
        var chNoCells = Array.prototype.slice.call(
          panel.querySelectorAll(".wm-list")[1].querySelectorAll(".wm-ch-no")
        );
        ok(
          "chapters-rows-have-number",
          chNoCells.length === visibleChapterRows &&
            chNoCells.every(function (cell) {
              return /第\s*\d+\s*章/.test(cell.textContent || "");
            }),
          chNoCells.map(function (cell) { return cell.textContent; }).join(",")
        );
        var jumpInput = panel.querySelector("#wm-jump-input");
        var jumpBtn = panel.querySelector("#wm-jump-btn");
        ok("chapters-jump-controls", !!jumpInput && !!jumpBtn);
        if (junkToggle) {
          junkToggle.click();
          await sleep(100);
          ok("junk-toggle-reveals", panel.querySelectorAll(".wm-item-junk").length === 3, panel.querySelectorAll(".wm-item-junk").length);
          ok("junk-toggle-label-switches", /隐藏非正文页面/.test(junkToggle.textContent || ""), junkToggle.textContent);
          var junkNos = Array.prototype.slice
            .call(panel.querySelectorAll(".wm-item-junk .wm-ch-no"))
            .map(function (cell) {
              return cell.textContent || "";
            });
          ok(
            "junk-rows-show-original-number",
            junkNos.length === 3 &&
              junkNos.every(function (text) {
                return /第\s*\d+\s*章/.test(text);
              }) &&
              junkNos[0].indexOf("第 1 章") >= 0,
            junkNos.join(",")
          );
          junkToggle.click();
          await sleep(100);
          ok("junk-toggle-hides-again", panel.querySelectorAll(".wm-item-junk").length === 0);
        }
      } else {
        ok(
          "panel-guest-login",
          /扫码登录/.test(sourceHint) && panel.querySelector(".wm-user") && panel.querySelector(".wm-user").hidden === true,
          panel.querySelector(".wm-user") && panel.querySelector(".wm-user").hidden
        );
      }
      ok("panel-source-hint", /内容来源：/.test(sourceHint), sourceHint.slice(0, 60));

      // 滑块/开关走真实 DOM 交互，验证即时生效
      var opacitySlider = panel.querySelector("#wm-c-opacity");
      opacitySlider.value = "25";
      opacitySlider.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(120);
      ok("slider-opacity-immediate", Math.abs((dbg.getConfig().opacity || 0) - 0.25) < 0.001, dbg.getConfig().opacity);
      var pageNow = document.querySelector("#weread-moyu-layer .wm-page");
      ok("slider-opacity-applied", pageNow && Math.abs(parseFloat(getComputedStyle(pageNow).opacity) - 0.25) < 0.01, pageNow && getComputedStyle(pageNow).opacity);

      var fontSlider = panel.querySelector("#wm-c-font");
      fontSlider.value = "18";
      fontSlider.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(80);
      ok("slider-font-immediate", dbg.getConfig().fontSize === 18, dbg.getConfig().fontSize);
      ok("slider-font-applied", layer.style.getPropertyValue("--wm-size").trim() === "18px", layer.style.getPropertyValue("--wm-size").trim());

      var enabledToggle = panel.querySelector("#wm-c-enabled");
      enabledToggle.click();
      await sleep(150);
      ok("toggle-enabled-off", dbg.getConfig().enabled === false, dbg.getConfig().enabled);
      ok("toggle-enabled-off-class", document.documentElement.classList.contains("weread-moyu-off"));
      ok("toggle-enabled-hides-layer", getComputedStyle(document.getElementById("weread-moyu-layer")).display === "none");
      ok("toggle-enabled-restores-opaque-shell", alphaOf(getComputedStyle(frame).backgroundColor) === 1, getComputedStyle(frame).backgroundColor);
      enabledToggle.click();
      await sleep(150);
      ok("toggle-enabled-on", dbg.getConfig().enabled === true && !document.documentElement.classList.contains("weread-moyu-off"));

      var throughToggle = panel.querySelector("#wm-c-through");
      throughToggle.click();
      await sleep(60);
      ok("toggle-through-off", dbg.getConfig().clickThrough === false && layer.style.pointerEvents === "auto");
      throughToggle.click();
      await sleep(60);
      ok("toggle-through-on", dbg.getConfig().clickThrough === true && layer.style.pointerEvents === "none");

      // localStorage 持久化（debounce 350ms）
      dbg.flushConfig();
      var stored = null;
      try {
        stored = JSON.parse(window.localStorage.getItem("weread-moyu:config"));
      } catch (e) {
        stored = null;
      }
      if (stored) {
        ok("config-persisted", Math.abs(stored.opacity - 0.25) < 0.001 && stored.fontSize === 18, stored.opacity + "/" + stored.fontSize);
      } else {
        results.push({ name: "config-persisted", pass: false, detail: "localStorage 不可用（file:// 环境限制）" });
      }

      // 滚动（__testAdvance 绕开 headless rAF 限制，验证滚动数学）
      var speedSlider = panel.querySelector("#wm-c-speed");
      speedSlider.value = "3";
      speedSlider.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(80);
      ok("slider-speed-immediate", dbg.getConfig().speed === 3, dbg.getConfig().speed);
      var beforeOffset = dbg.getState().offset;
      var afterOffset = dbg.__testAdvance(600);
      ok("scroll-advances", afterOffset > beforeOffset + 10, beforeOffset.toFixed(2) + " -> " + afterOffset.toFixed(2));
      ok("ticker-running", dbg.getState().running === true);

      // resize：层仍铺满视口，面板仍固定宽 360
      window.dispatchEvent(new Event("resize"));
      await sleep(120);
      var lr = document.getElementById("weread-moyu-layer").getBoundingClientRect();
      ok("resize-layer-fullscreen", Math.abs(lr.width - window.innerWidth) < 2 && Math.abs(lr.height - window.innerHeight) < 2, lr.width + "x" + lr.height);
      ok("resize-panel-width", Math.abs(panel.getBoundingClientRect().width - 360) < 0.5, panel.getBoundingClientRect().width);
      ok("resize-no-error", harness.errors.length === 0, harness.errors.join("; "));

      // peek 浮层：看清当前页
      var peekBtn = document.getElementById("weread-moyu-peek");
      var peekPanel = document.getElementById("weread-moyu-peek-panel");
      ok("peek-button-exists", !!peekBtn && !!peekPanel);
      if (peekBtn && peekPanel) {
        var peekBtnOpacity = parseFloat(getComputedStyle(peekBtn).opacity);
        var peekBtnRect = peekBtn.getBoundingClientRect();
        ok("peek-button-low-opacity", isFinite(peekBtnOpacity) && peekBtnOpacity <= 0.3, peekBtnOpacity);
        ok(
          "peek-button-size-18",
          Math.round(peekBtnRect.width) === 18 && Math.round(peekBtnRect.height) === 18,
          peekBtnRect.width + "x" + peekBtnRect.height
        );
        ok("peek-panel-hidden-default", peekPanel.hidden === true);

        var stateBeforePeek = dbg.getState();
        peekBtn.click();
        await sleep(180);
        ok("peek-opens", peekPanel.hidden === false && dbg.getState().peekOpen === true, dbg.getState().peekOpen);
        var peekTextBefore = (peekPanel.querySelector(".wm-peek-body").textContent || "").trim();
        ok("peek-body-has-text", peekTextBefore.replace(/\s/g, "").length > 80, peekTextBefore.length);
        ok(
          "peek-header-book",
          (peekPanel.querySelector(".wm-peek-book").textContent || "").indexOf(stateBeforePeek.title) >= 0,
          peekPanel.querySelector(".wm-peek-book").textContent
        );
        ok(
          "peek-header-chapter",
          (peekPanel.querySelector(".wm-peek-chap").textContent || "").indexOf(stateBeforePeek.chapterTitle) >= 0,
          peekPanel.querySelector(".wm-peek-chap").textContent
        );

        // 打开时冻结背景自动滚动
        dbg.setConfig({ speed: 3 });
        var frozenOffset = dbg.getState().offset;
        dbg.__testAutoScroll(800);
        ok(
          "peek-pauses-auto-scroll",
          Math.abs(dbg.getState().offset - frozenOffset) < 0.01,
          frozenOffset.toFixed(1) + " -> " + dbg.getState().offset.toFixed(1)
        );

        // 连续滚动阅读：浮层是背景层内容的完整镜像；滚到底自动续载（无缝、无重复段落）
        var peekBody = peekPanel.querySelector(".wm-peek-body");
        var peekOffsetBefore = dbg.getState().offset;
        ok(
          "peek-scrollable",
          peekBody.scrollHeight > peekBody.clientHeight,
          peekBody.scrollHeight + "/" + peekBody.clientHeight
        );
        var parasBefore = peekBody.querySelectorAll("p").length;
        peekBody.scrollTop = peekBody.scrollHeight;
        peekBody.dispatchEvent(new Event("scroll"));
        await sleep(900);
        var parasAfter = peekBody.querySelectorAll("p").length;
        var peekHintText = (peekPanel.querySelector(".wm-peek-hint") || {}).textContent || "";
        ok(
          "peek-scroll-auto-loads",
          parasAfter > parasBefore || /已是最后一章/.test(peekHintText),
          parasBefore + " -> " + parasAfter + " hint=" + peekHintText
        );

        // 关闭浮层：背景层同步到浮层当前阅读位置
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(150);
        ok("peek-esc-closes", peekPanel.hidden === true && dbg.getState().peekOpen === false);
        ok(
          "peek-close-syncs-background",
          dbg.getState().offset > peekOffsetBefore + 100,
          peekOffsetBefore.toFixed(1) + " -> " + dbg.getState().offset.toFixed(1)
        );
        var resumeOffset = dbg.getState().offset;
        dbg.__testAutoScroll(600);
        ok(
          "peek-close-resumes-scroll",
          dbg.getState().offset > resumeOffset + 5,
          resumeOffset.toFixed(1) + " -> " + dbg.getState().offset.toFixed(1)
        );

        // 再点 peek 按钮：打开后再点一次关闭
        peekBtn.click();
        await sleep(140);
        ok("peek-button-reopens", peekPanel.hidden === false);
        peekBtn.click();
        await sleep(140);
        ok("peek-button-toggles-close", peekPanel.hidden === true && dbg.getState().peekOpen === false);

        // 上一章 / 下一章按钮
        peekBtn.click();
        await sleep(160);
        var prevChBtn = peekPanel.querySelector(".wm-peek-prev-ch");
        var nextChBtn = peekPanel.querySelector(".wm-peek-next-ch");
        ok("peek-chapter-buttons-exist", Boolean(prevChBtn && nextChBtn));
        var chapterBeforeJump = dbg.getState().chapterTitle;
        if (dbg.getState().demo) {
          // demo 模式没有章节目录：仅验证按钮给出引导提示
          nextChBtn.click();
          await sleep(250);
          var demoHintText = (peekPanel.querySelector(".wm-peek-hint") || {}).textContent || "";
          ok("peek-chapter-demo-hint", /演示文本/.test(demoHintText), demoHintText);
        } else {
          nextChBtn.click();
          await waitFor(function () {
            var s = window.__wereadMoyu && window.__wereadMoyu.getState();
            var hint = (peekPanel.querySelector(".wm-peek-hint") || {}).textContent || "";
            return s && !s.loading && (s.chapterTitle !== chapterBeforeJump || /已是最后一章/.test(hint));
          }, 8000);
          var stateAfterJump = dbg.getState();
          var hintAfterJump = (peekPanel.querySelector(".wm-peek-hint") || {}).textContent || "";
          ok(
            "peek-next-chapter-works",
            stateAfterJump.chapterTitle !== chapterBeforeJump || /已是最后一章/.test(hintAfterJump),
            chapterBeforeJump + " -> " + stateAfterJump.chapterTitle + " hint=" + hintAfterJump
          );
          if (stateAfterJump.chapterTitle !== chapterBeforeJump) {
            // 能进下一章时，再验证上一章能回来
            prevChBtn.click();
            await waitFor(function () {
              var s = window.__wereadMoyu && window.__wereadMoyu.getState();
              return s && !s.loading && s.loadedOnce && s.chapterTitle === chapterBeforeJump;
            }, 8000);
            ok("peek-prev-chapter-returns", dbg.getState().chapterTitle === chapterBeforeJump, dbg.getState().chapterTitle);
          }
        }
        peekBtn.click();
        await sleep(140);

        dbg.setConfig({ speed: 0 });
      }

      if (mockMode) {
        // 跳章：跳到非正文页 → 提示并落到最近正文章（b1 第 1 章封面 → 第 4 章序言）
        jumpInput = panel.querySelector("#wm-jump-input");
        jumpBtn = panel.querySelector("#wm-jump-btn");
        jumpInput.value = "1";
        jumpBtn.click();
        await waitFor(function () {
          var s = window.__wereadMoyu && window.__wereadMoyu.getState();
          return s && !s.loading && s.loadedOnce && s.chapterTitle === "序言";
        }, 8000);
        ok("jump-junk-lands-readable", dbg.getState().chapterTitle === "序言", dbg.getState().chapterTitle);
        ok(
          "jump-junk-hint",
          /非正文页/.test((panel.querySelector(".wm-toast").textContent || "")),
          panel.querySelector(".wm-toast").textContent
        );

        // 垃圾正文兜底：手动选「封面」→ 自动跳过 XML/版权页，最终落到「序言」正文
        dbg.__testSelectChapter("c_cover");
        await waitFor(function () {
          var s = window.__wereadMoyu && window.__wereadMoyu.getState();
          return s && !s.loading && s.loadedOnce && s.chapterTitle === "序言";
        }, 8000);
        var afterSkip = dbg.getState();
        var layerTextAfterSkip = (document.getElementById("weread-moyu-layer").textContent || "");
        ok("junk-content-fallback", afterSkip.chapterTitle === "序言", afterSkip.chapterTitle + "/" + afterSkip.chapterUid);
        ok(
          "junk-content-not-xml",
          layerTextAfterSkip.indexOf("<?xml") === -1 && layerTextAfterSkip.indexOf("ncx") === -1,
          layerTextAfterSkip.slice(0, 60)
        );

        // 没有 >=500 字正文页时，回退到第一个非垃圾章节
        dbg.__testSelectBook("b2");
        await waitFor(function () {
          var s = window.__wereadMoyu && window.__wereadMoyu.getState();
          return s && s.bookId === "b2" && !s.loading && s.loadedOnce && s.chapterTitle === "境界说";
        }, 8000);
        var fallbackState = dbg.getState();
        ok(
          "auto-start-fallback-first-readable",
          fallbackState.chapterUid === "d1" || fallbackState.chapterTitle === "境界说",
          fallbackState.chapterUid + "/" + fallbackState.chapterTitle
        );
        ok("book-switch-no-error", harness.errors.length === 0, harness.errors.join("; "));

        // 上千章的目录：章号、跳第 500 章、当前章高亮/自动滚动、状态行章号
        dbg.__testSelectBook("b4");
        await waitFor(function () {
          var s = window.__wereadMoyu && window.__wereadMoyu.getState();
          return s && s.bookId === "b4" && s.chapterCount === 1060 && !s.loading && s.loadedOnce;
        }, 15000);
        var bigState = dbg.getState();
        ok("big-book-loaded", bigState.chapterCount === 1060, bigState.chapterCount);
        var bigCountEl = panel.querySelector(".wm-chapters-count");
        ok(
          "big-book-header-count",
          /共\s*1060\s*章/.test((bigCountEl && bigCountEl.textContent) || ""),
          bigCountEl && bigCountEl.textContent
        );

        jumpInput = panel.querySelector("#wm-jump-input");
        jumpBtn = panel.querySelector("#wm-jump-btn");
        jumpInput.value = "500";
        jumpBtn.click();
        await waitFor(function () {
          var s = window.__wereadMoyu && window.__wereadMoyu.getState();
          return s && s.chapterNo === 500 && !s.loading && s.loadedOnce;
        }, 12000);
        var st500 = dbg.getState();
        ok("jump-500-selected", st500.chapterNo === 500, st500.chapterNo);
        var currentRow = panel.querySelector('.wm-list .wm-item[data-current="1"]');
        ok(
          "jump-500-row-highlight",
          !!currentRow && /第\s*500\s*章/.test((currentRow.querySelector(".wm-ch-no").textContent || "")),
          currentRow && currentRow.querySelector(".wm-ch-no").textContent
        );
        var readingTextEl = panel.querySelector(".wm-reading-text");
        ok(
          "jump-500-reading-status",
          /第\s*500\s*章/.test((readingTextEl && readingTextEl.textContent) || ""),
          readingTextEl && readingTextEl.textContent
        );
        var chapterListEl = panel.querySelectorAll(".wm-list")[1];
        var listRect = chapterListEl.getBoundingClientRect();
        var rowRect = currentRow ? currentRow.getBoundingClientRect() : null;
        ok(
          "jump-500-row-visible",
          !!rowRect && rowRect.top >= listRect.top - 1 && rowRect.bottom <= listRect.bottom + 1,
          rowRect && rowRect.top + "/" + rowRect.bottom + " list " + listRect.top + "/" + listRect.bottom
        );

        // 关掉再打开目录：自动滚动到当前章，且章号仍在
        dbg.closePanel();
        await sleep(100);
        dbg.openPanel();
        await sleep(250);
        var reopenListRect = panel.querySelectorAll(".wm-list")[1].getBoundingClientRect();
        var reopenRow = panel.querySelector('.wm-list .wm-item[data-current="1"]');
        var reopenRowRect = reopenRow ? reopenRow.getBoundingClientRect() : null;
        ok(
          "open-panel-scrolls-to-current",
          !!reopenRowRect && reopenRowRect.top >= reopenListRect.top - 1 && reopenRowRect.bottom <= reopenListRect.bottom + 1,
          reopenRow && reopenRowRect.top
        );

        // 非法/超范围：轻提示、状态不变、不报错
        jumpInput = panel.querySelector("#wm-jump-input");
        jumpBtn = panel.querySelector("#wm-jump-btn");
        jumpInput.value = "99999";
        jumpBtn.click();
        await sleep(180);
        ok(
          "jump-out-of-range-hint",
          /超出范围|共\s*1060\s*章/.test((panel.querySelector(".wm-toast").textContent || "")),
          panel.querySelector(".wm-toast").textContent
        );
        ok("jump-out-of-range-noop", dbg.getState().chapterNo === 500, dbg.getState().chapterNo);
        ok("jump-no-error", harness.errors.length === 0, harness.errors.join("; "));

        // 整本缓存 UI：idle → running → done → 清除；取消/继续；source 标识；切书任务不中断
        await waitFor(function () {
          var s = dbg.getState();
          return s.bookId === "b4" && s.cacheLoaded;
        }, 8000);
        var cacheTextEl = panel.querySelector("#wm-cache-text");
        var cachePrimaryEl = panel.querySelector("#wm-cache-primary");
        var cacheCancelEl = panel.querySelector("#wm-cache-cancel");
        var cacheDeleteEl = panel.querySelector("#wm-cache-delete");
        var cacheSecEl = panel.querySelector(".wm-cache-sec");
        ok("cache-section-visible", !!cacheSecEl && cacheSecEl.hidden === false, cacheSecEl && cacheSecEl.hidden);
        ok(
          "cache-idle-button",
          !!cachePrimaryEl && cachePrimaryEl.hidden === false && /缓存整本/.test(cachePrimaryEl.textContent || ""),
          cachePrimaryEl && cachePrimaryEl.textContent
        );
        ok("cache-idle-words", /约/.test(cachePrimaryEl.textContent || ""), cachePrimaryEl.textContent);

        cachePrimaryEl.click();
        await waitFor(function () {
          return dbg.getState().cacheState === "running";
        }, 8000);
        await sleep(120);
        ok(
          "cache-running-text",
          /缓存中\s*\d+\/\d+\s*·\s*\d+%/.test(cacheTextEl.textContent || ""),
          cacheTextEl.textContent
        );
        ok("cache-running-cancel-visible", !!cacheCancelEl && cacheCancelEl.hidden === false);
        ok("cache-polling", dbg.getState().cachePolling === true);

        await waitFor(function () {
          return dbg.getState().cacheComplete === true;
        }, 15000);
        ok("cache-done-text", /已缓存/.test(cacheTextEl.textContent || ""), cacheTextEl.textContent);
        ok("cache-done-size", /(KB|MB)/.test(cacheTextEl.textContent || ""), cacheTextEl.textContent);
        ok("cache-done-delete-visible", !!cacheDeleteEl && cacheDeleteEl.hidden === false);

        // 缓存命中：/content 返回 source=cache，状态行 + peek 都显示「本地缓存」
        dbg.__testSelectChapter("b4-c501");
        await waitFor(function () {
          var s = dbg.getState();
          return s.source === "cache" && s.loadedOnce && !s.loading;
        }, 10000);
        var readingEl = panel.querySelector(".wm-reading-text");
        ok("cache-source-reading", /本地缓存/.test((readingEl && readingEl.textContent) || ""), readingEl && readingEl.textContent);
        dbg.openPeek();
        await sleep(220);
        var peekProgEl = document.querySelector("#weread-moyu-peek-panel .wm-peek-progress");
        ok(
          "cache-source-peek",
          /本地缓存/.test((peekProgEl && peekProgEl.textContent) || ""),
          peekProgEl && peekProgEl.textContent
        );
        dbg.closePeek();
        await sleep(100);

        // 清除缓存
        cacheDeleteEl.click();
        await waitFor(function () {
          var s = dbg.getState();
          return s.cacheLoaded && (s.cacheState === null || s.cacheState === "idle");
        }, 8000);
        ok("cache-cleared-text", /尚未缓存/.test(cacheTextEl.textContent || ""), cacheTextEl.textContent);
        ok("cache-cleared-primary", cachePrimaryEl.hidden === false);
        ok("cache-cleared-delete-hidden", cacheDeleteEl.hidden === true);

        // 部分缓存：下载 → 取消 → 继续缓存 → 完成
        cachePrimaryEl.click();
        await waitFor(function () {
          return dbg.getState().cacheState === "running";
        }, 8000);
        await sleep(480); // 让 mock 至少推进一章，取消后才会是「部分缓存」
        cacheCancelEl.click();
        await waitFor(function () {
          return dbg.getState().cacheState === "cancelled";
        }, 8000);
        ok(
          "cache-partial-continue",
          /继续缓存/.test(cachePrimaryEl.textContent || "") && cachePrimaryEl.hidden === false,
          cachePrimaryEl.textContent
        );
        ok("cache-partial-delete", cacheDeleteEl.hidden === false);
        cachePrimaryEl.click();
        await waitFor(function () {
          return dbg.getState().cacheComplete === true;
        }, 15000);
        ok("cache-continue-completes", dbg.getState().cacheComplete === true);

        // 切书：b1 未缓存；切走/切回，后台任务与状态都还在
        dbg.__testSelectBook("b1");
        await waitFor(function () {
          var s = dbg.getState();
          return s.bookId === "b1" && s.cacheLoaded;
        }, 8000);
        ok("cache-switch-book-idle", /尚未缓存/.test(cacheTextEl.textContent || ""), cacheTextEl.textContent);
        cachePrimaryEl.click();
        await waitFor(function () {
          return dbg.getState().cacheState === "running";
        }, 8000);
        dbg.__testSelectBook("b4");
        await waitFor(function () {
          var s = dbg.getState();
          return s.bookId === "b4" && s.cacheLoaded;
        }, 8000);
        ok(
          "cache-switch-back-state",
          /已缓存/.test(cacheTextEl.textContent || "") && dbg.getState().cacheComplete === true,
          cacheTextEl.textContent
        );
        ok("cache-no-error", harness.errors.length === 0, harness.errors.join("; "));
      }

      // 面板关闭 & 不拦截点击
      dbg.closePanel();
      ok("panel-closes", panel.hidden === true);
      ok("panel-closed-display-none", getComputedStyle(panel).display === "none");
      var centerEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      ok("closed-panel-not-blocking", centerEl !== panel && centerEl !== layer);

      // 清理
      dbg.dispose();
      ok("cleanup-layer", !document.getElementById("weread-moyu-layer"));
      ok("cleanup-style", !document.getElementById("weread-moyu-style"));
      ok("cleanup-dot", !document.getElementById("weread-moyu-dot"));
      ok("cleanup-panel", !document.getElementById("weread-moyu-panel"));
      ok("cleanup-peek-button", !document.getElementById("weread-moyu-peek"));
      ok("cleanup-peek-panel", !document.getElementById("weread-moyu-peek-panel"));
      ok("cleanup-dock", !document.getElementById("weread-moyu-dock"));
      ok("cleanup-cache-controls", !document.getElementById("wm-cache-text"));
      ok("cleanup-off-class", !document.documentElement.classList.contains("weread-moyu-off"));
      ok("cleanup-global", !window.__wereadMoyu);
      ok("cleanup-shell-opaque", alphaOf(getComputedStyle(frame).backgroundColor) === 1, getComputedStyle(frame).backgroundColor);
    }

    var failed = results.filter(function (r) {
      return !r.pass;
    });
    var payload = {
      pass: failed.length === 0,
      total: results.length,
      failed: failed.length,
      results: results,
      bootErrors: harness.errors,
      mockCalls: harness.mockCalls || 0,
      lastMockUrl: harness.lastMockUrl || null,
      lastMockPath: harness.lastMockPath || null,
      lastMockHref: harness.lastMockHref || null,
      fetchLog: harness.fetchLog || [],
      manualPing: harness.manualPing || null,
      stateAtReport: dbg ? dbg.getState() : null
    };
    var sink = document.getElementById("harness-assertions");
    if (sink) sink.textContent = JSON.stringify(payload);
    document.documentElement.setAttribute("data-harness", "done");
    document.title = payload.pass
      ? "HARNESS PASS " + payload.total + "/" + payload.total
      : "HARNESS FAIL " + failed.map(function (f) { return f.name; }).join(",");
  }

  /* ================================================================== *
   * 启动
   * ================================================================== */

  window.__harnessBoot = function () {
    try {
      if (params.get("theme") === "light") document.body.removeAttribute("data-ds-dark-theme");
      // 缓存状态预设（截图/手工验证）：?cache=running|done|cancelled&book=b4
      if (params.get("cache")) {
        applyCachePreset(params.get("cache"), params.get("book") || "b4");
      }
      if (harness.mock) {
        harness.fetchLog = [];
        var wrappedMockFetch = function (input, init) {
          var promise = mockFetch(input, init);
          promise.then(
            function (res) {
              harness.fetchLog.push("ok " + String(input) + " status=" + (res && res.status));
            },
            function (err) {
              harness.fetchLog.push("err " + String(input) + " " + String(err && err.message ? err.message : err));
            }
          );
          return promise;
        };
        window.fetch = wrappedMockFetch;
      }

      var system = window.__ModuleLoader__.create();
      var exported = null;
      try {
        exported = system.load("dsh-weread-moyu");
      } catch (err) {
        harness.errors.push("materialize: " + String(err && err.message ? err.message : err));
      }
      harness.exports = exported;

      var effects = [];
      var ctx = {
        effect: function (fn) {
          var dispose = fn();
          effects.push(dispose);
          return dispose;
        },
        on: function () {},
        slots: {},
        locale: {},
        theme: {}
      };
      harness.effects = effects;
      harness.ctx = ctx;

      if (exported && typeof exported.apply === "function") {
        try {
          exported.apply(ctx);
        } catch (err) {
          harness.errors.push("apply: " + String(err && err.message ? err.message : err));
        }
      } else {
        harness.errors.push("exports.apply is missing");
      }

      var speed = params.get("speed");
      if (speed !== null && window.__wereadMoyu) {
        window.__wereadMoyu.setConfig({ speed: parseInt(speed, 10) || 0 });
      }

      if (params.get("dispose") === "1") {
        setTimeout(function () {
          if (window.__wereadMoyu) window.__wereadMoyu.dispose();
        }, 200);
      }

      if (params.get("panel") === "1" || params.get("qr") === "1") {
        setTimeout(function () {
          if (window.__wereadMoyu) window.__wereadMoyu.openPanel();
        }, 400);
      }
      if (params.get("qr") === "1") {
        setTimeout(function () {
          var panel = document.getElementById("weread-moyu-panel");
          var btn = panel && panel.querySelector(".wm-btn[data-variant='primary']");
          if (btn) btn.click();
        }, 1100);
      }
      if (params.get("peek") === "1") {
        setTimeout(function () {
          if (window.__wereadMoyu) window.__wereadMoyu.openPeek();
        }, 1100);
      }
      var bookParam = params.get("book");
      if (bookParam) {
        setTimeout(function () {
          if (window.__wereadMoyu) window.__wereadMoyu.__testSelectBook(bookParam);
        }, 900);
      }
      var jumpParam = params.get("jump");
      if (jumpParam) {
        setTimeout(function () {
          var input = document.getElementById("wm-jump-input");
          var btn = document.getElementById("wm-jump-btn");
          if (input) {
            input.value = jumpParam;
            if (btn) btn.click();
          }
        }, 1800);
      }

      if (params.get("assert") === "1") {
        setTimeout(runAssertions, 1600);
      }

      document.documentElement.setAttribute("data-harness", "ready");
    } catch (err) {
      harness.errors.push("boot: " + String(err && err.message ? err.message : err));
      document.documentElement.setAttribute("data-harness", "error");
    }
  };
})();
