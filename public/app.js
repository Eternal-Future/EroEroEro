/* Ero³ — minimal aggregator comic search frontend. First source: nhentai (proxied). */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const els = {
    viewSearch: $("#view-search"),
    viewDetail: $("#view-detail"),
    form: $("#search-form"),
    q: $("#q"),
    sort: $("#sort"),
    tagSuggest: $("#tag-suggest"),
    searchPreview: $("#search-preview"),
    activeFilter: $("#active-filter"),
    activeFilterText: $("#active-filter-text"),
    status: $("#status"),
    grid: $("#grid"),
    pager: $("#pager"),
    dCover: $("#d-cover"),
    dTitle: $("#d-title"),
    dJp: $("#d-jp"),
    dMeta: $("#d-meta"),
    dTags: $("#d-tags"),
    dPages: $("#d-pages"),
    dlWrap: $("#dl-progress-wrap"),
    dlText: $("#dl-progress-text"),
    tagsView: $("#tags-view"),
    tagTypeTabs: $("#tag-type-tabs"),
    allTagChips: $("#all-tag-chips"),
    tagsPager: $("#tags-pager"),
    reader: $("#reader"),
    readerCount: $("#reader-count"),
    readerImg: $("#reader-img"),
    readerLoading: $("#reader-loading"),
    readerPreloadText: $("#reader-preload-text"),
    readerPreloadFill: $("#reader-preload-fill"),
    themeToggle: $("#theme-toggle"),
  };

  const TAG_TYPES = ["tag", "language", "artist", "character", "parody", "group", "category"];
  const TAG_LABEL = {
    tag: "标签",
    language: "语言",
    artist: "作者",
    character: "角色",
    parody: "原作",
    group: "社团",
    category: "分类",
  };
  const SOURCES = { nh: "nhentai" };

  const PRELOAD_DEFAULT = 5;
  function readPreloadCount() {
    try {
      const qp = new URLSearchParams(location.search).get("preload");
      const stored = localStorage.getItem("ero3.preload");
      const n = Number(qp ?? stored ?? PRELOAD_DEFAULT);
      return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.floor(n) : PRELOAD_DEFAULT;
    } catch {
      return PRELOAD_DEFAULT;
    }
  }
  const PRELOAD_COUNT = readPreloadCount();

  function readTheme() {
    try {
      return localStorage.getItem("ero3.theme") || "system";
    } catch {
      return "system";
    }
  }
  const THEME_ORDER = ["system", "light", "dark"];
  const THEME_ICON = { system: "🌗", light: "☀️", dark: "🌙" };
  const THEME_LABEL = { system: "跟随系统", light: "浅色", dark: "深色" };

  const state = {
    view: "search",
    source: "nh",
    theme: readTheme(),
    query: "",
    sort: "date",
    tagId: null,
    tagName: "",
    page: 1,
    numPages: 1,
    reader: { id: null, page: 1, pages: [], token: 0 },
    tags: { type: "tag", page: 1, numPages: 1 },
    detailToken: 0,
  };

  // ---- helpers ------------------------------------------------------------
  function apiBase(source) {
    return `/api/source/${source || state.source}`;
  }

  function fmt(n) {
    if (n == null) return "—";
    return Number(n) >= 10000
      ? (Number(n) / 1000).toFixed(1).replace(/\.0$/, "") + "k"
      : String(n);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function sourceBadge() {
    const name = state.source === "nh" ? "NH" : state.source.toUpperCase();
    const label = SOURCES[state.source] || state.source;
    const badge = el("span", "src-badge", name);
    badge.title = "此漫画来自于 " + label;
    return badge;
  }

  function status(msg, isErr) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (isErr ? " err" : "");
  }

  function show(view) {
    state.view = view;
    els.viewSearch.hidden = view !== "search";
    els.viewDetail.hidden = view !== "detail";
    window.scrollTo({ top: 0 });
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res;
  }

  async function apiJson(url) {
    const res = await api(url);
    return res.json();
  }

  // ---- theme --------------------------------------------------------------
  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === "dark") root.setAttribute("data-theme", "dark");
    else if (mode === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    root.style.colorScheme = mode === "system" ? "" : mode;
    state.theme = mode;
    try {
      localStorage.setItem("ero3.theme", mode);
    } catch (_) {}
    if (els.themeToggle) {
      els.themeToggle.textContent = THEME_ICON[mode] || THEME_ICON.system;
      els.themeToggle.title = "主题：" + (THEME_LABEL[mode] || THEME_LABEL.system);
    }
  }

  function cycleTheme() {
    const i = THEME_ORDER.indexOf(state.theme);
    const next = THEME_ORDER[(i + 1) % THEME_ORDER.length];
    applyTheme(next);
  }

  // ---- routing ------------------------------------------------------------
  function hashToRoute() {
    const h = (location.hash || "#/").replace(/^#/, "");
    const parts = h.split("/").filter(Boolean);
    // "#/g/nh/123" -> detail; otherwise search
    if (parts[0] === "g" && parts[1] && parts[2]) {
      return { view: "detail", source: parts[1], id: parts[2] };
    }
    return { view: "search" };
  }

  function applyHash() {
    const route = hashToRoute();
    if (route.view === "detail") {
      openDetail(route.source, route.id, { push: false });
    } else {
      show("search");
    }
  }

  // ---- search -------------------------------------------------------------
  function activeFilterText() {
    if (state.tagId) return "标签：" + state.source + ":" + (state.tagName || "#" + state.tagId);
    if (state.query) return "关键词：" + state.query;
    return "";
  }

  function renderActiveFilter() {
    const text = activeFilterText();
    if (text) {
      els.activeFilter.hidden = false;
      els.activeFilterText.textContent = text;
    } else {
      els.activeFilter.hidden = true;
    }
  }

  async function runSearch(page) {
    if (page != null) state.page = page;
    show("search");
    closeDropdowns();
    renderActiveFilter();
    status("加载中…");
    els.grid.innerHTML = "";
    const params = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.tagId) params.set("tag_id", String(state.tagId));
    else if (state.query) params.set("q", state.query);
    else if (state.tagName) params.set("tag", state.tagName);

    try {
      const data = await apiJson(`${apiBase()}/search?${params.toString()}`);
      state.numPages = data.num_pages || 1;
      renderGrid(data.items || []);
      renderPager();
      status(
        data.items && data.items.length
          ? `共 ${fmt(data.total)} 条 · 第 ${state.page}/${state.numPages} 页`
          : "没有结果",
      );
    } catch (err) {
      status("加载失败：" + err.message, true);
    }
  }

  function renderGrid(items) {
    els.grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const a = el("a", "card");
      a.href = `#/g/${state.source}/${it.id}`;
      a.setAttribute("aria-label", it.title);

      const img = document.createElement("img");
      img.className = "card-thumb";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = it.thumb;
      if (it.thumb && it.thumb.width) {
        img.width = it.thumb.width;
        img.height = it.thumb.height;
      }

      const body = el("div", "card-body");
      const t = el("div", "card-title", it.title);
      const m = el("div", "card-meta");
      m.append(el("span", null, it.pages + " 页"));
      m.append(el("span", null, "♥ " + fmt(it.favorites)));
      m.append(sourceBadge());
      body.append(t, m);
      a.append(img, body);
      frag.append(a);
    }
    els.grid.append(frag);
  }

  function renderPager() {
    if (state.numPages <= 1) {
      els.pager.hidden = true;
      els.pager.innerHTML = "";
      return;
    }
    els.pager.hidden = false;
    els.pager.innerHTML = "";
    const prev = el("button", "btn", "‹ 上一页");
    prev.disabled = state.page <= 1;
    prev.addEventListener("click", () => runSearch(state.page - 1));
    const next = el("button", "btn", "下一页 ›");
    next.disabled = state.page >= state.numPages;
    next.addEventListener("click", () => runSearch(state.page + 1));
    const ind = el("span", "page-ind", state.page + " / " + state.numPages);
    els.pager.append(prev, ind, next);
  }

  function selectTag(t, source) {
    state.source = source || state.source;
    state.tagId = t && t.id != null ? t.id : null;
    state.tagName = t ? t.name : "";
    state.query = "";
    els.q.value = `${state.source}:${t.name}`;
    runSearch(1);
  }

  function selectTagByName(name, source) {
    state.source = source || state.source;
    state.tagId = null;
    state.tagName = name;
    state.query = "";
    els.q.value = `${state.source}:${name}`;
    runSearch(1);
  }

  function clearFilter() {
    state.tagId = null;
    state.tagName = "";
    state.query = "";
    els.q.value = "";
    runSearch(1);
  }

  // ---- tag syntax suggestions: <channel>:<partial> --------------------------
  let tagSuggestTimer = null;
  let tagSuggestIndex = -1;
  let tagSuggestItems = [];

  function onSearchInput() {
    const v = els.q.value;
    scheduleSearchPreview(v);

    const m = v.match(/^([A-Za-z0-9]+):(.*)$/);
    if (m && m[1] && m[2].length >= 1 && SOURCES[m[1]]) {
      clearTimeout(tagSuggestTimer);
      tagSuggestTimer = setTimeout(() => fetchTagSuggest(m[1], m[2]), 180);
    } else {
      closeTagSuggest();
    }
  }

  async function fetchTagSuggest(source, partial) {
    try {
      const data = await apiJson(
        `${apiBase(source)}/tags?q=${encodeURIComponent(partial)}&limit=5`,
      );
      const items = data.items || [];
      tagSuggestItems = items;
      tagSuggestIndex = -1;
      renderTagSuggest(source, items);
    } catch (_) {
      closeTagSuggest();
    }
  }

  function renderTagSuggest(source, items) {
    els.tagSuggest.innerHTML = "";
    if (!items.length) {
      els.tagSuggest.append(el("div", "dropdown-empty", "没有匹配的标签"));
    } else {
      for (const t of items) {
        const row = el("div", "suggest-item");
        row.append(el("span", null, `${source}:${t.name}`));
        row.append(el("span", "st-type", (TAG_LABEL[t.type] || t.type) + " · " + fmt(t.count)));
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickTagSuggest(source, t);
        });
        row.addEventListener("mouseenter", () => {
          const nodes = els.tagSuggest.querySelectorAll(".suggest-item");
          tagSuggestIndex = [...nodes].indexOf(row);
          paintSuggestHover(nodes);
        });
        els.tagSuggest.append(row);
      }
    }
    els.tagSuggest.classList.add("open");
  }

  function paintSuggestHover(nodes) {
    nodes.forEach((n, i) => n.classList.toggle("hover", i === tagSuggestIndex));
  }

  function pickTagSuggest(source, t) {
    closeTagSuggest();
    selectTag(t, source);
  }

  function closeTagSuggest() {
    els.tagSuggest.classList.remove("open");
    tagSuggestItems = [];
    tagSuggestIndex = -1;
  }

  // ---- search preview: stop typing for 2s -> top 5 results ---------------
  let previewTimer = null;

  function scheduleSearchPreview(v) {
    closeSearchPreview();
    if (!v || !v.trim() || v.length < 2 || /^tag:/.test(v)) return;
    const channelMatch = v.match(/^([A-Za-z0-9]+):/);
    if (channelMatch && SOURCES[channelMatch[1]]) return; // tag suggestion territory
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      try {
        const data = await apiJson(
          `${apiBase()}/search?q=${encodeURIComponent(v.trim())}&sort=${state.sort}&page=1`,
        );
        renderSearchPreview((data.items || []).slice(0, 5));
      } catch (_) {
        /* preview is best-effort */
      }
    }, 2000);
  }

  function renderSearchPreview(items) {
    els.searchPreview.innerHTML = "";
    if (!items.length) {
      els.searchPreview.append(el("div", "dropdown-empty", "没有结果"));
    } else {
      for (const it of items) {
        const row = el("div", "preview-item");
        const img = document.createElement("img");
        img.className = "pv-thumb";
        img.loading = "lazy";
        img.src = it.thumb;
        img.alt = "";
        const body = el("div", "pv-body");
        body.append(el("div", "pv-title", it.title));
        body.append(el("div", "pv-meta", `${it.pages} 页 · ♥ ${fmt(it.favorites)}`));
        row.append(img, body);
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          closeSearchPreview();
          location.hash = `#/g/${state.source}/${it.id}`;
        });
        els.searchPreview.append(row);
      }
    }
    els.searchPreview.classList.add("open");
  }

  function closeSearchPreview() {
    clearTimeout(previewTimer);
    els.searchPreview.classList.remove("open");
    els.searchPreview.innerHTML = "";
  }

  function closeDropdowns() {
    closeTagSuggest();
    closeSearchPreview();
  }

  // ---- all-tags overlay ---------------------------------------------------
  function openTagsView() {
    state.tags = { type: state.tags.type, page: 1, numPages: 1 };
    els.tagsView.hidden = false;
    renderTagTabs();
    loadAllTags();
  }

  function closeTagsView() {
    els.tagsView.hidden = true;
  }

  function renderTagTabs() {
    els.tagTypeTabs.innerHTML = "";
    for (const type of TAG_TYPES) {
      const b = el("button", "tab" + (type === state.tags.type ? " active" : ""), TAG_LABEL[type] || type);
      b.addEventListener("click", () => {
        state.tags.type = type;
        state.tags.page = 1;
        renderTagTabs();
        loadAllTags();
      });
      els.tagTypeTabs.append(b);
    }
  }

  async function loadAllTags() {
    els.allTagChips.innerHTML = "";
    els.allTagChips.append(el("span", "chip tag-type", "加载标签…"));
    try {
      const data = await apiJson(
        `${apiBase()}/tags/browse?type=${encodeURIComponent(state.tags.type)}&page=${state.tags.page}`,
      );
      state.tags.numPages = data.num_pages || 1;
      const items = data.items || [];
      els.allTagChips.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const t of items) {
        const chip = el("button", "chip", `${state.source}:${t.name}`);
        chip.append(el("span", "chip-count", fmt(t.count)));
        chip.addEventListener("click", () => {
          closeTagsView();
          selectTag(t, state.source);
        });
        frag.append(chip);
      }
      els.allTagChips.append(frag);
      renderTagsPager();
    } catch (err) {
      els.allTagChips.innerHTML = "";
      els.allTagChips.append(el("span", "chip tag-type", "标签加载失败"));
    }
  }

  function renderTagsPager() {
    if (state.tags.numPages <= 1) {
      els.tagsPager.hidden = true;
      els.tagsPager.innerHTML = "";
      return;
    }
    els.tagsPager.hidden = false;
    els.tagsPager.innerHTML = "";
    const prev = el("button", "btn", "‹ 上一页");
    prev.disabled = state.tags.page <= 1;
    prev.addEventListener("click", () => {
      state.tags.page -= 1;
      loadAllTags();
    });
    const next = el("button", "btn", "下一页 ›");
    next.disabled = state.tags.page >= state.tags.numPages;
    next.addEventListener("click", () => {
      state.tags.page += 1;
      loadAllTags();
    });
    const ind = el("span", "page-ind", state.tags.page + " / " + state.tags.numPages);
    els.tagsPager.append(prev, ind, next);
  }

  // ---- detail -------------------------------------------------------------
  async function openDetail(source, id, opts) {
    const push = !opts || opts.push !== false;
    show("detail");
    state.source = source;
    state.detailToken += 1;
    els.dCover.removeAttribute("src");
    els.dCover.className = "cover skeleton";
    els.dTitle.textContent = "加载中…";
    els.dJp.textContent = "";
    els.dMeta.textContent = "";
    els.dTags.innerHTML = "";
    els.dPages.innerHTML = "";
    els.dlWrap.hidden = true;
    try {
      const g = await apiJson(`${apiBase(source)}/gallery/${encodeURIComponent(id)}`);
      renderDetail(g, push);
    } catch (err) {
      els.dTitle.textContent = "加载失败";
      els.dMeta.textContent = err.message;
      els.dCover.className = "cover";
    }
  }

  function renderDetail(g, push) {
    document.title = g.title + " · Ero³";
    const token = state.detailToken;
    els.dCover.alt = g.title;
    els.dCover.onload = () => {
      if (token === state.detailToken) els.dCover.className = "cover";
    };
    els.dCover.onerror = () => {
      if (token === state.detailToken) els.dCover.className = "cover";
    };
    els.dCover.className = "cover skeleton";
    els.dCover.src = g.cover;
    els.dTitle.textContent = g.title;
    els.dJp.textContent = g.japanese_title || "";
    els.dMeta.textContent = [
      g.num_pages + " 页",
      "♥ " + fmt(g.num_favorites),
      "上传于 " + fmtDate(g.upload_date),
      g.scanlator,
    ]
      .filter(Boolean)
      .join(" · ");

    els.dTags.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const t of g.tags) {
      const chip = el("button", "chip", `${g.source}:${t.name}`);
      chip.append(el("span", "chip-count", fmt(t.count)));
      chip.addEventListener("click", () => {
        selectTag(t, g.source);
        history.replaceState(null, "", "#/");
      });
      frag.append(chip);
    }
    els.dTags.append(frag);

    els.dPages.innerHTML = "";
    const pfrag = document.createDocumentFragment();
    for (const p of g.pages) {
      const box = el("div", "page");
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "第 " + p.number + " 页";
      img.src = p.thumb;
      box.append(img);
      box.append(el("span", "page-n", String(p.number)));
      box.addEventListener("click", () => openReader(g, p.number));
      pfrag.append(box);
    }
    els.dPages.append(pfrag);

    $("[data-read]").onclick = () => openReader(g, 1);
    $("[data-download]").onclick = () => download(g);

    if (push && location.hash !== `#/g/${g.source}/${g.id}`) {
      location.hash = `#/g/${g.source}/${g.id}`;
    }
  }

  function fmtDate(unix) {
    if (!unix) return "—";
    const d = new Date(unix * 1000);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  // ---- reader -------------------------------------------------------------
  function openReader(g, page) {
    state.reader = { id: g.id, page, pages: g.pages, token: 0 };
    els.reader.hidden = false;
    document.body.style.overflow = "hidden";
    renderReaderPage();
  }

  function renderReaderPage() {
    const r = state.reader;
    const pg = r.pages[r.page - 1];
    if (!pg) return;
    els.readerCount.textContent = `${r.page} / ${r.pages.length}`;
    const token = ++r.token;
    setReaderLoading(true);
    const img = new Image();
    img.onload = () => {
      if (token !== state.reader.token) return;
      els.readerImg.src = pg.img;
      setReaderLoading(false);
    };
    img.onerror = () => {
      if (token !== state.reader.token) return;
      setReaderLoading(false);
    };
    img.src = pg.img;
    preloadNextPages(token);
  }

  function setReaderLoading(loading) {
    els.readerLoading.hidden = !loading;
    els.readerImg.style.visibility = loading ? "hidden" : "visible";
  }

  // Preload the NEXT pages (in reading order) and show progress on top.
  // `PRELOAD_COUNT` is configurable (default 5) via `?preload=N` or localStorage `ero3.preload`.
  function preloadNextPages(token) {
    const r = state.reader;
    const targets = [];
    for (let i = 0; i < Math.max(0, PRELOAD_COUNT); i++) {
      const p = r.pages[r.page + i]; // r.page is 1-based: pages[r.page] is the next page
      if (p) targets.push(p.img);
      else break;
    }
    const total = targets.length;
    let done = 0;
    els.readerPreloadText.textContent = total ? `预加载 0/${total}` : "预加载 0/0";
    els.readerPreloadFill.style.width = "0%";
    if (!total) return;

    const loadOne = (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = img.onerror = () => resolve();
        img.src = src;
      });

    (async () => {
      for (const src of targets) {
        if (token !== state.reader.token) return;
        await loadOne(src);
        if (token !== state.reader.token) return;
        done += 1;
        els.readerPreloadText.textContent = `预加载 ${done}/${total}`;
        els.readerPreloadFill.style.width = `${(done / total) * 100}%`;
      }
    })();
  }

  function readerStep(delta) {
    const r = state.reader;
    const next = r.page + delta;
    if (next < 1 || next > r.pages.length) return;
    r.page = next;
    renderReaderPage();
  }

  function closeReader() {
    state.reader.token += 1;
    els.reader.hidden = true;
    document.body.style.overflow = "";
    els.readerImg.src = "";
    els.readerImg.style.visibility = "visible";
    els.readerLoading.hidden = true;
    state.reader = { id: null, page: 1, pages: [], token: 0 };
  }

  // ---- download: browser-native streamed download (no fixed size) ---------
  function download(g) {
    els.dlWrap.hidden = false;
    els.dlText.textContent = "已交给浏览器流式下载…";
    const a = document.createElement("a");
    a.href = `${apiBase(g.source)}/download/${encodeURIComponent(g.id)}`;
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---- events -------------------------------------------------------------
  function bind() {
    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = els.q.value.trim();
      const m = v.match(/^([A-Za-z0-9]+):(.+)$/);
      // "<channel>:<tag>" (channel naming) -> search that tag by name.
      if (m && SOURCES[m[1]]) {
        selectTagByName(m[2].trim(), m[1]);
        return;
      }
      state.query = v;
      state.tagId = null;
      state.tagName = "";
      history.replaceState(null, "", "#/");
      runSearch(1);
    });

    els.q.addEventListener("input", onSearchInput);
    els.q.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDropdowns();
    });

    els.sort.addEventListener("change", () => {
      state.sort = els.sort.value || "date";
      runSearch(1);
    });

    $("[data-clear-filter]").addEventListener("click", clearFilter);
    els.themeToggle.addEventListener("click", cycleTheme);
    $("[data-home]").addEventListener("click", () => {
      location.hash = "#/";
      clearFilter();
    });
    $("[data-back]").addEventListener("click", () => {
      if (!els.grid.children.length) runSearch(1);
      else location.hash = "#/";
      show("search");
    });

    $("[data-all-tags]").addEventListener("click", openTagsView);
    $("[data-tags-close]").addEventListener("click", closeTagsView);
    els.tagsView.addEventListener("click", (e) => {
      if (e.target === els.tagsView) closeTagsView();
    });

    $("[data-reader-close]").addEventListener("click", closeReader);
    $("[data-reader-prev]").addEventListener("click", () => readerStep(-1));
    $("[data-reader-next]").addEventListener("click", () => readerStep(1));

    els.reader.addEventListener("click", (e) => {
      const stage = els.reader.querySelector(".reader-stage");
      const rect = stage.getBoundingClientRect();
      if (e.clientY < rect.top || e.clientY > rect.bottom) return;
      if (e.clientX < rect.left + rect.width / 2) readerStep(-1);
      else readerStep(1);
    });

    window.addEventListener("hashchange", () => applyHash());
    window.addEventListener("keydown", (e) => {
      if (!els.reader.hidden) {
        if (e.key === "ArrowLeft") readerStep(-1);
        else if (e.key === "ArrowRight") readerStep(1);
        else if (e.key === "Escape") closeReader();
        return;
      }
    });

    document.addEventListener("click", (e) => {
      if (!els.q.contains(e.target) && !els.tagSuggest.contains(e.target) && !els.searchPreview.contains(e.target)) {
        closeDropdowns();
      }
    });

    els.grid.addEventListener(
      "error",
      (e) => {
        if (e.target && e.target.tagName === "IMG") e.target.style.opacity = "0.2";
      },
      true,
    );
  }

  // ---- boot ---------------------------------------------------------------
  applyTheme(state.theme);
  bind();
  try {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  } catch (_) {}

  const route = hashToRoute();
  if (route.view === "detail") openDetail(route.source, route.id, { push: false });
  else runSearch(1);
})();