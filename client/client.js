/*!
 * dsh-weread-moyu — client bundle (hand-written DSH client plugin, no build step)
 *
 * 作用：在 DSH Web GUI 里把微信读书正文以低对比度文字层垫在整个界面背后，
 * 让 DSH 外壳半透明，看起来像一个“文档/代码工作区”；右下角一个极不显眼的
 * 14px 圆点打开控制面板（扫码/Cookie 登录、书籍/章节、透明度/字号/速度、开关）。
 *
 * 宿主 API 见 docs/spec.md：只用相对路径 /weread-moyu/api/*。
 * 宿主半未就绪时自动进入内置演示文本模式（demo），保证视觉效果可先行验收。
 *
 * 格式：DSH 客户端 bundle —— window.__ModuleLoader__.load({ id, factory })
 *   - factory 只在模块物化时执行；factory 内不 require 任何包（纯 DOM）。
 *   - 包名/模块 id 必须正好是 "dsh-weread-moyu"。
 */
(function () {
  "use strict";

  var BUNDLE_ID = "dsh-weread-moyu";

  if (
    typeof window === "undefined" ||
    !window.__ModuleLoader__ ||
    typeof window.__ModuleLoader__.load !== "function"
  ) {
    // 不是 DSH 客户端环境（例如被误当普通脚本加载）时安静退出。
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[weread-moyu] window.__ModuleLoader__.load 不存在，跳过注册");
    }
    return;
  }

  window.__ModuleLoader__.load({
    id: BUNDLE_ID,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      /* ================================================================== *
       * 常量与配置
       * ================================================================== */

      var VERSION = "0.1.0";
      var CLIENT_NAME = "weread-moyu";
      var API_BASE = "/weread-moyu/api";

      var CONFIG_KEY = "weread-moyu:config";
      var STYLE_ID = "weread-moyu-style";
      var LAYER_ID = "weread-moyu-layer";
      var PANEL_ID = "weread-moyu-panel";
      var DOT_ID = "weread-moyu-dot";
      var PEEK_ID = "weread-moyu-peek";
      var PEEK_PANEL_ID = "weread-moyu-peek-panel";
      var DOCK_ID = "weread-moyu-dock";
      var PEEK_HINT_DEFAULT = "滚动阅读 · 到底自动加载 · Esc 关闭";
      var OFF_CLASS = "weread-moyu-off"; // 挂在 <html> 上，关闭时撤掉所有外壳透明化
      var GLASS_ATTR = "data-wm-glass";

      // 速度档位：0=暂停，1=慢，2=正常，3=快（毫秒 / 1px，规范要求 30-60ms）
      var SPEED_MS = [0, 60, 42, 30];
      var SPEED_LABEL = ["暂停", "慢", "正常", "快"];

      // 微信读书 TOC 的非正文页（封面/版权/献词/目录/书名页/出版信息…）：
      // 标题命中前缀，或 wordCount 很小（实测常为 1-2），正文是 XML/版权页垃圾。
      var JUNK_CHAPTER_RE = /^\s*(封面|目录|版权|献词|书名|扉页|插页|出版|contents|cover)/i;
      var JUNK_CONTENT_RE = /^\s*<\?xml/i;
      var JUNK_CONTENT_MIN_CHARS = 40;

      // peek 按钮图标：内联小书 SVG（不用大字/emoji）
      var PEEK_ICON_SVG =
        '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 6.5C10.6 5.5 8.6 5 6.5 5H3v13h3.8c1.9 0 3.7.5 5.2 1.5"/>' +
        '<path d="M12 6.5C13.4 5.5 15.4 5 17.5 5H21v13h-3.8c-1.9 0-3.7.5-5.2 1.5"/>' +
        '<path d="M12 6.5V20"/></svg>';

      function isJunkChapter(chapter) {
        if (!chapter) return true;
        if (JUNK_CHAPTER_RE.test(String(chapter.title || ""))) return true;
        var wc = Number(chapter.wordCount);
        // 只有明确给出正数且很小才算非正文，避免缺字段时误杀整本书
        return isFinite(wc) && wc > 0 && wc < 200;
      }

      /** 自动起读章节：第一个「非垃圾且 wordCount >= 500」；没有就第一个非垃圾；再没有就 chapters[0]。 */
      function pickStartChapter(chapters) {
        if (!chapters || !chapters.length) return null;
        var readable = [];
        for (var i = 0; i < chapters.length; i++) {
          if (!isJunkChapter(chapters[i])) readable.push(chapters[i]);
        }
        for (var j = 0; j < readable.length; j++) {
          if (Number(readable[j].wordCount) >= 500) return readable[j];
        }
        if (readable.length) return readable[0];
        return chapters[0];
      }

      /**
       * 显示用章号：优先宿主返回的 chapterIdx（1-based，微信读书 TOC 原始序号），
       * 缺失时退回章节在列表中的顺序序号（1-based）。非正文页也保留其原始章号。
       */
      function chapterNoOf(chapter, index) {
        if (!chapter) return (Number(index) || 0) + 1;
        var no = Number(chapter.chapterIdx);
        if (isFinite(no) && no > 0) return Math.round(no);
        return (Number(index) || 0) + 1;
      }


      var DEFAULT_CONFIG = {
        enabled: true,
        opacity: 0.18, // 文字层整体不透明度（视觉验收 0.12-0.2）
        fontSize: 16, // 正文字号 px（背景层与 peek 共用）
        speed: 2, // 滚动速度档位
        clickThrough: true, // 规范要求默认穿透
        bookId: null,
        chapterUid: null,
        pos: 0,
        peekWidth: 560, // peek 浮层宽度（可拖拽缩放，持久化）
        peekHeight: 0 // peek 浮层高度；0 = 默认 64vh
      };

      var LIMIT = {
        opacity: [0.04, 0.35],
        fontSize: [12, 22],
        retryBaseMs: 3000,
        retryMaxMs: 60000,
        hostRetryBaseMs: 5000,
        hostRetryMaxMs: 60000,
        qrPollMs: 2000,
        qrLifeMs: 180000,
        saveDelay: 350,
        scanDelay: 900,
        maxChars: 1800,
        junkSkipMax: 3 // 连续垃圾正文最多自动跳 3 章，避免整本都是版权页时死循环
      };

      /* ================================================================== *
       * 内置演示文本（公版古文，宿主未就绪/未登录时垫底，保证背景不空）
       * ================================================================== */

      var DEMO = {
        bookTitle: "古文观止·选读",
        pages: [
          {
            title: "桃花源记",
            lines: [
              "晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。渔人甚异之，复前行，欲穷其林。",
              "林尽水源，便得一山，山有小口，仿佛若有光。便舍船，从口入。初极狭，才通人。复行数十步，豁然开朗。土地平旷，屋舍俨然，有良田美池桑竹之属。阡陌交通，鸡犬相闻。其中往来种作，男女衣着，悉如外人。黄发垂髫，并怡然自乐。",
              "见渔人，乃大惊，问所从来。具答之。便要还家，设酒杀鸡作食。村中闻有此人，咸来问讯。自云先世避秦时乱，率妻子邑人来此绝境，不复出焉，遂与外人间隔。问今是何世，乃不知有汉，无论魏晋。",
              "此人一一为具言所闻，皆叹惋。余人各复延至其家，皆出酒食。停数日，辞去。此中人语云：不足为外人道也。",
              "既出，得其船，便扶向路，处处志之。及郡下，诣太守，说如此。太守即遣人随其往，寻向所志，遂迷，不复得路。",
              "南阳刘子骥，高尚士也，闻之，欣然规往。未果，寻病终。后遂无问津者。"
            ]
          },
          {
            title: "兰亭集序",
            lines: [
              "永和九年，岁在癸丑，暮春之初，会于会稽山阴之兰亭，修禊事也。群贤毕至，少长咸集。此地有崇山峻岭，茂林修竹，又有清流激湍，映带左右，引以为流觞曲水，列坐其次。虽无丝竹管弦之盛，一觞一咏，亦足以畅叙幽情。",
              "是日也，天朗气清，惠风和畅。仰观宇宙之大，俯察品类之盛，所以游目骋怀，足以极视听之娱，信可乐也。",
              "夫人之相与，俯仰一世。或取诸怀抱，悟言一室之内；或因寄所托，放浪形骸之外。虽趣舍万殊，静躁不同，当其欣于所遇，暂得于己，快然自足，不知老之将至。"
            ]
          },
          {
            title: "岳阳楼记",
            lines: [
              "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴，乃重修岳阳楼，增其旧制，刻唐贤今人诗赋于其上，属予作文以记之。",
              "予观夫巴陵胜状，在洞庭一湖。衔远山，吞长江，浩浩汤汤，横无际涯，朝晖夕阴，气象万千，此则岳阳楼之大观也，前人之述备矣。然则北通巫峡，南极潇湘，迁客骚人，多会于此，览物之情，得无异乎？",
              "若夫淫雨霏霏，连月不开，阴风怒号，浊浪排空，日星隐曜，山岳潜形，商旅不行，樯倾楫摧，薄暮冥冥，虎啸猿啼。登斯楼也，则有去国怀乡，忧谗畏讥，满目萧然，感极而悲者矣。",
              "至若春和景明，波澜不惊，上下天光，一碧万顷，沙鸥翔集，锦鳞游泳，岸芷汀兰，郁郁青青。而或长烟一空，皓月千里，浮光跃金，静影沉璧，渔歌互答，此乐何极！登斯楼也，则有心旷神怡，宠辱偕忘，把酒临风，其喜洋洋者矣。",
              "嗟夫！予尝求古仁人之心，或异二者之为，何哉？不以物喜，不以己悲，居庙堂之高则忧其民，处江湖之远则忧其君。是进亦忧，退亦忧。然则何时而乐耶？其必曰：先天下之忧而忧，后天下之乐而乐乎！噫！微斯人，吾谁与归？"
            ]
          },
          {
            title: "前赤壁赋",
            lines: [
              "壬戌之秋，七月既望，苏子与客泛舟游于赤壁之下。清风徐来，水波不兴。举酒属客，诵明月之诗，歌窈窕之章。少焉，月出于东山之上，徘徊于斗牛之间。白露横江，水光接天。纵一苇之所如，凌万顷之茫然。",
              "浩浩乎如冯虚御风，而不知其所止；飘飘乎如遗世独立，羽化而登仙。于是饮酒乐甚，扣舷而歌之。歌曰：桂棹兮兰桨，击空明兮溯流光。渺渺兮予怀，望美人兮天一方。",
              "客有吹洞箫者，倚歌而和之。其声呜呜然，如怨如慕，如泣如诉，余音袅袅，不绝如缕。舞幽壑之潜蛟，泣孤舟之嫠妇。"
            ]
          }
        ]
      };

      /* ================================================================== *
       * 样式（注入 <head>，带前缀 wm-，避免与 DSH 冲突）
       * ================================================================== */

      var CSS = [
        /* ---------------- 背景阅读层 ---------------- */
        "#" + LAYER_ID + "{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--wm-paper,#111216);contain:layout paint style;}",
        "#" + LAYER_ID + " *{box-sizing:border-box;}",
        "body[data-ds-dark-theme] #" + LAYER_ID + "{" +
          "--wm-paper:radial-gradient(130% 90% at 50% 0%,#1c1d24 0%,#15161b 52%,#0e0f12 100%);" +
          "--wm-ink:#cfd3d6;--wm-meta:#848a94;--wm-divider:#6f7580;" +
          "--wm-font:\"Source Han Serif SC\",\"Noto Serif CJK SC\",\"Songti SC\",STSong,SimSun,serif;" +
          "}",
        "body:not([data-ds-dark-theme]) #" + LAYER_ID + "{" +
          "--wm-paper:radial-gradient(130% 90% at 50% 0%,#ffffff 0%,#f6f7f8 55%,#eceef1 100%);" +
          "--wm-ink:#4b5563;--wm-meta:#9aa1ab;--wm-divider:#8b929d;" +
          "--wm-font:\"Source Han Serif SC\",\"Noto Serif CJK SC\",\"Songti SC\",STSong,SimSun,serif;" +
          "}",
        "#" + LAYER_ID + " .wm-page{position:absolute;inset:0;display:flex;justify-content:center;" +
          "opacity:0.17;will-change:opacity;" +
          "-webkit-mask-image:linear-gradient(180deg,transparent 0%,#000 7%,#000 91%,transparent 100%);" +
          "mask-image:linear-gradient(180deg,transparent 0%,#000 7%,#000 91%,transparent 100%);}",
        "#" + LAYER_ID + " .wm-col{width:min(62ch,86vw);padding:max(6vh,44px) 0 0;position:relative;}",
        "#" + LAYER_ID + " .wm-scroll{transform:translate3d(0,0,0);will-change:transform;}",
        "#" + LAYER_ID + " .wm-meta{display:flex;align-items:baseline;gap:0.7em;margin:0 0 26px;" +
          "color:var(--wm-meta);font-size:12px;letter-spacing:0.08em;text-transform:none;opacity:0.62;}",
        "#" + LAYER_ID + " .wm-meta .wm-meta-book{font-weight:600;}",
        "#" + LAYER_ID + " .wm-meta .wm-meta-chap{font-weight:400;}",
        "#" + LAYER_ID + " .wm-body p{margin:0 0 0.85em;text-indent:2em;text-align:justify;text-justify:inter-ideograph;" +
          "color:var(--wm-ink);font-family:var(--wm-font);font-size:var(--wm-size,16px);line-height:1.9;" +
          "letter-spacing:0.02em;word-break:break-word;}",
        "#" + LAYER_ID + " .wm-body p.wm-blank{height:0.9em;margin:0;}",
        "#" + LAYER_ID + " .wm-divider{display:flex;align-items:center;gap:14px;margin:38px 0 26px;color:var(--wm-divider);" +
          "font-family:var(--wm-font);font-size:12px;letter-spacing:0.28em;opacity:0.8;}",
        "#" + LAYER_ID + " .wm-divider:before,#" + LAYER_ID + " .wm-divider:after{content:\"\";height:1px;flex:1;" +
          "background:currentColor;opacity:0.35;}",
        "#" + LAYER_ID + " .wm-status{position:absolute;left:18px;bottom:12px;" +
          "font-size:10px;letter-spacing:0.12em;color:var(--wm-meta);opacity:0.42;font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;}",
        "#" + LAYER_ID + " .wm-end{height:34vh;}",

        /* ---------------- 外壳透明化（只在启用时生效） ---------------- */
        "html:not(." + OFF_CLASS + ") body{background:transparent !important;}",
        "html:not(." + OFF_CLASS + ") #root{background:transparent !important;position:relative;z-index:1;}",
        "html:not(." + OFF_CLASS + ") body[data-ds-dark-theme]{" +
          "--dsw-alias-bg-base:rgba(21,22,26,0.58) !important;" +
          "--dsw-alias-bg-layer-1:rgba(30,31,36,0.72) !important;" +
          "--dsw-alias-bg-layer-2:rgba(38,39,45,0.78) !important;" +
          "--dsw-alias-bg-layer-3:rgba(46,47,54,0.82) !important;" +
          "--dsw-alias-bg-overlay:rgba(40,41,47,0.72) !important;" +
          "--dsw-alias-bg-module-platform:rgba(44,45,52,0.7) !important;" +
          "--dsw-alias-bg-document-preview:rgba(26,27,32,0.6) !important;" +
          "--dsw-alias-bg-multi-select:rgba(38,39,45,0.7) !important;" +
          "--dsw-specific-sidebar-fill:rgba(20,21,25,0.52) !important;" +
          "--dsw-specific-input-major:rgba(34,35,41,0.78) !important;" +
          "}",
        "html:not(." + OFF_CLASS + ") body:not([data-ds-dark-theme]){" +
          "--dsw-alias-bg-base:rgba(255,255,255,0.6) !important;" +
          "--dsw-alias-bg-layer-1:rgba(255,255,255,0.74) !important;" +
          "--dsw-alias-bg-layer-2:rgba(255,255,255,0.8) !important;" +
          "--dsw-alias-bg-layer-3:rgba(255,255,255,0.84) !important;" +
          "--dsw-alias-bg-overlay:rgba(245,246,248,0.74) !important;" +
          "--dsw-alias-bg-module-platform:rgba(248,249,251,0.72) !important;" +
          "--dsw-alias-bg-document-preview:rgba(255,255,255,0.62) !important;" +
          "--dsw-alias-bg-multi-select:rgba(245,246,248,0.72) !important;" +
          "--dsw-specific-sidebar-fill:rgba(250,251,252,0.54) !important;" +
          "--dsw-specific-input-major:rgba(255,255,255,0.8) !important;" +
          "}",

        /* ---------------- 右下角隐蔽入口：peek 按钮 + 圆点（同一个 dock，不新增工具栏） ---------------- */
        "#" + DOCK_ID + "{" +
          "position:fixed;right:14px;bottom:14px;z-index:2147482600;" +
          "display:flex;align-items:center;gap:10px;pointer-events:none;" +
          "}",
        "#" + DOCK_ID + ">*{pointer-events:auto;}",
        "#" + DOT_ID + "{" +
          "width:14px;height:14px;padding:0;margin:0;border:0;flex:0 0 auto;" +
          "border-radius:50%;cursor:pointer;" +
          "background:var(--dsw-alias-label-secondary,#8a8f98);" +
          "box-shadow:0 0 0 1px rgba(255,255,255,0.10),0 0 8px rgba(0,0,0,0.25);" +
          "opacity:0.25;transition:opacity .18s ease,transform .18s ease;" +
          "-webkit-app-region:no-drag;" +
          "}",
        "#" + DOT_ID + ":hover,#" + DOT_ID + ":focus-visible{opacity:0.9;transform:scale(1.18);outline:none;}",
        "body:not([data-ds-dark-theme]) #" + DOT_ID + "{background:#5b6470;}",

        /* ---------------- peek：看清当前这一页（一个小按钮 + 浮层） ---------------- */
        "#" + PEEK_ID + "{" +
          "display:flex;align-items:center;justify-content:center;flex:0 0 auto;" +
          "width:18px;height:18px;padding:0;margin:0;border-radius:50%;cursor:pointer;" +
          "background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);" +
          "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12));" +
          "opacity:0.22;transition:opacity .18s ease,background .18s ease,transform .18s ease;" +
          "-webkit-app-region:no-drag;" +
          "}",
        "#" + PEEK_ID + ":hover,#" + PEEK_ID + ":focus-visible{opacity:0.92;background:rgba(128,140,160,0.16);" +
          "transform:scale(1.06);outline:none;}",
        "#" + PEEK_ID + " svg{width:11px;height:11px;display:block;pointer-events:none;}",
        "body:not([data-ds-dark-theme]) #" + PEEK_ID + "{color:#5b6470;}",
        "#" + PEEK_PANEL_ID + "{" +
          "position:fixed;right:20px;bottom:56px;width:min(560px,92vw);max-height:64vh;box-sizing:border-box;" +
          "z-index:2147482500;display:flex;flex-direction:column;overflow:hidden;" +
          "background:rgba(20,22,26,0.97);" +
          "-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);" +
          "border:1px solid rgba(255,255,255,0.12);border-radius:12px;" +
          "box-shadow:0 24px 64px -18px rgba(0,0,0,0.66),0 0 0 0.5px rgba(255,255,255,0.04) inset;" +
          "font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;color:#e6e9ee;" +
          "}",
        "#" + PEEK_PANEL_ID + "[hidden]{display:none !important;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-head{display:flex;align-items:flex-start;gap:12px;" +
          "padding:12px 14px 10px 20px;border-bottom:1px solid rgba(255,255,255,0.08);flex:0 0 auto;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-head-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-eyebrow{font-size:10px;letter-spacing:0.16em;color:#8b929d;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-title{display:flex;align-items:baseline;gap:8px;min-width:0;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-book{font-size:13.5px;font-weight:600;color:#f2f4f7;" +
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-chap{font-size:11.5px;color:#aeb4bf;" +
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-progress{font-size:10.5px;color:#8b929d;letter-spacing:0.02em;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-head-tools{display:flex;align-items:center;gap:4px;flex:0 0 auto;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-tool{appearance:none;cursor:pointer;border-radius:6px;padding:1px 5px;" +
          "font-family:inherit;font-size:10.5px;line-height:1.5;color:#aeb4bf;background:transparent;border:1px solid rgba(255,255,255,0.12);}",
        "#" + PEEK_PANEL_ID + " .wm-peek-tool:hover{background:rgba(255,255,255,0.12);color:#f2f4f7;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-close{appearance:none;background:transparent;border:0;color:#aeb4bf;" +
          "font-size:17px;line-height:1;cursor:pointer;padding:2px 5px;border-radius:6px;flex:0 0 auto;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-close:hover{background:rgba(255,255,255,0.12);color:#f2f4f7;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-body{overflow:auto;padding:14px 22px 16px;flex:1 1 auto;scrollbar-width:thin;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-body p{margin:0 0 0.8em;text-indent:2em;text-align:justify;" +
          "font-family:\"Source Han Serif SC\",\"Noto Serif CJK SC\",\"Songti SC\",STSong,SimSun,serif;" +
          "font-size:var(--wm-size,17px);line-height:1.9;color:#e6e9ee;letter-spacing:0.02em;word-break:break-word;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-empty{padding:14px 0;font-size:13px;line-height:1.8;color:#8b929d;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-divider{display:flex;align-items:center;gap:12px;margin:26px 0 18px;" +
          "color:#8b929d;font-size:12px;letter-spacing:0.06em;white-space:nowrap;overflow:hidden;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-divider:before,#" + PEEK_PANEL_ID + " .wm-peek-divider:after" +
          "{content:\"\";height:1px;flex:1;background:rgba(255,255,255,0.12);}",
        "#" + PEEK_PANEL_ID + " .wm-peek-foot{display:flex;align-items:center;gap:8px;" +
          "padding:9px 16px 10px 20px;border-top:1px solid rgba(255,255,255,0.08);flex:0 0 auto;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-btn{appearance:none;cursor:pointer;border-radius:8px;padding:5px 12px;" +
          "font-family:inherit;font-size:11.5px;color:#e6e9ee;background:rgba(128,140,160,0.16);" +
          "border:1px solid rgba(255,255,255,0.14);transition:background .15s;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-btn:hover{background:rgba(128,140,160,0.30);}",
        "#" + PEEK_PANEL_ID + " .wm-peek-btn:disabled{opacity:0.4;cursor:default;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-hint{flex:1 1 auto;text-align:center;font-size:10.5px;color:#8b929d;" +
          "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
        // 左下角缩放手柄：低对比斜纹，hover 才明显
        "#" + PEEK_PANEL_ID + " .wm-peek-resize{position:absolute;left:0;bottom:0;width:16px;height:16px;" +
          "cursor:nwse-resize;border-bottom-left-radius:12px;opacity:0.22;transition:opacity .15s;" +
          "background:repeating-linear-gradient(135deg,rgba(255,255,255,0.45) 0 1px,transparent 1px 3px);" +
          "background-size:11px 11px;background-position:left bottom;background-repeat:no-repeat;" +
          "touch-action:none;-webkit-app-region:no-drag;}",
        "#" + PEEK_PANEL_ID + " .wm-peek-resize:hover{opacity:0.75;}",

        /* ---------------- 控制面板 ---------------- */
        "#" + PANEL_ID + "{" +
          "position:fixed;right:14px;bottom:38px;width:360px;max-width:calc(100vw - 28px);box-sizing:border-box;" +
          "max-height:min(76vh,660px);z-index:2147482601;display:flex;flex-direction:column;" +
          "background:rgba(27,28,33,0.96);" +
          "-webkit-backdrop-filter:blur(22px) saturate(1.25);backdrop-filter:blur(22px) saturate(1.25);" +
          "border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:14px;" +
          "box-shadow:0 24px 64px -16px rgba(0,0,0,0.6),0 0 0 0.5px rgba(255,255,255,0.04) inset;" +
          "overflow:hidden;font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;" +
          "font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#f2f3f5);" +
          "}",
        "body:not([data-ds-dark-theme]) #" + PANEL_ID + "{background:rgba(252,252,253,0.97);}",
        "#" + PANEL_ID + "[hidden]{display:none !important;}",
        "#" + PANEL_ID + " .wm-p-head{display:flex;align-items:center;justify-content:space-between;gap:10px;" +
          "padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff0f);flex:0 0 auto;}",
        "#" + PANEL_ID + " .wm-p-title{font-size:13px;font-weight:600;letter-spacing:0.02em;display:flex;align-items:center;gap:8px;}",
        "#" + PANEL_ID + " .wm-p-title .wm-p-badge{font-size:9px;font-weight:500;letter-spacing:0.08em;padding:1px 5px;border-radius:5px;" +
          "color:var(--dsw-alias-label-tertiary,#adb2b8);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);}",
        "#" + PANEL_ID + " .wm-p-close{appearance:none;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,#adb2b8);" +
          "font-size:17px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;}",
        "#" + PANEL_ID + " .wm-p-close:hover{background:rgba(128,128,128,0.18);color:var(--dsw-alias-label-primary,#f2f3f5);}",
        "#" + PANEL_ID + " .wm-p-body{overflow:auto;padding:11px 14px 14px;display:flex;flex-direction:column;gap:11px;flex:1 1 auto;" +
          "scrollbar-width:thin;}",
        "#" + PANEL_ID + " .wm-status{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;border-radius:8px;" +
          "background:rgba(128,140,160,0.10);color:var(--dsw-alias-label-secondary,#cfd3d6);font-size:11.5px;}",
        "#" + PANEL_ID + " .wm-status .wm-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;margin-top:5px;background:#8a8f98;}",
        "#" + PANEL_ID + " .wm-status[data-kind=\"ok\"] .wm-dot{background:#3fbf7f;}",
        "#" + PANEL_ID + " .wm-status[data-kind=\"warn\"] .wm-dot{background:#e0b45c;}",
        "#" + PANEL_ID + " .wm-status[data-kind=\"error\"] .wm-dot{background:#ec6a6a;}",
        "#" + PANEL_ID + " .wm-sec{display:flex;flex-direction:column;gap:6px;}",
        "#" + PANEL_ID + " .wm-label{font-size:10.5px;letter-spacing:0.08em;color:var(--dsw-alias-label-tertiary,#adb2b8);" +
          "display:flex;justify-content:space-between;align-items:center;gap:8px;}",
        "#" + PANEL_ID + " .wm-btn{appearance:none;cursor:pointer;border-radius:8px;padding:5px 10px;font-size:11.5px;" +
          "color:var(--dsw-alias-label-primary,#f2f3f5);background:rgba(128,140,160,0.14);" +
          "border:1px solid var(--dsw-alias-border-l2,#ffffff1f);font-family:inherit;transition:background .15s;}",
        "#" + PANEL_ID + " .wm-btn:hover{background:rgba(128,140,160,0.24);}",
        "#" + PANEL_ID + " .wm-btn[data-variant=\"primary\"]{background:rgba(108,150,255,0.18);border-color:rgba(108,150,255,0.42);" +
          "color:#c3d3ff;}",
        "body:not([data-ds-dark-theme]) #" + PANEL_ID + " .wm-btn[data-variant=\"primary\"]{color:#2f59c8;}",
        "#" + PANEL_ID + " .wm-btn:disabled{opacity:0.45;cursor:default;}",
        "#" + PANEL_ID + " .wm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        "#" + PANEL_ID + " .wm-list{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;padding:4px;" +
          "border:1px solid var(--dsw-alias-border-l1,#ffffff0f);border-radius:10px;background:rgba(0,0,0,0.10);" +
          "scrollbar-width:thin;}",
        "#" + PANEL_ID + " .wm-item{appearance:none;cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);" +
          "text-align:left;padding:5px 8px;border-radius:7px;font-family:inherit;font-size:11.5px;display:flex;gap:8px;" +
          "align-items:baseline;justify-content:space-between;width:100%;}",
        "#" + PANEL_ID + " .wm-item:hover{background:rgba(128,140,160,0.14);}",
        "#" + PANEL_ID + " .wm-item[data-active=\"1\"]{background:rgba(108,150,255,0.16);color:var(--dsw-alias-label-primary,#f2f3f5);}",
        "#" + PANEL_ID + " .wm-item[data-current=\"1\"]{background:rgba(108,150,255,0.10);" +
          "box-shadow:inset 2px 0 0 rgba(108,150,255,0.75);}",
        "#" + PANEL_ID + " .wm-item .wm-item-sub{font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);flex:0 0 auto;}",
        "#" + PANEL_ID + " .wm-item-main{display:flex;align-items:baseline;gap:7px;min-width:0;flex:1 1 auto;}",
        "#" + PANEL_ID + " .wm-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
        "#" + PANEL_ID + " .wm-ch-no{flex:0 0 auto;min-width:58px;font-size:10px;letter-spacing:0.02em;" +
          "color:var(--dsw-alias-label-tertiary,#adb2b8);font-variant-numeric:tabular-nums;}",
        "#" + PANEL_ID + " .wm-item-junk{opacity:0.42;}",
        "#" + PANEL_ID + " .wm-item-junk:hover{opacity:0.78;}",
        "#" + PANEL_ID + " .wm-chapters-meta{display:flex;align-items:center;gap:8px;}",
        "#" + PANEL_ID + " .wm-chapters-words{font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);}",
        "#" + PANEL_ID + " .wm-chapters-count{font-size:10px;color:var(--dsw-alias-label-tertiary,#adb2b8);}",
        "#" + PANEL_ID + " .wm-jump-row{display:flex;align-items:center;gap:6px;font-size:10.5px;" +
          "color:var(--dsw-alias-label-tertiary,#adb2b8);}",
        "#" + PANEL_ID + " .wm-jump-input{width:64px;box-sizing:border-box;border-radius:6px;padding:3px 6px;" +
          "font-family:inherit;font-size:10.5px;color:var(--dsw-alias-label-primary,#f2f3f5);" +
          "background:rgba(0,0,0,0.18);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);outline:none;" +
          "font-variant-numeric:tabular-nums;}",
        "body:not([data-ds-dark-theme]) #" + PANEL_ID + " .wm-jump-input{background:rgba(0,0,0,0.05);}",
        "#" + PANEL_ID + " .wm-jump-input:focus{border-color:rgba(108,150,255,0.55);}",
        "#" + PANEL_ID + " .wm-jump-btn{padding:3px 10px;font-size:10.5px;flex:0 0 auto;}",
        "#" + PANEL_ID + " .wm-cache-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        "#" + PANEL_ID + " .wm-cache-text{flex:1 1 auto;min-width:0;font-size:10.5px;line-height:1.5;" +
          "color:var(--dsw-alias-label-tertiary,#adb2b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        "#" + PANEL_ID + " .wm-cache-btn{padding:3px 9px;font-size:10.5px;flex:0 0 auto;}",
        "#" + PANEL_ID + " .wm-junk-toggle{appearance:none;background:transparent;border:0;padding:0 2px;cursor:pointer;" +
          "font-family:inherit;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#adb2b8);text-align:left;" +
          "text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(128,140,160,0.4);}",
        "#" + PANEL_ID + " .wm-junk-toggle:hover{color:var(--dsw-alias-label-secondary,#cfd3d6);}",
        "#" + PANEL_ID + " .wm-empty{padding:8px;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8);text-align:center;}",
        "#" + PANEL_ID + " .wm-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 0;" +
          "font-size:12px;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer;}",
        "#" + PANEL_ID + " .wm-toggle input,#" + PANEL_ID + " .wm-slide input{accent-color:#6c96ff;}",
        "#" + PANEL_ID + " .wm-slide{display:grid;grid-template-columns:44px 1fr 38px;align-items:center;gap:9px;" +
          "font-size:11.5px;color:var(--dsw-alias-label-secondary,#cfd3d6);}",
        "#" + PANEL_ID + " .wm-slide input{width:100%;}",
        "#" + PANEL_ID + " .wm-slide .wm-val{text-align:right;color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:10.5px;" +
          "font-variant-numeric:tabular-nums;}",
        "#" + PANEL_ID + " .wm-qr-wrap{display:flex;flex-direction:column;align-items:center;gap:7px;padding:8px 0 2px;}",
        "#" + PANEL_ID + " .wm-qr{width:164px;height:164px;border-radius:9px;background:#fff;padding:5px;display:block;object-fit:contain;}",
        "#" + PANEL_ID + " .wm-qr-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#adb2b8);text-align:center;min-height:15px;}",
        "#" + PANEL_ID + " .wm-cookie{display:flex;flex-direction:column;gap:6px;}",
        "#" + PANEL_ID + " .wm-cookie textarea{width:100%;min-height:56px;resize:vertical;box-sizing:border-box;border-radius:8px;" +
          "padding:6px 8px;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;" +
          "color:var(--dsw-alias-label-primary,#f2f3f5);background:rgba(0,0,0,0.22);" +
          "border:1px solid var(--dsw-alias-border-l2,#ffffff1f);outline:none;}",
        "body:not([data-ds-dark-theme]) #" + PANEL_ID + " .wm-cookie textarea{background:rgba(0,0,0,0.04);}",
        "#" + PANEL_ID + " .wm-cookie textarea:focus{border-color:rgba(108,150,255,0.5);}",
        "#" + PANEL_ID + " .wm-user{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;" +
          "color:var(--dsw-alias-label-secondary,#cfd3d6);}",
        "#" + PANEL_ID + " .wm-user .wm-name{color:var(--dsw-alias-label-primary,#f2f3f5);font-weight:600;}",
        "#" + PANEL_ID + " .wm-p-foot{flex:0 0 auto;padding:7px 14px 8px;border-top:1px solid var(--dsw-alias-border-l1,#ffffff0f);" +
          "font-size:10px;letter-spacing:0.03em;color:var(--dsw-alias-label-tertiary,#adb2b8);opacity:0.75;" +
          "display:flex;justify-content:space-between;gap:8px;}",
        "#" + PANEL_ID + " .wm-toast{position:absolute;left:50%;bottom:46px;transform:translateX(-50%) translateY(6px);" +
          "padding:5px 11px;border-radius:8px;font-size:11px;background:rgba(20,21,25,0.94);color:#f2f3f5;" +
          "border:1px solid rgba(255,255,255,0.12);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;" +
          "white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis;}",
        "#" + PANEL_ID + " .wm-toast[data-show=\"1\"]{opacity:1;transform:translateX(-50%) translateY(0);}",
        "#" + PANEL_ID + " [hidden]{display:none !important;}"
      ].join("\n");

      /* ================================================================== *
       * 小工具
       * ================================================================== */

      function clamp(value, min, max) {
        value = Number(value);
        if (!isFinite(value)) return min;
        return Math.min(max, Math.max(min, value));
      }

      function num(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
      }

      function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) {
          for (var key in attrs) {
            if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
            var value = attrs[key];
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "style") node.setAttribute("style", value);
            else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value === true) node.setAttribute(key, "");
            else node.setAttribute(key, value);
          }
        }
        if (children) {
          for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (child === null || child === undefined) continue;
            node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
          }
        }
        return node;
      }

      /* ================================================================== *
       * 单个实例（apply 时创建，返回 dispose）
       * ================================================================== */

      function createInstance(ctx) {
        var cfg = loadConfig();
        var state = {
          hostReady: null, // null=探测中 true/false
          hostVersion: null,
          hostError: null, // 宿主返回的 hostError 文案
          wereadReady: null, // 宿主侧微信读书接口是否可用
          shelfError: null,
          loggedIn: false,
          user: null,
          books: [],
          chapters: [],
          sessionExpired: false,
          demo: true,
          demoPage: 0,
          bookId: cfg.bookId || null,
          chapterUid: cfg.chapterUid || null,
          title: "",
          chapterTitle: "",
          chapterIndex: null, // 宿主 /content 的 chapterIndex（0-based）
          chapterCount: null, // 宿主 /content 的 chapterCount
          sections: [], // [{title,start}] 已加载的章节在滚动内容里的起始位置
          currentSectionIndex: -1,
          junkSkipCount: 0, // 连续跳过非正文页的计数（成功加载正文后清零）
          pendingChapterStart: false, // 跳过垃圾页后，下一次成功加载要当作“新章节”处理
          showJunkChapters: false, // 章节列表里是否展示封面/版权等非正文页
          lastChapterUidRendered: "", // 章节列表上次渲染时的当前章，避免每次续页都重建 DOM
          chapterTotalWords: 0, // 正文页 wordCount 汇总，用于「缓存整本（约 X 字）」
          source: null, // /content 返回的来源：cache / online
          cacheStatus: null, // 当前书的缓存状态（宿主 /cache/status）
          cacheBookId: null, // cacheStatus 对应的 bookId，防止切书后旧响应覆盖
          cachePollTimer: null, // 缓存进行中的 1.5s 轮询
          cacheBusy: false, // 缓存操作请求进行中，避免重复点击
          cacheLoaded: false, // 是否已从宿主拿到当前书的缓存状态
          offlineBooks: [], // 已缓存整本的书籍（免登录可读）
          offlineMode: false, // 未登录但正在阅读离线缓存书籍
          pos: cfg.pos || 0,
          hasMore: false,
          nextChapterUid: null,
          loadedOnce: false,
          atEnd: false,
          loading: false,
          offset: 0,
          contentHeight: 0,
          viewportHeight: 0,
          error: null,
          qrUid: null,
          qrTimer: null,
          retryTimer: null,
          retryDelay: LIMIT.retryBaseMs,
          hostRetryTimer: null,
          hostRetryDelay: LIMIT.hostRetryBaseMs,
          saveTimer: null,
          scanTimer: null,
          rafId: null,
          watchdogTimer: null,
          running: false,
          lastTs: 0,
          lastRequestTs: 0,
          panelOpen: false,
          peekOpen: false, // “看清当前页”浮层是否打开（打开时冻结背景自动滚动）
          peekHintTimer: null,
          peekLastUserScrollTs: 0, // 最近一次用户滚动/滚轮时间；自动补载只在活跃期进行
          progress: null, // 宿主 /content 返回的阅读进度（0-100），没有就不显示
          toastTimer: null
        };

        var dom = {};
        var glassed = [];
        var observers = [];
        var listeners = [];
        var disposed = false;
        var instanceId = Math.random().toString(36).slice(2);

        /* ---------------- 配置持久化 ---------------- */

        function loadConfig() {
          var out = {};
          var k;
          for (k in DEFAULT_CONFIG) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, k)) out[k] = DEFAULT_CONFIG[k];
          }
          try {
            var raw = window.localStorage.getItem(CONFIG_KEY);
            if (raw) {
              var parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                for (k in out) {
                  if (Object.prototype.hasOwnProperty.call(parsed, k) && parsed[k] !== null && parsed[k] !== undefined) {
                    out[k] = parsed[k];
                  }
                }
              }
            }
          } catch (err) {
            /* localStorage 不可用时静默降级 */
          }
          out.enabled = out.enabled !== false;
          out.clickThrough = out.clickThrough !== false;
          out.opacity = clamp(out.opacity, LIMIT.opacity[0], LIMIT.opacity[1]);
          out.fontSize = Math.round(clamp(out.fontSize, LIMIT.fontSize[0], LIMIT.fontSize[1]));
          out.speed = Math.round(clamp(out.speed, 0, 3));
          out.pos = Math.max(0, num(out.pos, 0));
          out.peekWidth = Math.round(clamp(num(out.peekWidth, 560), 300, 920));
          out.peekHeight = Math.round(clamp(num(out.peekHeight, 0), 0, 2000));
          if (typeof out.bookId !== "string") out.bookId = null;
          if (typeof out.chapterUid !== "string" && typeof out.chapterUid !== "number") out.chapterUid = null;
          return out;
        }

        function saveConfig() {
          if (state.saveTimer) return;
          state.saveTimer = setTimeout(function () {
            state.saveTimer = null;
            try {
              window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
            } catch (err) {
              /* ignore */
            }
          }, LIMIT.saveDelay);
        }

        function saveConfigNow() {
          if (state.saveTimer) {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
          }
          try {
            window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
          } catch (err) {
            /* ignore */
          }
        }

        /* ---------------- API ---------------- */

        function api(path, options) {
          var opts = {};
          if (options) for (var k in options) opts[k] = options[k];
          opts.headers = opts.headers || {};
          opts.headers.accept = "application/json";
          if (opts.body && typeof opts.body !== "string") {
            opts.body = JSON.stringify(opts.body);
            opts.headers["content-type"] = "application/json";
          }
          opts.cache = "no-store";
          var controller = typeof AbortController === "function" ? new AbortController() : null;
          var timer = null;
          if (controller) {
            timer = setTimeout(function () {
              try {
                controller.abort();
              } catch (e) {}
            }, 12000);
            opts.signal = controller.signal;
          }
          return fetch(API_BASE + path, opts).then(
            function (res) {
              if (timer) clearTimeout(timer);
              return res.text().then(function (text) {
                var data = null;
                try {
                  data = text ? JSON.parse(text) : null;
                } catch (e) {
                  throw new Error(res.status === 404 ? "宿主未就绪" : "响应不是 JSON");
                }
                if (!res.ok && !(data && data.ok === false)) {
                  throw new Error((data && (data.error || data.code)) || "HTTP " + res.status);
                }
                return data;
              });
            },
            function (err) {
              if (timer) clearTimeout(timer);
              throw err;
            }
          );
        }

        function enc(value) {
          return encodeURIComponent(String(value === null || value === undefined ? "" : value));
        }

        /* ---------------- 主题 ---------------- */

        function isDark() {
          return !!(document.body && document.body.hasAttribute("data-ds-dark-theme"));
        }

        /* ---------------- 外壳透明化兜底扫描 ---------------- */

        function scanShellPlanes() {
          if (!cfg.enabled || disposed) return;
          var root = document.getElementById("root");
          if (!root) return;
          var vw = window.innerWidth || 1440;
          var vh = window.innerHeight || 900;
          var minArea = vw * vh * 0.3;
          var bandMinWidth = vw * 0.55;
          var bandMinHeight = Math.max(80, vh * 0.1);
          var glass = isDark() ? "rgba(21,22,26,0.58)" : "rgba(255,255,255,0.6)";
          var nodes;
          try {
            nodes = root.querySelectorAll("div,main,section,aside,header,footer");
          } catch (e) {
            return;
          }
          var budget = 4000;
          for (var i = 0; i < nodes.length && i < budget; i++) {
            var node = nodes[i];
            if (node.hasAttribute(GLASS_ATTR)) continue;
            var rect = node.getBoundingClientRect();
            var area = rect.width * rect.height;
            var isBigPlane = area >= minArea;
            // 真实 DSH 首页有横贯整行的不透明大色块（hero/工具条），面积不到 30% 也要处理
            var isBand = rect.width >= bandMinWidth && rect.height >= bandMinHeight && area >= vw * vh * 0.08;
            if (!isBigPlane && !isBand) continue;
            var cs = window.getComputedStyle(node);
            if (cs.backgroundImage && cs.backgroundImage !== "none") continue;
            var match = /^rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
            if (!match) continue;
            var parts = match[1].split(",").map(function (v) {
              return parseFloat(v);
            });
            var alpha = parts.length > 3 ? parts[3] : 1;
            if (!(alpha >= 0.85)) continue;
            node.setAttribute(GLASS_ATTR, "");
            node.style.setProperty("background-color", glass, "important");
            glassed.push(node);
          }
        }

        function restoreGlassed() {
          for (var i = 0; i < glassed.length; i++) {
            var node = glassed[i];
            if (!node) continue;
            try {
              node.style.removeProperty("background-color");
              node.removeAttribute(GLASS_ATTR);
            } catch (e) {}
          }
          glassed = [];
        }

        function scheduleScan(force) {
          if (state.scanTimer) return;
          state.scanTimer = setTimeout(function () {
            state.scanTimer = null;
            if (force) restoreGlassed();
            scanShellPlanes();
          }, LIMIT.scanDelay);
        }

        /* ---------------- 当前状态文案 ---------------- */

        function errText(res, fallback) {
          if (!res) return fallback || "网络错误";
          var text = res.error || res.code || fallback || "请求失败";
          return String(text).length > 80 ? String(text).slice(0, 80) + "…" : String(text);
        }

        function statusInfo() {
          if (state.hostReady === null) {
            return { kind: "info", text: "正在检测宿主 API…" };
          }
          if (!state.hostReady) {
            return { kind: "warn", text: "宿主未就绪 · 使用内置演示文本" };
          }
          if (state.wereadReady === false) {
            return {
              kind: "error",
              text: "微信读书接口未就绪" + (state.hostError ? "：" + errText({ error: state.hostError }) : "")
            };
          }
          if (!state.loggedIn) {
            return {
              kind: "warn",
              text: state.sessionExpired ? "登录已过期 · 请重新扫码或粘贴 Cookie" : "未登录 · 扫码或粘贴 Cookie 登录"
            };
          }
          if (state.shelfError) {
            return { kind: "warn", text: "已登录，但书架加载失败：" + errText({ error: state.shelfError }) };
          }
          var nickname = state.user && state.user.nickname ? state.user.nickname : "微信读书用户";
          return { kind: "ok", text: "已登录 · " + nickname };
        }

        function readingInfo() {
          if (state.demo) {
            return (
              "内容来源：演示文本（内置） · 《" +
              DEMO.bookTitle +
              "》 · " +
              (state.chapterTitle || DEMO.pages[0].title)
            );
          }
          if (state.title || state.chapterTitle) {
            var noLabel = currentChapterLabel();
            var sourceLabel = cacheSourceLabel();
            return (
              "内容来源：真实书页 · 《" +
              (state.title || "微信读书") +
              "》 · " +
              (noLabel ? noLabel + " · " : "") +
              (state.chapterTitle || "未选择章节") +
              (sourceLabel ? " · " + sourceLabel : "")
            );
          }
          return "内容来源：真实书页 · 尚未加载正文";
        }

        function setStatus(kind, text) {
          if (!dom.statusBox) return;
          dom.statusBox.setAttribute("data-kind", kind || "info");
          if (dom.statusText) dom.statusText.textContent = text || "";
        }

        function refreshStatusLine() {
          var info = statusInfo();
          setStatus(info.kind, info.text);
          if (dom.readingText) dom.readingText.textContent = readingInfo();
          if (dom.footHost) {
            dom.footHost.textContent =
              state.hostReady === null ? "检测宿主…" : state.hostReady ? "宿主 v" + (state.hostVersion || "?") : "宿主未就绪";
          }
        }

        function toast(message) {
          if (!dom.toast) return;
          dom.toast.textContent = message;
          dom.toast.setAttribute("data-show", "1");
          if (state.toastTimer) clearTimeout(state.toastTimer);
          state.toastTimer = setTimeout(function () {
            state.toastTimer = null;
            if (dom.toast) dom.toast.removeAttribute("data-show");
          }, 2400);
        }

        /* ---------------- 背景层 DOM ---------------- */

        function buildLayer() {
          dom.layer = el("div", { id: LAYER_ID, "aria-hidden": "true" });
          dom.page = el("div", { class: "wm-page" });
          dom.col = el("div", { class: "wm-col" });
          dom.scroll = el("div", { class: "wm-scroll" });
          dom.meta = el("div", { class: "wm-meta" }, [
            el("span", { class: "wm-meta-book", text: "" }),
            el("span", { class: "wm-meta-chap", text: "" })
          ]);
          dom.body = el("div", { class: "wm-body" });
          dom.endMark = el("div", { class: "wm-end" });
          dom.layerStatus = el("div", { class: "wm-status", text: "" });
          dom.scroll.appendChild(dom.meta);
          dom.scroll.appendChild(dom.body);
          dom.scroll.appendChild(dom.endMark);
          dom.col.appendChild(dom.scroll);
          dom.page.appendChild(dom.col);
          dom.layer.appendChild(dom.page);
          dom.layer.appendChild(dom.layerStatus);
          document.body.insertBefore(dom.layer, document.body.firstChild);
        }

        function updateMeta(bookTitle, chapterTitle) {
          var bookSpan = dom.meta.querySelector(".wm-meta-book");
          var chapSpan = dom.meta.querySelector(".wm-meta-chap");
          if (bookSpan) bookSpan.textContent = bookTitle ? "《" + bookTitle + "》" : "";
          if (chapSpan) chapSpan.textContent = chapterTitle || "";
        }

        /**
         * 记录一个章节在滚动内容中的起点（预加载下一章后，标题/状态仍显示
         * 当前正在看的章节，而不是最后追加的那一章）。chapterUid/chapterNo 用于
         * 在状态行、peek 浮层里显示「第 N 章」。
         */
        function beginSection(title, startOffset, chapterUid, chapterNo) {
          var name = title || state.title || "未命名章节";
          state.sections.push({
            title: name,
            start: Math.max(0, Number(startOffset) || 0),
            chapterUid: chapterUid === undefined ? state.chapterUid : chapterUid,
            chapterNo: Number(chapterNo) > 0 ? Number(chapterNo) : 0
          });
          if (state.currentSectionIndex < 0) {
            state.currentSectionIndex = 0;
            state.chapterTitle = name;
            updateMeta(state.title, name);
          }
          refreshStatusLine();
        }

        function updateCurrentSection() {
          if (!state.sections.length) return;
          var probe = state.offset + 48;
          var index = 0;
          for (var i = 0; i < state.sections.length; i++) {
            if (state.sections[i].start <= probe) index = i;
            else break;
          }
          if (index === state.currentSectionIndex) return;
          state.currentSectionIndex = index;
          state.chapterTitle = state.sections[index].title;
          updateMeta(state.title, state.chapterTitle);
          refreshStatusLine();
        }

        /** 当前正在看的章节号（优先 section 记录，其次宿主 chapterIndex，最后按 chapterUid 查列表） */
        function chapterNoByUid(uid) {
          if (uid === null || uid === undefined) return 0;
          for (var i = 0; i < state.chapters.length; i++) {
            if (String(state.chapters[i].chapterUid) === String(uid)) return chapterNoOf(state.chapters[i], i);
          }
          return 0;
        }

        function currentChapterNo() {
          var sec = state.currentSectionIndex >= 0 ? state.sections[state.currentSectionIndex] : null;
          if (sec && Number(sec.chapterNo) > 0) return Number(sec.chapterNo);
          var idx = Number(state.chapterIndex);
          if (state.loadedOnce && isFinite(idx) && idx >= 0) return idx + 1;
          return chapterNoByUid(state.chapterUid);
        }

        function currentChapterUid() {
          var sec = state.currentSectionIndex >= 0 ? state.sections[state.currentSectionIndex] : null;
          if (sec && sec.chapterUid !== undefined && sec.chapterUid !== null) return String(sec.chapterUid);
          return state.chapterUid === null || state.chapterUid === undefined ? "" : String(state.chapterUid);
        }

        function currentChapterLabel() {
          var no = currentChapterNo();
          return no > 0 ? "第 " + no + " 章" : "";
        }

        function addDivider(title, chapterUid, chapterNo) {
          if (!title) return;
          var no = Number(chapterNo) > 0 ? Number(chapterNo) : chapterNoByUid(chapterUid);
          dom.body.appendChild(
            el("div", { class: "wm-divider", text: no > 0 ? "第 " + no + " 章 · " + title : title })
          );
        }

        function appendLines(lines) {
          if (!lines || !lines.length) return;
          var frag = document.createDocumentFragment();
          for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            var text = raw === null || raw === undefined ? "" : String(raw);
            var p = document.createElement("p");
            if (!text.trim()) {
              p.className = "wm-blank";
            } else {
              p.textContent = text;
            }
            frag.appendChild(p);
          }
          dom.body.appendChild(frag);
          measure();
          scheduleFill();
        }

        function clearContent() {
          if (dom.body) dom.body.textContent = "";
          if (dom.scroll) dom.scroll.style.transform = "translate3d(0,0,0)";
          state.offset = 0;
          state.contentHeight = 0;
          state.atEnd = false;
          state.loadedOnce = false;
          state.hasMore = false;
          state.nextChapterUid = null;
          state.sections = [];
          state.currentSectionIndex = -1;
          state.junkSkipCount = 0;
          state.pendingChapterStart = false;
          state.chapterTitle = "";
          state.title = "";
          state.chapterIndex = null;
          state.chapterCount = null;
          state.progress = null;
          state.source = null;
          if (dom.layerStatus) dom.layerStatus.textContent = "";
          if (state.peekOpen) renderPeekPage();
        }

        function measure() {
          if (!dom.scroll || !dom.layer) return;
          state.contentHeight = dom.scroll.scrollHeight || 0;
          state.viewportHeight = dom.layer.clientHeight || window.innerHeight;
        }

        function setLayerStatus(text) {
          if (dom.layerStatus) dom.layerStatus.textContent = text || "";
        }

        /* ---------------- 演示内容 ---------------- */

        function loadDemoPage() {
          if (disposed) return;
          var idx = state.demoPage % DEMO.pages.length;
          var page = DEMO.pages[idx];
          state.demoPage++;
          if (state.demoPage === 1) {
            updateMeta(DEMO.bookTitle, page.title);
          } else {
            addDivider(page.title);
          }
          state.chapterTitle = page.title;
          appendLines(page.lines);
          state.hasMore = true; // 演示文本循环，永不结束
          state.atEnd = false;
          setLayerStatus("内置演示文本 · 登录后显示真实书页");
          refreshStatusLine();
          if (state.peekOpen) renderPeekPage();
        }

        /* ---------------- 内容加载（宿主 API） ---------------- */

        function requestMore(force) {
          if (disposed || state.loading) return;
          var now = Date.now();
          if (!force && now - state.lastRequestTs < 300) return;
          state.lastRequestTs = now;
          if (state.demo) {
            loadDemoPage();
            return;
          }
          if (!state.hostReady) return;
          if (!state.loggedIn && !state.offlineMode) return;
          if (!state.bookId) {
            setStatus("warn", "请先在面板里选择一本书");
            return;
          }
          if (state.atEnd) return;
          if (state.loadedOnce && !state.hasMore && !state.nextChapterUid) {
            state.atEnd = true;
            setLayerStatus("已读到全书末尾");
            setStatus("warn", "已读到全书末尾");
            return;
          }
          var newChapter = state.loadedOnce && !state.hasMore && state.nextChapterUid;
          var chapterUid = newChapter ? state.nextChapterUid : state.chapterUid;
          if (!chapterUid) {
            setStatus("warn", "请先在面板里选择章节");
            return;
          }
          var pos = newChapter ? 0 : state.pos || 0;
          state.loading = true;
          setStatus("info", state.loadedOnce ? "正在加载下一页…" : "正在加载正文…");
          api(
            "/content?bookId=" +
              enc(state.bookId) +
              "&chapterUid=" +
              enc(chapterUid) +
              "&pos=" +
              enc(pos) +
              "&maxChars=" +
              enc(LIMIT.maxChars)
          )
            .then(function (res) {
              if (disposed) return;
              state.loading = false;
              if (!res || res.ok === false) {
                if (res && res.code === "NOT_LOGGED_IN") {
                  state.loggedIn = false;
                  state.sessionExpired = true;
                  state.demo = true;
                  setStatus("warn", "登录已过期 · 请重新扫码或粘贴 Cookie");
                  refreshStatusLine();
                  return;
                }
                throw new Error(errText(res, "正文加载失败"));
              }
              state.error = null;
              state.retryDelay = LIMIT.retryBaseMs;

              // 垃圾正文兜底：正文页返回 <?xml / 版权页，或极短且没有更多内容
              var lines = res.lines || [];
              var joined = lines.join("");
              var compact = joined.replace(/\s/g, "");
              var junkContent =
                JUNK_CONTENT_RE.test(joined) || (compact.length < JUNK_CONTENT_MIN_CHARS && !res.hasMore);
              if (junkContent) {
                var skipToUid = res.nextChapterUid || null;
                if (state.junkSkipCount < LIMIT.junkSkipMax && skipToUid) {
                  state.junkSkipCount++;
                  state.chapterUid = skipToUid;
                  state.pos = 0;
                  state.hasMore = false;
                  state.nextChapterUid = null;
                  state.pendingChapterStart = true;
                  state.loading = false;
                  cfg.chapterUid = skipToUid;
                  saveConfig();
                  setStatus("info", "跳过非正文页（" + state.junkSkipCount + "/" + LIMIT.junkSkipMax + "）…");
                  setTimeout(function () {
                    if (!disposed) requestMore(true);
                  }, 20);
                  return;
                }
                state.loading = false;
                state.loadedOnce = true;
                state.hasMore = false;
                state.nextChapterUid = skipToUid;
                state.atEnd = true;
                setStatus("warn", "当前章节是非正文页（封面/版权/目录），请在面板里换一章");
                setLayerStatus("非正文页 · 请手动选择章节");
                refreshStatusLine();
                return;
              }
              state.junkSkipCount = 0;

              // 宿主 /content 可能带 chapterIndex(0-based)/chapterCount，可用于显示「第 N 章」
              var contentNo = 0;
              if (res.chapterIndex !== undefined && res.chapterIndex !== null && isFinite(Number(res.chapterIndex))) {
                state.chapterIndex = Number(res.chapterIndex);
                contentNo = state.chapterIndex + 1;
              }
              if (res.chapterCount !== undefined && res.chapterCount !== null && isFinite(Number(res.chapterCount))) {
                state.chapterCount = Number(res.chapterCount);
              }
              if (!contentNo) contentNo = chapterNoByUid(state.chapterUid);

              var startOffset = state.contentHeight;
              var startedNewChapter = !!newChapter || state.pendingChapterStart;
              if (newChapter) {
                state.chapterUid = chapterUid;
                state.pos = 0;
              }
              state.pendingChapterStart = false;
              state.title = res.title || state.title || "";
              if (startedNewChapter && res.chapterTitle) addDivider(res.chapterTitle, state.chapterUid, contentNo);
              appendLines(lines);
              if (startedNewChapter || !state.sections.length) {
                beginSection(res.chapterTitle || "正文", startOffset, state.chapterUid, contentNo);
              }
              updateCurrentSection();
              if (state.panelOpen && state.lastChapterUidRendered !== currentChapterUid()) {
                renderChapters();
              }
              if (res.progress !== undefined && res.progress !== null && isFinite(Number(res.progress))) {
                state.progress = Number(res.progress);
              }
              state.source = res.source === "cache" ? "cache" : res.source === "online" ? "online" : null;
              state.pos = res.pos === null || res.pos === undefined ? pos : res.pos;
              state.hasMore = !!res.hasMore;
              state.nextChapterUid = res.nextChapterUid || null;
              state.loadedOnce = true;
              cfg.pos = state.pos;
              cfg.chapterUid = state.chapterUid;
              saveConfig();
              if (!state.hasMore && !state.nextChapterUid) {
                state.atEnd = true;
                setLayerStatus("已读到全书末尾");
                setStatus("warn", "已读到全书末尾");
              } else {
                setLayerStatus("");
              }
              if (state.peekOpen) {
                setPeekHint("滚动阅读 · 到底自动加载 · Esc 关闭");
                renderPeekPage();
              }
              refreshStatusLine();
              scheduleFill();
            })
            .catch(function (err) {
              if (disposed) return;
              state.loading = false;
              state.error = err;
              setStatus("error", "加载失败，已停在末尾：" + (err && err.message ? err.message : "网络错误"));
              setLayerStatus("加载失败 · 已停在末尾 · 稍后自动重试");
              if (state.peekOpen) {
                setPeekHint("加载失败");
                renderPeekPage();
              }
              scheduleRetry();
            });
        }

        function scheduleRetry() {
          if (state.retryTimer) clearTimeout(state.retryTimer);
          var delay = state.retryDelay;
          state.retryDelay = Math.min(LIMIT.retryMaxMs, state.retryDelay * 2);
          state.retryTimer = setTimeout(function () {
            state.retryTimer = null;
            if (!disposed && cfg.enabled && !state.demo) requestMore();
          }, delay);
        }

        function scheduleHostRetry() {
          if (state.hostRetryTimer) clearTimeout(state.hostRetryTimer);
          var delay = state.hostRetryDelay;
          state.hostRetryDelay = Math.min(LIMIT.hostRetryMaxMs, state.hostRetryDelay * 2);
          state.hostRetryTimer = setTimeout(function () {
            state.hostRetryTimer = null;
            if (!disposed && state.hostReady !== true) detectHost();
          }, delay);
        }

        function scheduleFill() {
          setTimeout(function () {
            if (disposed) return;
            measure();
            var gap = state.contentHeight - state.offset - state.viewportHeight;
            if (gap < 260 && !state.loading && !state.atEnd) requestMore();
          }, 40);
        }

        /**
         * 兜底看门狗：rAF 在后台标签页/被节流的环境里会停摆，
         * 用低频 setInterval 保证“读到接近底部就续页”始终能发生。
         */
        function watchdogTick() {
          if (disposed || !cfg.enabled || state.atEnd || state.loading) return;
          measure();
          updateCurrentSection();
          var gap = state.contentHeight - state.offset - state.viewportHeight;
          if (gap < 600) requestMore();
        }

        /* ---------------- 滚动（rAF，速度 0-3） ---------------- */

        function applyTransform() {
          if (!dom.scroll) return;
          dom.scroll.style.transform = "translate3d(0," + -state.offset.toFixed(2) + "px,0)";
        }

        function tick(ts) {
          if (disposed || !state.running) return;
          state.rafId = window.requestAnimationFrame(tick);
          if (!state.lastTs) {
            state.lastTs = ts;
            return;
          }
          var dt = Math.min(ts - state.lastTs, 120);
          state.lastTs = ts;
          if (!cfg.enabled) return;
          if (state.contentHeight <= 0) measure();
          // peek 浮层打开时冻结背景自动滚动，关闭后从冻结位置继续
          if (!state.peekOpen && cfg.speed > 0 && state.contentHeight > 0 && !state.atEnd) {
            var msPerPx = SPEED_MS[cfg.speed] || 42;
            state.offset += dt / msPerPx;
            var maxOffset = Math.max(0, state.contentHeight - state.viewportHeight + 120);
            if (state.offset >= maxOffset) {
              state.offset = maxOffset;
            }
            applyTransform();
            updateCurrentSection();
          }
          if (!state.loading && !state.atEnd) {
            var gap = state.contentHeight - state.offset - state.viewportHeight;
            if (gap < 520) requestMore();
          }
        }

        function startTicker() {
          if (state.running) return;
          state.running = true;
          state.lastTs = 0;
          state.rafId = window.requestAnimationFrame(tick);
        }

        function stopTicker() {
          state.running = false;
          if (state.rafId) {
            window.cancelAnimationFrame(state.rafId);
            state.rafId = null;
          }
        }

        /* ---------------- 配置应用 ---------------- */

        function applyConfig(patch) {
          if (patch) {
            for (var k in patch) {
              if (!Object.prototype.hasOwnProperty.call(cfg, k)) continue;
              if (patch[k] === undefined || patch[k] === null) continue;
              cfg[k] = patch[k];
            }
            cfg.opacity = clamp(cfg.opacity, LIMIT.opacity[0], LIMIT.opacity[1]);
            cfg.fontSize = Math.round(clamp(cfg.fontSize, LIMIT.fontSize[0], LIMIT.fontSize[1]));
            cfg.speed = Math.round(clamp(cfg.speed, 0, 3));
          }
          if (dom.page) dom.page.style.opacity = String(cfg.opacity);
          if (dom.layer) {
            dom.layer.style.display = cfg.enabled ? "" : "none";
            dom.layer.style.setProperty("--wm-size", cfg.fontSize + "px");
            dom.layer.style.pointerEvents = cfg.clickThrough ? "none" : "auto";
          }
          if (dom.dot) dom.dot.setAttribute("data-on", cfg.enabled ? "1" : "0");
          applyPeekFont();
          applyPeekSize();
          if (document.documentElement) {
            if (cfg.enabled) document.documentElement.classList.remove(OFF_CLASS);
            else document.documentElement.classList.add(OFF_CLASS);
          }
          if (cfg.enabled) {
            scheduleScan(true);
            startTicker();
            if (state.demo) scheduleFill();
          } else {
            restoreGlassed();
            stopTicker();
          }
          if (patch) {
            saveConfig();
            syncControls();
            refreshStatusLine();
            if (state.peekOpen) renderPeekPage();
          }
        }

        function syncControls() {
          if (dom.cEnabled) dom.cEnabled.checked = cfg.enabled;
          if (dom.cThrough) dom.cThrough.checked = cfg.clickThrough;
          if (dom.cOpacity) {
            dom.cOpacity.value = String(Math.round(cfg.opacity * 100));
            if (dom.vOpacity) dom.vOpacity.textContent = Math.round(cfg.opacity * 100) + "%";
          }
          if (dom.cFont) {
            dom.cFont.value = String(cfg.fontSize);
            if (dom.vFont) dom.vFont.textContent = cfg.fontSize + "px";
          }
          if (dom.cSpeed) {
            dom.cSpeed.value = String(cfg.speed);
            if (dom.vSpeed) dom.vSpeed.textContent = SPEED_LABEL[cfg.speed];
          }
        }

        /* ---------------- 面板构建 ---------------- */

        function buildPanel() {
          dom.panel = el("div", {
            id: PANEL_ID,
            hidden: true,
            role: "dialog",
            "aria-label": "微信读书摸鱼背景设置"
          });

          // 头部
          dom.closeBtn = el("button", { class: "wm-p-close", type: "button", "aria-label": "关闭", text: "×" });
          dom.head = el("div", { class: "wm-p-head" }, [
            el("div", { class: "wm-p-title" }, [
              el("span", { text: "微信读书 · 摸鱼背景" }),
              el("span", { class: "wm-p-badge", text: "BETA" })
            ]),
            dom.closeBtn
          ]);

          // 状态
          dom.statusDot = el("span", { class: "wm-dot" });
          dom.statusText = el("span", { text: "" });
          dom.statusBox = el("div", { class: "wm-status", "data-kind": "info" }, [dom.statusDot, dom.statusText]);
          dom.readingText = el("div", {
            class: "wm-reading-text",
            style: "font-size:10.5px;color:var(--dsw-alias-label-tertiary,#adb2b8);opacity:.85;",
            text: ""
          });

          // 登录区
          dom.qrBtn = el("button", { class: "wm-btn", type: "button", "data-variant": "primary", text: "扫码登录" });
          dom.cookieToggle = el("button", { class: "wm-btn", type: "button", text: "Cookie 登录" });
          dom.guestRow = el("div", { class: "wm-row" }, [dom.qrBtn, dom.cookieToggle]);

          dom.qrImg = el("img", { class: "wm-qr", alt: "微信读书登录二维码" });
          dom.qrHint = el("div", { class: "wm-qr-hint", text: "" });
          dom.qrWrap = el("div", { class: "wm-qr-wrap", hidden: true }, [dom.qrImg, dom.qrHint]);

          dom.cookieInput = el("textarea", {
            placeholder: "粘贴 Cookie，例如：wr_vid=...; wr_skey=...;",
            "aria-label": "微信读书 Cookie"
          });
          dom.cookieSave = el("button", { class: "wm-btn", type: "button", "data-variant": "primary", text: "保存并登录" });
          dom.cookieWrap = el("div", { class: "wm-cookie", hidden: true }, [
            dom.cookieInput,
            el("div", { class: "wm-row" }, [dom.cookieSave])
          ]);

          dom.nickname = el("span", { class: "wm-name", text: "" });
          dom.logoutBtn = el("button", { class: "wm-btn", type: "button", text: "退出登录" });
          dom.userRow = el("div", { class: "wm-user", hidden: true }, [
            el("span", { class: "wm-user-label", text: "已登录：" }),
            dom.nickname,
            dom.logoutBtn
          ]);

          dom.authBox = el("div", { class: "wm-sec" }, [
            el("div", { class: "wm-label" }, [el("span", { text: "登录" })]),
            dom.guestRow,
            dom.qrWrap,
            dom.cookieWrap,
            dom.userRow
          ]);

          // 书籍 / 章节
          dom.booksList = el("div", { class: "wm-list" });
          dom.booksSec = el("div", { class: "wm-sec", hidden: true }, [
            el("div", { class: "wm-label" }, [
              el("span", { text: "书架" }),
              el("span", { class: "wm-books-count", text: "" })
            ]),
            dom.booksList
          ]);
          dom.chaptersList = el("div", { class: "wm-list" });
          dom.junkToggle = el("button", { class: "wm-junk-toggle", type: "button", hidden: true, text: "" });
          dom.jumpInput = el("input", {
            id: "wm-jump-input",
            class: "wm-jump-input",
            type: "number",
            min: "1",
            step: "1",
            placeholder: "章号",
            "aria-label": "跳到第几章"
          });
          dom.jumpBtn = el("button", {
            id: "wm-jump-btn",
            class: "wm-btn wm-jump-btn",
            type: "button",
            text: "跳转"
          });
          dom.jumpRow = el("div", { class: "wm-jump-row" }, [
            el("span", { class: "wm-jump-label", text: "跳到第" }),
            dom.jumpInput,
            el("span", { class: "wm-jump-label", text: "章" }),
            dom.jumpBtn
          ]);
          dom.chaptersSec = el("div", { class: "wm-sec", hidden: true }, [
            el("div", { class: "wm-label" }, [
              el("span", { text: "章节" }),
              el("span", { class: "wm-chapters-meta" }, [
                el("span", { class: "wm-chapters-count", text: "" }),
                el("span", { class: "wm-chapters-words", text: "" })
              ])
            ]),
            dom.jumpRow,
            dom.junkToggle,
            dom.chaptersList
          ]);

          // 开关
          dom.cEnabled = el("input", { type: "checkbox", id: "wm-c-enabled" });
          dom.cThrough = el("input", { type: "checkbox", id: "wm-c-through" });
          dom.enabledRow = el("label", { class: "wm-toggle", for: "wm-c-enabled" }, [
            el("span", { text: "启用背景" }),
            dom.cEnabled
          ]);
          dom.throughRow = el("label", { class: "wm-toggle", for: "wm-c-through" }, [
            el("span", { text: "点击穿透" }),
            dom.cThrough
          ]);

          // 滑块
          dom.cOpacity = el("input", { type: "range", min: "4", max: "35", step: "1", id: "wm-c-opacity" });
          dom.vOpacity = el("span", { class: "wm-val", text: "" });
          dom.slideOpacity = el("label", { class: "wm-slide", for: "wm-c-opacity" }, [
            el("span", { text: "透明度" }),
            dom.cOpacity,
            dom.vOpacity
          ]);

          dom.cFont = el("input", { type: "range", min: "12", max: "22", step: "1", id: "wm-c-font" });
          dom.vFont = el("span", { class: "wm-val", text: "" });
          dom.slideFont = el("label", { class: "wm-slide", for: "wm-c-font" }, [
            el("span", { text: "字号" }),
            dom.cFont,
            dom.vFont
          ]);

          dom.cSpeed = el("input", { type: "range", min: "0", max: "3", step: "1", id: "wm-c-speed" });
          dom.vSpeed = el("span", { class: "wm-val", text: "" });
          dom.slideSpeed = el("label", { class: "wm-slide", for: "wm-c-speed" }, [
            el("span", { text: "速度" }),
            dom.cSpeed,
            dom.vSpeed
          ]);

          // 整本缓存控件（未登录/demo 时整块隐藏）
          dom.cacheText = el("span", { id: "wm-cache-text", class: "wm-cache-text", text: "" });
          dom.cachePrimary = el("button", {
            id: "wm-cache-primary",
            class: "wm-btn wm-cache-btn",
            type: "button",
            text: "缓存整本"
          });
          dom.cacheCancelBtn = el("button", {
            id: "wm-cache-cancel",
            class: "wm-btn wm-cache-btn",
            type: "button",
            hidden: true,
            text: "取消"
          });
          dom.cacheDeleteBtn = el("button", {
            id: "wm-cache-delete",
            class: "wm-btn wm-cache-btn",
            type: "button",
            hidden: true,
            text: "清除缓存"
          });
          dom.cacheRow = el("div", { class: "wm-cache-row" }, [
            dom.cacheText,
            dom.cachePrimary,
            dom.cacheCancelBtn,
            dom.cacheDeleteBtn
          ]);
          dom.cacheSec = el("div", { class: "wm-sec wm-cache-sec", hidden: true }, [
            el("div", { class: "wm-label" }, [el("span", { text: "离线缓存" })]),
            dom.cacheRow
          ]);

          dom.settingsBox = el("div", { class: "wm-sec" }, [
            el("div", { class: "wm-label" }, [el("span", { text: "显示" })]),
            dom.enabledRow,
            dom.throughRow,
            dom.slideOpacity,
            dom.slideFont,
            dom.slideSpeed
          ]);

          // 底栏 + toast
          dom.footHost = el("span", { text: "检测宿主…" });
          dom.foot = el("div", { class: "wm-p-foot" }, [
            el("span", { text: "weread-moyu v" + VERSION }),
            dom.footHost
          ]);
          dom.toast = el("div", { class: "wm-toast", role: "status" });

          dom.bodyWrap = el("div", { class: "wm-p-body" }, [
            dom.statusBox,
            dom.readingText,
            dom.authBox,
            dom.booksSec,
            dom.chaptersSec,
            dom.cacheSec,
            dom.settingsBox
          ]);

          dom.panel.appendChild(dom.head);
          dom.panel.appendChild(dom.bodyWrap);
          dom.panel.appendChild(dom.foot);
          dom.panel.appendChild(dom.toast);
          document.body.appendChild(dom.panel);

          wirePanelEvents();
        }

        function wirePanelEvents() {
          dom.closeBtn.addEventListener("click", closePanel);
          dom.dot.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (state.panelOpen) closePanel();
            else openPanel();
          });

          dom.qrBtn.addEventListener("click", function () {
            startQrLogin();
          });
          dom.cookieToggle.addEventListener("click", function () {
            dom.cookieWrap.hidden = !dom.cookieWrap.hidden;
            if (!dom.cookieWrap.hidden) dom.cookieInput.focus();
          });
          dom.cookieSave.addEventListener("click", function () {
            submitCookie();
          });
          dom.logoutBtn.addEventListener("click", function () {
            logout();
          });
          dom.junkToggle.addEventListener("click", function () {
            state.showJunkChapters = !state.showJunkChapters;
            renderChapters({ scrollToCurrent: true });
          });
          dom.cachePrimary.addEventListener("click", function () {
            startCacheDownload();
          });
          dom.cacheCancelBtn.addEventListener("click", function () {
            cancelCacheDownload();
          });
          dom.cacheDeleteBtn.addEventListener("click", function () {
            clearCacheDownload();
          });
          dom.jumpBtn.addEventListener("click", function () {
            jumpToChapterNumber(dom.jumpInput.value);
          });
          dom.jumpInput.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") {
              ev.preventDefault();
              jumpToChapterNumber(dom.jumpInput.value);
            }
          });

          dom.cEnabled.addEventListener("change", function () {
            applyConfig({ enabled: !!dom.cEnabled.checked });
          });
          dom.cThrough.addEventListener("change", function () {
            applyConfig({ clickThrough: !!dom.cThrough.checked });
          });
          dom.cOpacity.addEventListener("input", function () {
            applyConfig({ opacity: clamp(Number(dom.cOpacity.value) / 100, LIMIT.opacity[0], LIMIT.opacity[1]) });
          });
          dom.cFont.addEventListener("input", function () {
            applyConfig({ fontSize: Math.round(clamp(Number(dom.cFont.value), LIMIT.fontSize[0], LIMIT.fontSize[1])) });
          });
          dom.cSpeed.addEventListener("input", function () {
            applyConfig({ speed: Math.round(clamp(Number(dom.cSpeed.value), 0, 3)) });
          });
        }

        /* ---------------- 面板开关 ---------------- */

        /** 控制面板和 peek 浮层共用文档级监听（Esc / 点击外部关闭） */
        function syncDocListeners() {
          document.removeEventListener("pointerdown", onDocPointerDown, true);
          document.removeEventListener("keydown", onDocKeyDown, true);
          if (state.panelOpen || state.peekOpen) {
            document.addEventListener("pointerdown", onDocPointerDown, true);
            document.addEventListener("keydown", onDocKeyDown, true);
          }
        }

        function openPanel() {
          if (!dom.panel) return;
          dom.panel.hidden = false;
          state.panelOpen = true;
          refreshStatusLine();
          renderAuth();
          renderBooks();
          renderChapters({ scrollToCurrent: true });
          refreshCacheStatus();
          syncControls();
          syncDocListeners();
        }

        function closePanel() {
          if (!dom.panel) return;
          dom.panel.hidden = true;
          state.panelOpen = false;
          syncDocListeners();
        }

        function togglePanel() {
          if (state.panelOpen) closePanel();
          else openPanel();
        }

        /* ---------------- peek：把“正在看的这一页”清楚显示出来 ---------------- */

        function buildPeek() {
          dom.peekPanel = el("div", {
            id: PEEK_PANEL_ID,
            hidden: true,
            role: "dialog",
            "aria-label": "正在阅读"
          });
          dom.peekEyebrow = el("div", { class: "wm-peek-eyebrow", text: "正在阅读" });
          dom.peekBook = el("span", { class: "wm-peek-book", text: "" });
          dom.peekChap = el("span", { class: "wm-peek-chap", text: "" });
          dom.peekProgress = el("span", { class: "wm-peek-progress", text: "" });
          dom.peekFontMinus = el("button", {
            class: "wm-peek-tool wm-peek-font-minus",
            type: "button",
            "aria-label": "减小字号",
            title: "减小字号",
            text: "A-"
          });
          dom.peekFontPlus = el("button", {
            class: "wm-peek-tool wm-peek-font-plus",
            type: "button",
            "aria-label": "增大字号",
            title: "增大字号",
            text: "A+"
          });
          dom.peekClose = el("button", { class: "wm-peek-close", type: "button", "aria-label": "关闭", text: "×" });
          dom.peekHead = el("div", { class: "wm-peek-head" }, [
            el("div", { class: "wm-peek-head-main" }, [
              dom.peekEyebrow,
              el("div", { class: "wm-peek-title" }, [dom.peekBook, dom.peekChap]),
              dom.peekProgress
            ]),
            el("div", { class: "wm-peek-head-tools" }, [dom.peekFontMinus, dom.peekFontPlus, dom.peekClose])
          ]);
          dom.peekBody = el("div", { class: "wm-peek-body" });
          dom.peekHint = el("span", { class: "wm-peek-hint", text: PEEK_HINT_DEFAULT });
          dom.peekPrevCh = el("button", { class: "wm-peek-btn wm-peek-prev-ch", type: "button", text: "上一章" });
          dom.peekNextCh = el("button", { class: "wm-peek-btn wm-peek-next-ch", type: "button", text: "下一章" });
          dom.peekFoot = el("div", { class: "wm-peek-foot" }, [dom.peekPrevCh, dom.peekHint, dom.peekNextCh]);
          dom.peekResize = el("div", {
            class: "wm-peek-resize",
            title: "拖动调整大小（双击恢复默认）",
            "aria-hidden": "true"
          });
          dom.peekPanel.appendChild(dom.peekHead);
          dom.peekPanel.appendChild(dom.peekBody);
          dom.peekPanel.appendChild(dom.peekFoot);
          dom.peekPanel.appendChild(dom.peekResize);
          document.body.appendChild(dom.peekPanel);

          dom.peekClose.addEventListener("click", closePeek);
          dom.peekBody.addEventListener("scroll", onPeekScroll);
          dom.peekBody.addEventListener("wheel", onPeekScroll, { passive: true });
          dom.peekBody.addEventListener("touchmove", onPeekScroll, { passive: true });
          dom.peekPrevCh.addEventListener("click", function () {
            peekGotoChapter(-1);
          });
          dom.peekNextCh.addEventListener("click", function () {
            peekGotoChapter(1);
          });
          dom.peekFontMinus.addEventListener("click", function () {
            peekAdjustFont(-1);
          });
          dom.peekFontPlus.addEventListener("click", function () {
            peekAdjustFont(1);
          });
          dom.peekResize.addEventListener("pointerdown", onPeekResizeStart);
          dom.peekResize.addEventListener("dblclick", resetPeekSize);
        }

        /** 按当前 cfg.fontSize 设置 peek 正文字号；A-/A+ 与设置面板滑块共用同一配置 */
        function applyPeekFont() {
          if (!dom.peekPanel) return;
          dom.peekPanel.style.setProperty("--wm-size", cfg.fontSize + "px");
        }

        function peekAdjustFont(delta) {
          var next = Math.round(clamp(cfg.fontSize + delta, LIMIT.fontSize[0], LIMIT.fontSize[1]));
          if (next === cfg.fontSize) return;
          applyConfig({ fontSize: next });
        }

        /** 应用 peek 尺寸（cfg.peekWidth / cfg.peekHeight；高度 0 = 默认 64vh） */
        function applyPeekSize() {
          if (!dom.peekPanel) return;
          var maxW = Math.min(920, Math.round(window.innerWidth * 0.94));
          var maxH = Math.round(window.innerHeight * 0.92);
          var width = Math.round(clamp(num(cfg.peekWidth, 560), 300, maxW));
          var height = Math.round(clamp(num(cfg.peekHeight, 0), 320, maxH));
          dom.peekPanel.style.width = width + "px";
          if (height > 0) {
            dom.peekPanel.style.height = height + "px";
            dom.peekPanel.style.maxHeight = maxH + "px";
          } else {
            dom.peekPanel.style.height = "";
            dom.peekPanel.style.maxHeight = "64vh";
          }
        }

        function onPeekResizeStart(ev) {
          if (!dom.peekPanel || !dom.peekResize) return;
          if (ev.button !== undefined && ev.button !== 0) return;
          ev.preventDefault();
          ev.stopPropagation();
          var rect = dom.peekPanel.getBoundingClientRect();
          var startX = ev.clientX;
          var startY = ev.clientY;
          var startW = rect.width;
          var startH = rect.height;
          state.peekResizing = true;
          try {
            dom.peekResize.setPointerCapture(ev.pointerId);
          } catch (e) {}
          function onMove(moveEv) {
            var maxW = Math.min(920, Math.round(window.innerWidth * 0.94));
            var maxH = Math.round(window.innerHeight * 0.92);
            var nextW = Math.round(clamp(startW + (startX - moveEv.clientX), 300, maxW));
            var nextH = Math.round(clamp(startH + (startY - moveEv.clientY), 320, maxH));
            cfg.peekWidth = nextW;
            cfg.peekHeight = nextH;
            applyPeekSize();
          }
          function onUp() {
            document.removeEventListener("pointermove", onMove, true);
            document.removeEventListener("pointerup", onUp, true);
            document.removeEventListener("pointercancel", onUp, true);
            state.peekResizing = false;
            state.peekResizeCleanup = null;
            saveConfig();
          }
          state.peekResizeCleanup = onUp;
          document.addEventListener("pointermove", onMove, true);
          document.addEventListener("pointerup", onUp, true);
          document.addEventListener("pointercancel", onUp, true);
        }

        function resetPeekSize() {
          cfg.peekWidth = 560;
          cfg.peekHeight = 0;
          applyPeekSize();
          saveConfigNow();
        }

        function setPeekHint(text) {
          if (!dom.peekHint) return;
          dom.peekHint.textContent = text || PEEK_HINT_DEFAULT;
          if (state.peekHintTimer) {
            clearTimeout(state.peekHintTimer);
            state.peekHintTimer = null;
          }
          if (text && text !== PEEK_HINT_DEFAULT) {
            state.peekHintTimer = setTimeout(function () {
              state.peekHintTimer = null;
              if (!disposed && dom.peekHint) dom.peekHint.textContent = PEEK_HINT_DEFAULT;
            }, 1800);
          }
        }

        /** 按当前 offset 从背景层已渲染段落里取“正在显示的这一页” */
        function renderPeekPage() {
          if (!dom.peekBody || !dom.peekPanel) return;
          var bookTitle = state.demo ? DEMO.bookTitle : state.title || "微信读书";
          if (dom.peekBook) dom.peekBook.textContent = "《" + bookTitle + "》";
          if (dom.peekChap) {
            var peekNo = currentChapterLabel();
            dom.peekChap.textContent =
              (peekNo ? peekNo + " · " : "") + (state.chapterTitle || (state.demo ? "内置演示文本" : "未选择章节"));
          }
          if (dom.peekProgress) {
            var progress = Number(state.progress);
            var peekSource = cacheSourceLabel();
            if (state.demo) {
              dom.peekProgress.textContent = "演示文本 · 宿主未就绪或未登录";
            } else if (isFinite(progress) && progress > 0) {
              dom.peekProgress.textContent =
                "阅读进度 " + Math.min(100, Math.round(progress)) + "%" + (peekSource ? " · " + peekSource : "");
            } else {
              dom.peekProgress.textContent = peekSource ? "内容来源：" + peekSource : "";
            }
          }

          dom.peekBody.textContent = "";
          if (!cfg.enabled) {
            dom.peekBody.appendChild(
              el("div", {
                class: "wm-peek-empty",
                text: "背景层当前已关闭。打开“启用背景”后，这里会显示背景层正在读的那一页。"
              })
            );
            return;
          }

          // 连续滚动阅读：镜像背景层已加载的全部段落与章节分隔条，
          // 滚动到底由 onPeekScroll 触发 requestMore 自动续载（无缝，无重复段落）。
          var nodes = dom.scroll ? dom.scroll.querySelectorAll(".wm-body p, .wm-divider") : [];
          if (!nodes.length) {
            dom.peekBody.appendChild(el("div", { class: "wm-peek-empty", text: "正在等待正文加载…" }));
            return;
          }
          var frag = document.createDocumentFragment();
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (node.classList.contains("wm-divider")) {
              frag.appendChild(el("div", { class: "wm-peek-divider", text: node.textContent || "" }));
            } else {
              var content = node.textContent || "";
              if (content.trim()) frag.appendChild(el("p", { text: content }));
            }
          }
          dom.peekBody.appendChild(frag);
          // 渲染后仍贴近底部（短章/刚好读完）：主动补载，保证无缝进入下一章
          schedulePeekAutoLoad();
        }

        /** 打开浮层时，把滚动位置对齐到背景层当前正在读的段落 */
        function positionPeekAtOffset() {
          var body = dom.peekBody;
          if (!body || !dom.scroll) return;
          var nodes = dom.scroll.querySelectorAll(".wm-body p, .wm-divider");
          var scrollRect = dom.scroll.getBoundingClientRect();
          var bodyRect = body.getBoundingClientRect();
          var kids = body.children;
          var ki = 0;
          for (var i = 0; i < nodes.length && ki < kids.length; i++) {
            var node = nodes[i];
            var isDivider = node.classList.contains("wm-divider");
            if (!isDivider && !(node.textContent || "").trim()) continue;
            var rect = node.getBoundingClientRect();
            if (rect.top - scrollRect.top + (rect.height || 0) >= (state.offset || 0)) {
              body.scrollTop = kids[ki].getBoundingClientRect().top - bodyRect.top + body.scrollTop - 10;
              return;
            }
            ki += 1;
          }
        }

        /** 关闭浮层时，把背景层 offset 同步到浮层当前正在看的段落 */
        function syncBackgroundToPeek() {
          if (!cfg.enabled || !dom.peekBody || !dom.scroll) return;
          var bodyRect = dom.peekBody.getBoundingClientRect();
          var kids = dom.peekBody.children;
          var targetIndex = -1;
          for (var i = 0; i < kids.length; i++) {
            var r = kids[i].getBoundingClientRect();
            if (r.bottom > bodyRect.top + 48) {
              targetIndex = i;
              break;
            }
          }
          if (targetIndex < 0) return;
          var nodes = dom.scroll.querySelectorAll(".wm-body p, .wm-divider");
          var scrollRect = dom.scroll.getBoundingClientRect();
          var ki = 0;
          for (var j = 0; j < nodes.length && ki < kids.length; j++) {
            var node = nodes[j];
            var isDivider = node.classList.contains("wm-divider");
            if (!isDivider && !(node.textContent || "").trim()) continue;
            if (ki === targetIndex) {
              var top = node.getBoundingClientRect().top - scrollRect.top;
              if (isFinite(top)) {
                state.offset = Math.max(0, top - 4);
                applyTransform();
                updateCurrentSection();
              }
              return;
            }
            ki += 1;
          }
        }

        /** 浮层滚动/滚轮接近底部：自动向宿主续载下一页 / 下一章（无缝阅读） */
        function onPeekScroll() {
          state.peekLastUserScrollTs = Date.now();
          schedulePeekAutoLoad();
        }

        /**
         * 只要贴近底部就补载。
         * wheel/touch 在绝对底部不再产生 scroll 事件，所以滚轮与渲染后都要主动兜底，
         * 才能做到“读到本章最后，继续往下滑无缝进入下一章”。
         * 只在用户最近 4 秒内有过滚动/滚轮时补载，避免停在底部时无限预载整本。
         */
        function schedulePeekAutoLoad() {
          var body = dom.peekBody;
          if (!body || !state.peekOpen) return;
          if (body.scrollTop + body.clientHeight < body.scrollHeight - 600) return;
          if (state.atEnd) {
            setPeekHint("已是最后一章");
            return;
          }
          if (state.loading) return;
          if (Date.now() - (state.peekLastUserScrollTs || 0) > 4000) return;
          requestMore();
          // 300ms 节流可能吞掉这次请求：仍在底部时稍后强制补一次
          setTimeout(function () {
            if (
              !disposed &&
              state.peekOpen &&
              !state.loading &&
              !state.atEnd &&
              Date.now() - (state.peekLastUserScrollTs || 0) <= 6000 &&
              dom.peekBody &&
              dom.peekBody.scrollTop + dom.peekBody.clientHeight >= dom.peekBody.scrollHeight - 620
            ) {
              requestMore(true);
            }
          }, 360);
        }

        /** 上一章 / 下一章按钮：跳过非正文页，加载后浮层从头显示该章 */
        function peekGotoChapter(delta) {
          if (!state.peekOpen) return;
          if (state.loading) {
            setPeekHint("正在加载…");
            return;
          }
          if (state.demo) {
            setPeekHint(delta > 0 ? "演示文本 · 滚动即可继续阅读" : "演示文本 · 滚动即可继续阅读");
            return;
          }
          if (!state.chapters.length) {
            setPeekHint("目录尚未加载");
            return;
          }
          var index = -1;
          for (var i = 0; i < state.chapters.length; i++) {
            if (String(state.chapters[i].chapterUid) === String(state.chapterUid)) {
              index = i;
              break;
            }
          }
          if (index < 0) index = 0;
          var target = index + delta;
          var guard = 0;
          while (target >= 0 && target < state.chapters.length && isJunkChapter(state.chapters[target]) && guard < 12) {
            target += delta > 0 ? 1 : -1;
            guard += 1;
          }
          if (target < 0 || target >= state.chapters.length) {
            setPeekHint(delta > 0 ? "已是最后一章" : "已是第一章");
            return;
          }
          setPeekHint(delta > 0 ? "正在加载下一章…" : "正在加载上一章…");
          selectChapter(state.chapters[target].chapterUid);
        }

        function openPeek() {
          if (!dom.peekPanel || state.peekOpen) return;
          state.peekOpen = true;
          applyPeekFont();
          applyPeekSize();
          dom.peekPanel.hidden = false;
          setPeekHint("滚动阅读 · 到底自动加载 · Esc 关闭");
          renderPeekPage();
          positionPeekAtOffset();
          syncDocListeners();
        }

        function closePeek() {
          if (!dom.peekPanel) return;
          syncBackgroundToPeek();
          state.peekOpen = false;
          dom.peekPanel.hidden = true;
          if (state.peekHintTimer) {
            clearTimeout(state.peekHintTimer);
            state.peekHintTimer = null;
          }
          setPeekHint("滚动阅读 · 到底自动加载 · Esc 关闭");
          syncDocListeners();
        }

        function togglePeek() {
          if (state.peekOpen) closePeek();
          else openPeek();
        }

        /** 上一页 / 下一页按钮已移除：浮层改为连续滚动阅读（onPeekScroll 自动续载） */

        function onDocPointerDown(ev) {
          var target = ev.target;
          if (!target) return;
          var inDock = !!(dom.dock && dom.dock.contains(target));
          if (state.panelOpen && !dom.panel.contains(target) && !inDock) closePanel();
          if (state.peekOpen && dom.peekPanel && !dom.peekPanel.contains(target) && !inDock) closePeek();
        }

        function onDocKeyDown(ev) {
          if (ev.key !== "Escape") return;
          if (state.peekOpen) {
            closePeek();
            ev.stopPropagation();
            return;
          }
          if (state.panelOpen) {
            closePanel();
            ev.stopPropagation();
          }
        }

        /* ---------------- 登录 / 书架 / 章节渲染 ---------------- */

        function renderAuth() {
          var loggedIn = !!state.loggedIn;
          if (dom.guestRow) dom.guestRow.hidden = loggedIn;
          if (dom.userRow) dom.userRow.hidden = !loggedIn;
          if (dom.nickname) {
            dom.nickname.textContent = loggedIn
              ? state.user && state.user.nickname
                ? state.user.nickname
                : "微信读书用户"
              : "";
          }
          if (!loggedIn) {
            if (dom.qrWrap && !state.qrUid) dom.qrWrap.hidden = true;
          } else {
            if (dom.qrWrap) dom.qrWrap.hidden = true;
            stopQrPoll();
          }
          refreshStatusLine();
        }

        function renderBooks() {
          if (!dom.booksSec || !dom.booksList) return;
          var loggedIn = !!state.loggedIn && !state.demo;
          var offline = !loggedIn && state.offlineBooks.length > 0;
          dom.booksSec.hidden = !loggedIn && !offline;
          var countEl = dom.booksSec.querySelector(".wm-books-count");
          if (countEl) countEl.textContent = loggedIn ? String(state.books.length) : offline ? String(state.offlineBooks.length) : "";
          if (!loggedIn) {
            if (!offline) return;
            dom.booksList.textContent = "";
            dom.booksList.appendChild(
              el("div", { class: "wm-empty", text: "离线缓存（免登录可读，登录后可同步进度/缓存更多）" })
            );
            state.offlineBooks.forEach(function (book) {
              var sub = "离线 · " + formatBytes(book.bytes || 0) + (book.complete ? "" : " · 部分");
              var btn = el(
                "button",
                {
                  class: "wm-item",
                  type: "button",
                  "data-active": state.bookId === book.bookId ? "1" : "0"
                },
                [
                  el("span", { class: "wm-item-title", text: book.title || book.bookId }),
                  el("span", { class: "wm-item-sub", text: sub })
                ]
              );
              btn.addEventListener("click", function () {
                selectBook(book.bookId);
              });
              dom.booksList.appendChild(btn);
            });
            return;
          }
          dom.booksList.textContent = "";
          if (!state.books.length) {
            dom.booksList.appendChild(el("div", { class: "wm-empty", text: "书架为空" }));
            return;
          }
          state.books.forEach(function (book) {
            var sub = book.progress ? Math.round(book.progress) + "%" : book.author || "";
            var btn = el(
              "button",
              {
                class: "wm-item",
                type: "button",
                "data-active": state.bookId === book.bookId ? "1" : "0"
              },
              [
                el("span", { class: "wm-item-title", text: book.title || book.bookId }),
                el("span", { class: "wm-item-sub", text: sub })
              ]
            );
            btn.addEventListener("click", function () {
              selectBook(book.bookId);
            });
            dom.booksList.appendChild(btn);
          });
        }

        /** 把当前章行滚动到章节列表的可视区内（上千章时打开目录能直接看到自己） */
        function scrollChapterIntoView() {
          if (!dom.chaptersList) return;
          var list = dom.chaptersList;
          var row =
            list.querySelector('.wm-item[data-current="1"]') || list.querySelector('.wm-item[data-active="1"]');
          if (!row) return;
          var listRect = list.getBoundingClientRect();
          var rowRect = row.getBoundingClientRect();
          if (!listRect.height) return;
          if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) return;
          var target = list.scrollTop + (rowRect.top - listRect.top) - (listRect.height - rowRect.height) / 2;
          list.scrollTop = Math.max(0, target);
        }

        /** 快速跳章：按显示章号定位；命中非正文页时落到最近的正文章并轻提示 */
        function jumpToChapterNumber(raw) {
          if (state.demo || (!state.loggedIn && !state.offlineMode)) {
            toast("请先登录并加载书籍");
            return false;
          }
          if (!state.chapters.length) {
            toast("章节还没加载好");
            return false;
          }
          var wanted = parseInt(String(raw === null || raw === undefined ? "" : raw).trim(), 10);
          if (!isFinite(wanted) || wanted < 1) {
            toast("请输入有效的章号");
            return false;
          }
          var entries = [];
          var maxNo = 0;
          for (var i = 0; i < state.chapters.length; i++) {
            var no = chapterNoOf(state.chapters[i], i);
            if (no > maxNo) maxNo = no;
            entries.push({ chapter: state.chapters[i], no: no, index: i });
          }
          if (wanted > maxNo) {
            toast("超出范围：本书共 " + maxNo + " 章");
            return false;
          }
          var hit = null;
          for (var a = 0; a < entries.length; a++) {
            if (entries[a].no === wanted) {
              hit = entries[a];
              break;
            }
          }
          if (!hit) {
            for (var b = 0; b < entries.length; b++) {
              if (entries[b].no > wanted) {
                hit = entries[b];
                break;
              }
            }
          }
          if (!hit) hit = entries[entries.length - 1];

          var pick = hit;
          var skippedJunk = false;
          if (isJunkChapter(hit.chapter)) {
            skippedJunk = true;
            var next = null;
            for (var c = hit.index + 1; c < entries.length; c++) {
              if (!isJunkChapter(entries[c].chapter)) {
                next = entries[c];
                break;
              }
            }
            if (!next) {
              for (var d = hit.index - 1; d >= 0; d--) {
                if (!isJunkChapter(entries[d].chapter)) {
                  next = entries[d];
                  break;
                }
              }
            }
            if (next) pick = next;
          }

          selectChapter(pick.chapter.chapterUid, { resume: false, force: true });
          renderChapters({ scrollToCurrent: true });
          if (skippedJunk && pick !== hit) {
            toast("第 " + hit.no + " 章为非正文页，已跳到第 " + pick.no + " 章");
          } else {
            toast("已跳到第 " + pick.no + " 章");
          }
          if (dom.jumpInput) dom.jumpInput.value = "";
          return true;
        }

        function renderChapters(opts) {
          if (!dom.chaptersSec || !dom.chaptersList) return;
          opts = opts || {};
          var show = !state.demo && state.chapters.length > 0 && (!!state.loggedIn || state.offlineMode);
          dom.chaptersSec.hidden = !show;
          var countEl = dom.chaptersSec.querySelector(".wm-chapters-count");
          var wordsEl = dom.chaptersSec.querySelector(".wm-chapters-words");
          if (countEl) countEl.textContent = "";
          if (wordsEl) wordsEl.textContent = "";
          if (!show) {
            if (dom.junkToggle) dom.junkToggle.hidden = true;
            if (dom.jumpRow) dom.jumpRow.hidden = true;
            renderCache();
            return;
          }

          // 正文页 / 非正文页（封面、版权、目录…）分组
          var readable = [];
          var junk = [];
          for (var i = 0; i < state.chapters.length; i++) {
            if (isJunkChapter(state.chapters[i])) junk.push(state.chapters[i]);
            else readable.push(state.chapters[i]);
          }
          var totalWords = 0;
          for (var w = 0; w < readable.length; w++) {
            var wc = Number(readable[w].wordCount);
            if (isFinite(wc) && wc > 0) totalWords += wc;
          }
          if (countEl) {
            countEl.textContent = state.chapters.length ? "共 " + state.chapters.length + " 章" : "";
          }
          if (wordsEl) wordsEl.textContent = totalWords > 0 ? "约 " + formatWords(totalWords) : "";
          state.chapterTotalWords = totalWords;
          if (dom.jumpRow) dom.jumpRow.hidden = false;
          if (dom.jumpInput) dom.jumpInput.max = String(state.chapters.length);
          renderCache();
          if (dom.junkToggle) {
            dom.junkToggle.hidden = junk.length === 0;
            dom.junkToggle.textContent = state.showJunkChapters
              ? "隐藏非正文页面（" + junk.length + "）"
              : "显示非正文页面（" + junk.length + "）";
          }

          var keepScroll = dom.chaptersList.scrollTop;
          dom.chaptersList.textContent = "";
          if (!state.chapters.length) {
            dom.chaptersList.appendChild(el("div", { class: "wm-empty", text: "暂无章节" }));
            state.lastChapterUidRendered = "";
            return;
          }

          var activeUid = currentChapterUid();
          state.chapters.forEach(function (chapter, index) {
            var junkItem = isJunkChapter(chapter);
            if (junkItem && !state.showJunkChapters) return;
            var no = chapterNoOf(chapter, index);
            var isCurrent = !!activeUid && String(chapter.chapterUid) === activeUid;
            var btn = el(
              "button",
              {
                class: junkItem ? "wm-item wm-item-junk" : "wm-item",
                type: "button",
                "data-active": state.chapterUid === chapter.chapterUid ? "1" : "0",
                title: junkItem ? "非正文页（封面/版权/目录），一般无需阅读" : "第 " + no + " 章",
                style: "padding-left:" + (8 + Math.max(0, (chapter.level || 1) - 1) * 10) + "px"
              },
              [
                el("span", { class: "wm-item-main" }, [
                  el("span", { class: "wm-ch-no", text: "第 " + no + " 章" }),
                  el("span", { class: "wm-item-title", text: chapter.title || chapter.chapterUid })
                ]),
                chapter.wordCount ? el("span", { class: "wm-item-sub", text: formatWords(chapter.wordCount) }) : null
              ]
            );
            if (isCurrent) btn.setAttribute("data-current", "1");
            btn.addEventListener("click", function () {
              selectChapter(chapter.chapterUid, { resume: false });
            });
            dom.chaptersList.appendChild(btn);
          });
          dom.chaptersList.scrollTop = keepScroll;
          state.lastChapterUidRendered = activeUid;
          if (opts.scrollToCurrent) scrollChapterIntoView();
        }

        function formatWords(n) {
          n = Number(n);
          if (!isFinite(n) || n <= 0) return "";
          if (n >= 10000) return (n / 10000).toFixed(1) + "万字";
          return Math.round(n) + "字";
        }

        function formatBytes(bytes) {
          var n = Number(bytes);
          if (!isFinite(n) || n <= 0) return "0 B";
          if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
          if (n >= 1024) return Math.round(n / 1024) + " KB";
          return Math.round(n) + " B";
        }

        /* ---------------- 整本缓存 / 离线阅读 ---------------- */

        function cacheVisible() {
          return !!(state.bookId && !state.demo && (state.loggedIn || state.offlineMode));
        }

        function stopCachePoll() {
          if (state.cachePollTimer) {
            clearTimeout(state.cachePollTimer);
            state.cachePollTimer = null;
          }
        }

        function scheduleCachePoll() {
          stopCachePoll();
          if (!cacheVisible()) return;
          var st = state.cacheStatus;
          if (!st || st.state !== "running") return;
          state.cachePollTimer = setTimeout(function () {
            state.cachePollTimer = null;
            refreshCacheStatus();
          }, 1500);
        }

        /** 把宿主 /cache/status 归一成 UI 需要的字段（兼容只返回 meta 的情况） */
        function normalizeCacheStatus(res) {
          var st = res || {};
          var meta = st.meta || {};
          var total = Number(st.total);
          if (!isFinite(total) || total < 0) total = state.chapters.length || 0;
          var cached = Number(st.cached);
          if (!isFinite(cached) || cached < 0) cached = 0;
          var bytes = Number(st.bytes);
          if (!isFinite(bytes)) bytes = Number(meta.bytes) || 0;
          var chars = Number(st.chars);
          if (!isFinite(chars)) chars = Number(meta.chars) || 0;
          var complete = st.complete === true || st.state === "done" || meta.complete === true;
          var stateName = st.state || (complete ? "done" : cached > 0 ? "cancelled" : "idle");
          return {
            state: stateName,
            total: total,
            cached: cached,
            chars: chars,
            bytes: bytes,
            complete: complete,
            currentChapter: st.currentChapter || null,
            error: st.error || null
          };
        }

        function cacheSourceLabel() {
          if (state.source === "cache") return "本地缓存";
          if (state.source === "online") return "在线";
          return "";
        }

        function refreshCacheStatus() {
          if (!cacheVisible()) {
            renderCache();
            return Promise.resolve();
          }
          var bookId = state.bookId;
          return api("/cache/status?bookId=" + enc(bookId))
            .then(function (res) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheLoaded = true;
              if (!res || res.ok === false) {
                state.cacheStatus = null;
                renderCache();
                return;
              }
              state.cacheStatus = normalizeCacheStatus(res);
              state.cacheBookId = bookId;
              renderCache();
              scheduleCachePoll();
            })
            .catch(function () {
              if (disposed || state.bookId !== bookId) return;
              state.cacheLoaded = true;
              state.cacheStatus = null;
              renderCache();
            });
        }

        function renderCache() {
          if (!dom.cacheSec) return;
          var visible = cacheVisible();
          dom.cacheSec.hidden = !visible;
          if (!visible) {
            stopCachePoll();
            return;
          }
          if (!state.cacheLoaded && !state.cacheBusy) {
            if (dom.cacheText) dom.cacheText.textContent = "正在读取缓存状态…";
            if (dom.cachePrimary) dom.cachePrimary.hidden = true;
            if (dom.cacheCancelBtn) dom.cacheCancelBtn.hidden = true;
            if (dom.cacheDeleteBtn) dom.cacheDeleteBtn.hidden = true;
            return;
          }

          var st = state.cacheStatus;
          var total = (st && st.total) || state.chapters.length || 0;
          var cached = (st && st.cached) || 0;
          var bytes = (st && st.bytes) || 0;
          var complete = !!(st && st.complete);
          var stateName = st ? st.state : "idle";
          var mode;
          if (stateName === "running") mode = "running";
          else if (complete || stateName === "done") mode = "done";
          else if (cached > 0) mode = "partial";
          else if (stateName === "error") mode = "error";
          else mode = "idle";
          var pct = total > 0 ? Math.min(99, Math.floor((cached / total) * 100)) : 0;

          if (dom.cacheText) {
            if (mode === "running") {
              dom.cacheText.textContent = "缓存中 " + cached + "/" + total + " · " + pct + "%";
            } else if (mode === "done") {
              dom.cacheText.textContent = "已缓存" + (bytes > 0 ? " · " + formatBytes(bytes) : "");
            } else if (mode === "partial") {
              dom.cacheText.textContent =
                "部分缓存 " + cached + "/" + total + (bytes > 0 ? " · " + formatBytes(bytes) : "");
            } else if (mode === "error") {
              dom.cacheText.textContent =
                "缓存失败" + (st && st.error ? "：" + String(st.error).slice(0, 60) : "");
            } else {
              dom.cacheText.textContent = "尚未缓存 · 缓存后可离线阅读";
            }
          }
          if (dom.cachePrimary) {
            var showPrimary = (mode === "idle" || mode === "partial" || mode === "error") && state.loggedIn;
            dom.cachePrimary.hidden = !showPrimary;
            if (mode === "idle") {
              var words = state.chapterTotalWords > 0 ? "（约 " + formatWords(state.chapterTotalWords) + "）" : "";
              dom.cachePrimary.textContent = "缓存整本" + words;
            } else {
              dom.cachePrimary.textContent = "继续缓存";
            }
            dom.cachePrimary.disabled = state.cacheBusy;
          }
          if (dom.cacheCancelBtn) {
            dom.cacheCancelBtn.hidden = mode !== "running";
            dom.cacheCancelBtn.disabled = state.cacheBusy;
          }
          if (dom.cacheDeleteBtn) {
            dom.cacheDeleteBtn.hidden = mode === "running" || !(bytes > 0 || mode === "done" || mode === "partial");
            dom.cacheDeleteBtn.disabled = state.cacheBusy;
          }
        }

        function startCacheDownload() {
          if (!cacheVisible() || state.cacheBusy) return;
          var bookId = state.bookId;
          state.cacheBusy = true;
          renderCache();
          api("/cache/download", { method: "POST", body: { bookId: bookId } })
            .then(function (res) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              state.cacheLoaded = true;
              if (!res || res.ok === false) {
                toast("缓存启动失败：" + errText(res, "未知错误"));
                renderCache();
                return;
              }
              state.cacheStatus = normalizeCacheStatus(res);
              state.cacheBookId = bookId;
              renderCache();
              scheduleCachePoll();
            })
            .catch(function (err) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              toast("缓存启动失败：" + (err && err.message ? err.message : "网络错误"));
              renderCache();
            });
        }

        function cancelCacheDownload() {
          if (!cacheVisible() || state.cacheBusy) return;
          var bookId = state.bookId;
          state.cacheBusy = true;
          renderCache();
          api("/cache/cancel", { method: "POST", body: { bookId: bookId } })
            .then(function (res) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              if (!res || res.ok === false) {
                toast("取消失败：" + errText(res, "未知错误"));
                renderCache();
                return;
              }
              toast("已取消缓存");
              refreshCacheStatus();
            })
            .catch(function (err) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              toast("取消失败：" + (err && err.message ? err.message : "网络错误"));
              renderCache();
            });
        }

        function clearCacheDownload() {
          if (!cacheVisible() || state.cacheBusy) return;
          var bookId = state.bookId;
          state.cacheBusy = true;
          renderCache();
          api("/cache/delete", { method: "POST", body: { bookId: bookId } })
            .then(function (res) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              if (!res || res.ok === false) {
                toast("清除失败：" + errText(res, "未知错误"));
                renderCache();
                return;
              }
              toast("已清除该书缓存");
              state.cacheStatus = null;
              state.cacheBookId = null;
              refreshCacheStatus();
            })
            .catch(function (err) {
              if (disposed || state.bookId !== bookId) return;
              state.cacheBusy = false;
              toast("清除失败：" + (err && err.message ? err.message : "网络错误"));
              renderCache();
            });
        }

        /* ---------------- 数据流程 ---------------- */

        function detectHost() {
          refreshStatusLine();
          api("/ping")
            .then(function (res) {
              if (disposed) return;
              if (res && res.ok === true) {
                state.hostReady = true;
                state.hostVersion = res.version || null;
                state.hostRetryDelay = LIMIT.hostRetryBaseMs;
                if (state.hostRetryTimer) {
                  clearTimeout(state.hostRetryTimer);
                  state.hostRetryTimer = null;
                }
              } else {
                state.hostReady = false;
              }
              refreshStatusLine();
              if (state.hostReady) {
                refreshStatus().then(function () {
                  if (disposed || state.loggedIn) return;
                  enterDemo();
                });
              } else {
                enterDemo();
                scheduleHostRetry();
              }
            })
            .catch(function () {
              if (disposed) return;
              state.hostReady = false;
              refreshStatusLine();
              enterDemo();
              scheduleHostRetry();
            });
        }

        function enterDemo() {
          if (state.demo && state.loadedOnce) return;
          state.demo = true;
          state.loadedOnce = false;
          clearContent();
          state.demoPage = 0;
          state.hasMore = true;
          applyConfig();
          loadDemoPage();
          scheduleFill();
          renderAuth();
          renderBooks();
          renderChapters();
          refreshStatusLine();
        }

        function exitDemo() {
          state.demo = false;
          state.loadedOnce = false;
          clearContent();
        }

        function refreshStatus() {
          if (!state.hostReady) return Promise.resolve();
          return api("/status")
            .then(function (res) {
              if (disposed) return;
              if (!res || res.ok === false) {
                state.loggedIn = false;
                state.user = null;
                state.books = [];
                state.chapters = [];
                state.sessionExpired = !!(res && res.sessionExpired);
                state.wereadReady = res && res.wereadReady === false ? false : null;
                state.hostError = res && res.hostError ? String(res.hostError) : null;
                state.shelfError = null;
                renderAuth();
                renderBooks();
                renderChapters();
                refreshStatusLine();
                refreshOfflineShelf();
                return;
              }
              state.wereadReady = res.wereadReady === false ? false : true;
              state.hostError = res.hostError ? String(res.hostError) : null;
              state.shelfError = res.shelfError ? String(res.shelfError) : null;
              state.loggedIn = !!res.loggedIn;
              state.user = res.user || null;
              state.books = Array.isArray(res.books) ? res.books : [];
              state.sessionExpired = !!res.sessionExpired;
              if (!state.loggedIn) {
                state.chapters = [];
                renderAuth();
                renderBooks();
                renderChapters();
                refreshStatusLine();
                refreshOfflineShelf();
                return;
              }
              state.offlineMode = false;
              exitDemo();
              renderAuth();
              renderBooks();
              renderChapters();
              refreshStatusLine();
              var targetBook = cfg.bookId || res.currentBookId || (state.books[0] && state.books[0].bookId);
              if (targetBook) selectBook(targetBook, { silent: true });
              else if (state.shelfError) {
                setStatus("warn", "已登录，但书架加载失败：" + errText({ error: state.shelfError }));
                refreshStatusLine();
              } else {
                setStatus("warn", "已登录，但书架为空");
                refreshStatusLine();
              }
            })
            .catch(function (err) {
              if (disposed) return;
              state.sessionExpired = true;
              setStatus("error", "读取登录状态失败：" + (err && err.message ? err.message : "网络错误"));
            });
        }

        /** 未登录时：列出已缓存整本的书并恢复上次阅读位置（离线可读） */
        function refreshOfflineShelf() {
          return api("/cache/list")
            .then(function (res) {
              if (disposed) return;
              var books = res && Array.isArray(res.books) ? res.books : [];
              state.offlineBooks = books;
              renderBooks();
              if (!books.length) return;
              exitDemo();
              state.offlineMode = true;
              var target = null;
              for (var i = 0; i < books.length; i++) {
                if (String(books[i].bookId) === String(cfg.bookId)) {
                  target = books[i];
                  break;
                }
              }
              var pick = target || books[0];
              selectBook(pick.bookId, { silent: true });
            })
            .catch(function () {});
        }

        function selectBook(bookId, opts) {
          if (!bookId) return;
          opts = opts || {};
          state.bookId = bookId;
          cfg.bookId = bookId;
          saveConfig();
          renderBooks();
          // 切换书籍：停止旧轮询、重置缓存状态，再拉新书缓存状态（后台下载任务不受影响）
          stopCachePoll();
          state.cacheStatus = null;
          state.cacheBookId = null;
          state.cacheLoaded = false;
          state.cacheBusy = false;
          renderCache();
          refreshCacheStatus();
          setStatus("info", "正在加载章节…");
          api("/books/" + enc(bookId) + "/chapters")
            .then(function (res) {
              if (disposed) return;
              if (!res || res.ok === false) throw new Error(errText(res, "章节加载失败"));
              state.chapters = Array.isArray(res.chapters) ? res.chapters : [];
              renderChapters();
              // 恢复上次章节时也跳过封面/版权等非正文页；否则用 pickStartChapter 自动起读
              var resumeChapter = null;
              if (cfg.chapterUid) {
                for (var ci = 0; ci < state.chapters.length; ci++) {
                  var candidate = state.chapters[ci];
                  if (String(candidate.chapterUid) === String(cfg.chapterUid) && !isJunkChapter(candidate)) {
                    resumeChapter = candidate.chapterUid;
                    break;
                  }
                }
              }
              var startChapter = resumeChapter ? { chapterUid: resumeChapter } : pickStartChapter(state.chapters);
              if (startChapter) selectChapter(startChapter.chapterUid, { resume: !!resumeChapter });
              else setStatus("warn", "这本书没有可读章节");
            })
            .catch(function (err) {
              if (disposed) return;
              setStatus("error", "章节加载失败：" + (err && err.message ? err.message : "网络错误"));
            });
        }

        function selectChapter(chapterUid, opts) {
          if (chapterUid === null || chapterUid === undefined) return;
          opts = opts || {};
          var same = String(state.chapterUid) === String(chapterUid) && !!state.loadedOnce;
          state.chapterUid = chapterUid;
          cfg.chapterUid = chapterUid;
          state.pos = opts.resume ? Math.max(0, num(cfg.pos, 0)) : 0;
          state.atEnd = false;
          state.hasMore = false;
          state.nextChapterUid = null;
          state.junkSkipCount = 0;
          state.pendingChapterStart = false;
          saveConfig();
          renderChapters();
          if (same && !opts.force) {
            refreshStatusLine();
            return;
          }
          clearContent();
          state.loadedOnce = false;
          requestMore(true);
          scheduleFill();
        }

        /* ---------------- 扫码登录 ---------------- */

        function stopQrPoll() {
          if (state.qrTimer) {
            clearTimeout(state.qrTimer);
            state.qrTimer = null;
          }
          state.qrUid = null;
        }

        function startQrLogin() {
          if (dom.qrWrap) dom.qrWrap.hidden = false;
          if (dom.qrHint) dom.qrHint.textContent = "正在获取二维码…";
          if (dom.qrImg) dom.qrImg.removeAttribute("src");
          if (!state.hostReady) {
            if (dom.qrHint) dom.qrHint.textContent = "宿主未就绪，无法扫码登录";
            return;
          }
          api("/qr")
            .then(function (res) {
              if (disposed) return;
              if (!res || res.ok === false) {
                if (dom.qrHint) dom.qrHint.textContent = (res && res.error) || "获取二维码失败";
                return;
              }
              state.qrUid = res.uid || null;
              if (dom.qrImg && res.qrDataUrl) dom.qrImg.src = res.qrDataUrl;
              if (dom.qrHint) dom.qrHint.textContent = "请用微信读书 App 扫码";
              if (state.qrUid) startQrPoll(state.qrUid);
            })
            .catch(function (err) {
              if (dom.qrHint) dom.qrHint.textContent = "获取二维码失败：" + (err && err.message ? err.message : "网络错误");
            });
        }

        function startQrPoll(uid) {
          stopQrPoll();
          state.qrUid = uid;
          var deadline = Date.now() + LIMIT.qrLifeMs;
          function step() {
            if (disposed || !state.qrUid) return;
            api("/qr/poll?uid=" + enc(uid))
              .then(function (res) {
                if (disposed) return;
                var qrState = res && res.state;
                if (qrState === "confirmed") {
                  var nickname = res && res.user && res.user.nickname ? res.user.nickname : "";
                  stopQrPoll();
                  if (dom.qrWrap) dom.qrWrap.hidden = true;
                  if (res && res.user) state.user = res.user;
                  toast(nickname ? "登录成功 · " + nickname : "登录成功");
                  refreshStatus();
                  return;
                }
                if (qrState === "scanned") {
                  if (dom.qrHint) dom.qrHint.textContent = "已扫码，请在手机上确认";
                } else if (qrState === "expired") {
                  if (dom.qrHint) dom.qrHint.textContent = "二维码已过期，请重新获取";
                  stopQrPoll();
                  return;
                } else if (qrState === "error") {
                  if (dom.qrHint) dom.qrHint.textContent = (res && res.error) || "登录轮询失败";
                  stopQrPoll();
                  return;
                } else {
                  if (dom.qrHint) dom.qrHint.textContent = "请用微信读书 App 扫码";
                }
                if (Date.now() > deadline) {
                  if (dom.qrHint) dom.qrHint.textContent = "二维码已过期，请重新获取";
                  stopQrPoll();
                  return;
                }
                state.qrTimer = setTimeout(step, LIMIT.qrPollMs);
              })
              .catch(function () {
                if (disposed) return;
                if (Date.now() > deadline) {
                  if (dom.qrHint) dom.qrHint.textContent = "二维码已过期，请重新获取";
                  stopQrPoll();
                  return;
                }
                state.qrTimer = setTimeout(step, 2500);
              });
          }
          state.qrTimer = setTimeout(step, 1500);
        }

        function submitCookie() {
          if (!state.hostReady) {
            toast("宿主未就绪");
            return;
          }
          var cookie = dom.cookieInput ? String(dom.cookieInput.value || "").trim() : "";
          if (!cookie) {
            toast("请先粘贴 Cookie");
            return;
          }
          if (dom.cookieSave) dom.cookieSave.disabled = true;
          setStatus("info", "正在校验 Cookie…");
          api("/login/cookie", { method: "POST", body: { cookie: cookie } })
            .then(function (res) {
              if (disposed) return;
              if (dom.cookieSave) dom.cookieSave.disabled = false;
              if (!res || res.ok === false) {
                setStatus("error", (res && (res.error || res.code)) || "Cookie 校验失败");
                return;
              }
              if (dom.cookieInput) dom.cookieInput.value = "";
              if (dom.cookieWrap) dom.cookieWrap.hidden = true;
              toast("登录成功");
              refreshStatus();
            })
            .catch(function (err) {
              if (disposed) return;
              if (dom.cookieSave) dom.cookieSave.disabled = false;
              setStatus("error", "Cookie 登录失败：" + (err && err.message ? err.message : "网络错误"));
            });
        }

        function logout() {
          if (!state.hostReady) return;
          api("/logout", { method: "POST" })
            .then(function (res) {
              if (disposed) return;
              if (!res || res.ok === false) {
                setStatus("error", (res && res.error) || "退出失败");
                return;
              }
              state.loggedIn = false;
              state.user = null;
              state.books = [];
              state.chapters = [];
              state.sessionExpired = false;
              cfg.bookId = null;
              cfg.chapterUid = null;
              cfg.pos = 0;
              saveConfigNow();
              toast("已退出登录");
              enterDemo();
              renderAuth();
              renderBooks();
              renderChapters();
              refreshStatusLine();
            })
            .catch(function (err) {
              if (disposed) return;
              setStatus("error", "退出失败：" + (err && err.message ? err.message : "网络错误"));
            });
        }

        /* ---------------- 主题 / 尺寸 / 外壳变化 ---------------- */

        function onBodyMutations(mutations) {
          var themeChanged = false;
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].type === "attributes") themeChanged = true;
          }
          if (themeChanged) scheduleScan(true);
        }

        function onRootMutations() {
          scheduleScan(false);
        }

        function onResize() {
          measure();
          if (state.contentHeight > 0) {
            var maxOffset = Math.max(0, state.contentHeight - state.viewportHeight + 120);
            if (state.offset > maxOffset) {
              state.offset = maxOffset;
              applyTransform();
            }
          }
          scheduleScan(false);
          scheduleFill();
        }

        /* ---------------- 挂载 / 卸载 ---------------- */

        function mount() {
          if (!document.body) {
            document.addEventListener("DOMContentLoaded", mount, { once: true });
            return;
          }
          if (document.getElementById(STYLE_ID)) {
            var stale = [STYLE_ID, LAYER_ID, PANEL_ID, DOT_ID, PEEK_ID, PEEK_PANEL_ID, DOCK_ID];
            for (var s = 0; s < stale.length; s++) {
              var old = document.getElementById(stale[s]);
              if (old && old.parentNode) old.parentNode.removeChild(old);
            }
          }

          // 1) 样式
          var style = document.createElement("style");
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);

          // 2) 背景阅读层
          buildLayer();

          // 3) 右下角隐蔽入口：peek 按钮 + 控制圆点放同一个 dock（不新增可见工具栏）
          dom.dock = el("div", { id: DOCK_ID });
          dom.peekBtn = el("button", {
            id: PEEK_ID,
            type: "button",
            "aria-label": "看清当前这一页",
            title: "看清当前这一页"
          });
          dom.peekBtn.innerHTML = PEEK_ICON_SVG; // 静态内联 SVG，无用户输入
          dom.dot = el("button", {
            id: DOT_ID,
            type: "button",
            "aria-label": "微信读书摸鱼背景设置",
            title: "微信读书 · 摸鱼背景"
          });
          dom.dot.setAttribute("data-on", cfg.enabled ? "1" : "0");
          dom.dock.appendChild(dom.peekBtn);
          dom.dock.appendChild(dom.dot);
          document.body.appendChild(dom.dock);
          dom.peekBtn.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            togglePeek();
          });

          // 4) 控制面板 + peek 浮层
          buildPanel();
          buildPeek();
          syncControls();

          // 5) 事件 / 观察器
          listeners.push(["resize", window, onResize]);
          window.addEventListener("resize", onResize);

          if (typeof MutationObserver === "function") {
            var moBody = new MutationObserver(onBodyMutations);
            moBody.observe(document.body, {
              attributes: true,
              attributeFilter: ["data-ds-dark-theme", "data-theme", "class"]
            });
            observers.push(moBody);
            var root = document.getElementById("root");
            if (root) {
              var moRoot = new MutationObserver(onRootMutations);
              moRoot.observe(root, { childList: true, subtree: true });
              observers.push(moRoot);
            }
          }

          // 6) 应用配置 + 启动
          applyConfig();
          updateMeta("", "");
          measure();
          state.demo = true;
          loadDemoPage();
          startTicker();
          if (!state.watchdogTimer) state.watchdogTimer = setInterval(watchdogTick, 1200);
          refreshStatusLine();
          renderAuth();
          renderBooks();
          renderChapters();

          // 7) 探测宿主
          detectHost();
          setTimeout(function () {
            if (!disposed) {
              measure();
              scheduleScan(true);
            }
          }, 800);
          setTimeout(function () {
            if (!disposed) scheduleScan(false);
          }, 2600);
        }

        function dispose() {
          if (disposed) return;
          disposed = true;
          state.peekOpen = false;
          stopTicker();
          stopQrPoll();
          stopCachePoll();
          if (state.retryTimer) clearTimeout(state.retryTimer);
          if (state.hostRetryTimer) clearTimeout(state.hostRetryTimer);
          if (state.saveTimer) clearTimeout(state.saveTimer);
          if (state.toastTimer) clearTimeout(state.toastTimer);
          if (state.scanTimer) clearTimeout(state.scanTimer);
          if (state.peekHintTimer) clearTimeout(state.peekHintTimer);
          if (state.watchdogTimer) clearInterval(state.watchdogTimer);
          state.retryTimer = state.hostRetryTimer = state.saveTimer = state.toastTimer = state.scanTimer = null;
          state.peekHintTimer = null;
          state.watchdogTimer = null;

          for (var i = 0; i < listeners.length; i++) {
            var entry = listeners[i];
            try {
              entry[1].removeEventListener(entry[0], entry[2]);
            } catch (e) {}
          }
          listeners = [];
          for (var o = 0; o < observers.length; o++) {
            try {
              observers[o].disconnect();
            } catch (e) {}
          }
          observers = [];

          document.removeEventListener("pointerdown", onDocPointerDown, true);
          document.removeEventListener("keydown", onDocKeyDown, true);
          if (document.documentElement) document.documentElement.classList.remove(OFF_CLASS);
          saveConfigNow();
          restoreGlassed();

          var ids = [PANEL_ID, PEEK_PANEL_ID, DOCK_ID, DOT_ID, PEEK_ID, LAYER_ID, STYLE_ID];
          for (var k = 0; k < ids.length; k++) {
            var node = document.getElementById(ids[k]);
            if (node && node.parentNode) node.parentNode.removeChild(node);
          }
          if (window.__wereadMoyuDispose === dispose) window.__wereadMoyuDispose = null;
          if (window.__wereadMoyu && window.__wereadMoyu.__instance === instanceId) {
            try {
              window.__wereadMoyu = null;
            } catch (e) {}
          }
        }

        mount();

        /* ---------------- 调试/验证入口（harness 与自动化断言用） ---------------- */

        var apiSurface = {
          __instance: instanceId,
          bundleId: BUNDLE_ID,
          version: VERSION,
          getConfig: function () {
            var out = {};
            for (var k in cfg) out[k] = cfg[k];
            return out;
          },
          setConfig: function (patch) {
            applyConfig(patch || {});
            return apiSurface.getConfig();
          },
          getState: function () {
            return {
              hostReady: state.hostReady,
              hostVersion: state.hostVersion,
              hostError: state.hostError,
              wereadReady: state.wereadReady,
              shelfError: state.shelfError,
              loggedIn: state.loggedIn,
              demo: state.demo,
              bookId: state.bookId,
              chapterUid: state.chapterUid,
              title: state.title,
              chapterTitle: state.chapterTitle,
              chapterNo: currentChapterNo(),
              chapterCount: state.chapters.length,
              chapterIndex: state.chapterIndex,
              currentSectionIndex: state.currentSectionIndex,
              sectionCount: state.sections.length,
              junkSkipCount: state.junkSkipCount,
              showJunkChapters: state.showJunkChapters,
              offset: state.offset,
              contentHeight: state.contentHeight,
              viewportHeight: state.viewportHeight,
              loading: state.loading,
              loadedOnce: state.loadedOnce,
              running: state.running,
              atEnd: state.atEnd,
              panelOpen: state.panelOpen,
              peekOpen: state.peekOpen,
              progress: state.progress,
              source: state.source,
              cacheState: state.cacheStatus ? state.cacheStatus.state : null,
              cacheTotal: state.cacheStatus ? state.cacheStatus.total : 0,
              cacheCached: state.cacheStatus ? state.cacheStatus.cached : 0,
              cacheBytes: state.cacheStatus ? state.cacheStatus.bytes : 0,
              cacheComplete: !!(state.cacheStatus && state.cacheStatus.complete),
              cacheLoaded: state.cacheLoaded,
              cachePolling: !!state.cachePollTimer,
              cacheVisible: cacheVisible(),
              retryDelay: state.retryDelay,
              error: state.error ? String(state.error.message || state.error) : null
            };
          },
          /** 测试用：不依赖 rAF，直接按速度推进一段滚动（毫秒），返回新 offset */
          __testAdvance: function (ms) {
            if (!cfg.enabled || cfg.speed <= 0 || state.contentHeight <= 0) return state.offset;
            var msPerPx = SPEED_MS[cfg.speed] || 42;
            state.offset += Math.max(0, Number(ms) || 0) / msPerPx;
            var maxOffset = Math.max(0, state.contentHeight - state.viewportHeight + 120);
            if (state.offset > maxOffset) state.offset = maxOffset;
            applyTransform();
            return state.offset;
          },
          /** 测试用：与 tick 相同的自动滚动步进，但尊重 peek 冻结状态 */
          __testAutoScroll: function (ms) {
            if (!cfg.enabled || cfg.speed <= 0 || state.peekOpen || state.contentHeight <= 0) return state.offset;
            return apiSurface.__testAdvance(ms);
          },
          flushConfig: saveConfigNow,
          /** 测试用：直接切书/切章，验证自动起读与垃圾正文跳转逻辑 */
          __testSelectBook: function (bookId) {
            selectBook(bookId);
          },
          __testSelectChapter: function (chapterUid) {
            selectChapter(chapterUid, { resume: false, force: true });
          },
          /** 测试用：返回当前章节列表的垃圾/正文分组信息 */
          __testChapters: function () {
            return state.chapters.map(function (c) {
              return {
                chapterUid: c.chapterUid,
                title: c.title,
                wordCount: c.wordCount,
                chapterIdx: c.chapterIdx,
                junk: isJunkChapter(c)
              };
            });
          },
          __testJump: function (no) {
            return jumpToChapterNumber(no);
          },
          openPanel: openPanel,
          closePanel: closePanel,
          togglePanel: togglePanel,
          openPeek: openPeek,
          closePeek: closePeek,
          togglePeek: togglePeek,
          refreshStatus: refreshStatus,
          logout: logout,
          dispose: dispose
        };
        window.__wereadMoyu = apiSurface;
        window.__wereadMoyuDispose = dispose;

        return dispose;
      }

      /* ================================================================== *
       * Cordis 客户端插件入口
       * ================================================================== */

      exports.name = CLIENT_NAME;
      exports.inject = [];
      exports.version = VERSION;
      exports.apply = function apply(ctx) {
        try {
          // HMR / 重复 apply 时先清理旧实例
          if (typeof window.__wereadMoyuDispose === "function") {
            try {
              window.__wereadMoyuDispose();
            } catch (e) {
              /* ignore */
            }
          }
          var dispose = createInstance(ctx);
          if (ctx && typeof ctx.effect === "function") {
            ctx.effect(function () {
              return function () {
                try {
                  dispose();
                } catch (e) {
                  /* ignore */
                }
              };
            });
          } else if (typeof window !== "undefined") {
            var onUnload = function () {
              window.removeEventListener("beforeunload", onUnload);
              try {
                dispose();
              } catch (e) {
                /* ignore */
              }
            };
            window.addEventListener("beforeunload", onUnload);
          }
        } catch (err) {
          if (typeof console !== "undefined" && console.error) {
            console.error("[weread-moyu] apply failed:", err);
          }
        }
      };

      return module.exports;
    }
  });
})();
