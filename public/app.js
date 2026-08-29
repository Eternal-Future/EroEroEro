/* EroEroEro — minimal comic search frontend. First source: nhentai (proxied). */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const els = {
    viewSearch: $("#view-search"),
    viewDetail: $("#view-detail"),
    form: $("#search-form"),
    q: $("#q"),
    sort: $("#sort"),
    tagTabs: $("#tag-type-tabs"),
    tagQ: $("#tag-q"),
    tagSuggest: $("#tag-suggest"),
    tagChips: $("#tag-chips"),
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
    dlBar: $("#dl-progress"),
    dlText: $("#dl-progress-text"),
    reader: $("#reader"),
    readerCount: $("#reader-count"),
    readerImg: $("#reader-img"),
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

  const state = {
    view: "search",
    query: "",
    sort: "date",
    tagId: null,
    tagName: "",
    tagType: "tag",
    page: 1,
    numPages: 1,
    reader: { id: null, page: 1, pages: [] },
  };

  // ---- helpers ------------------------------------------------------------
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

  function status(msg, isErr) {
    if (msg === null) {
      els.status.textContent = "";
      els.status.className = "status";
      return;
    }
    els.status.textContent = msg;
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

  // ---- routing ------------------------------------------------------------
  function hashToRoute() {
    const h = (location.hash || "#/").replace(/^#/, "");
    const parts = h.split("/").filter(Boolean);
    // "#/g/123" -> detail; otherwise search
    if (parts[0] === "g" && parts[1]) return { view: "detail", id: parts[1] };
    return { view: "search" };
  }

  function applyHash(stateOnly) {
    const route = hashToRoute();
    if (route.view === "detail") {
      openDetail(route.id, { push: false });
    } else {
      show("search");
    }
  }

  // ---- search -------------------------------------------------------------
  function activeFilterText() {
    if (state.tagId) return "标签：" + (state.tagName || "#" + state.tagId);
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
    renderActiveFilter();
    status("加载中…");
    els.grid.innerHTML = "";
    const params = new URLSearchParams({ page: String(state.page), sort: state.sort });
    if (state.tagId) params.set("tag_id", String(state.tagId));
    else if (state.query) params.set("q", state.query);

    try {
      const data = await apiJson("/api/search?" + params.toString());
      state.numPages = data.num_pages || 1;
      renderGrid(data.items || []);
      renderPager();
      status(data.items && data.items.length ? `共 ${fmt(data.total)} 条 · 第 ${state.page}/${state.numPages} 页` : "没有结果");
    } catch (err) {
      status("加载失败：" + err.message, true);
    }
  }

  function renderGrid(items) {
    els.grid.innerHTML = "";
    if (!items.length) {
      els.grid.innerHTML = "";
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const a = el("a", "card");
      a.href = "#/g/" + it.id;
      a.setAttribute("aria-label", it.title);

      const img = document.createElement("img");
      img.className = "card-thumb";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = it.thumb;
      if (it.width && it.height) {
        img.width = it.width;
        img.height = it.height;
      }

      const body = el("div", "card-body");
      const t = el("div", "card-title", it.title);
      const m = el("div", "card-meta");
      m.append(el("span", null, it.pages + " 页"));
      m.append(el("span", null, "♥ " + fmt(it.favorites)));
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

  // ---- tags ---------------------------------------------------------------
  function renderTabs() {
    els.tagTabs.innerHTML = "";
    for (const type of TAG_TYPES) {
      const b = el("button", "tab" + (type === state.tagType ? " active" : ""), TAG_LABEL[type] || type);
      b.dataset.type = type;
      b.addEventListener("click", () => {
        state.tagType = type;
        renderTabs();
        loadTagChips();
      });
      els.tagTabs.append(b);
    }
  }

  async function loadTagChips() {
    els.tagChips.innerHTML = "";
    els.tagChips.append(el("span", "chip tag-type", "加载标签…"));
    try {
      const data = await apiJson(`/api/tags/browse?type=${encodeURIComponent(state.tagType)}&page=1`);
      const items = data.items || [];
      els.tagChips.innerHTML = "";
      if (!items.length) {
        els.tagChips.append(el("span", "chip tag-type", "（无标签）"));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const t of items) {
        const chip = el("button", "chip", t.name);
        chip.append(el("span", "chip-count", fmt(t.count)));
        chip.addEventListener("click", () => selectTag(t));
        frag.append(chip);
      }
      els.tagChips.append(frag);
    } catch (err) {
      els.tagChips.innerHTML = "";
      els.tagChips.append(el("span", "chip tag-type", "标签加载失败"));
    }
  }

  function selectTag(t) {
    state.tagId = t.id;
    state.tagName = t.name;
    state.query = "";
    els.q.value = "";
    runSearch(1);
  }

  function clearFilter() {
    state.tagId = null;
    state.tagName = "";
    state.query = "";
    els.q.value = "";
    runSearch(1);
  }

  let tagSuggestTimer = null;
  let tagSuggestIndex = -1;
  let tagSuggestItems = [];

  function setupTagAutocomplete() {
    els.tagQ.addEventListener("input", () => {
      clearTimeout(tagSuggestTimer);
      const q = els.tagQ.value.trim();
      if (!q) {
        closeSuggest();
        return;
      }
      tagSuggestTimer = setTimeout(() => fetchTagSuggest(q), 180);
    });
    els.tagQ.addEventListener("keydown", (e) => {
      const items = els.tagSuggest.querySelectorAll(".suggest-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        tagSuggestIndex = Math.min(tagSuggestIndex + 1, items.length - 1);
        paintSuggestHover(items);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        tagSuggestIndex = Math.max(tagSuggestIndex - 1, 0);
        paintSuggestHover(items);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (tagSuggestItems[tagSuggestIndex]) {
          pickTagSuggest(tagSuggestItems[tagSuggestIndex]);
        }
      } else if (e.key === "Escape") {
        closeSuggest();
      }
    });
    document.addEventListener("click", (e) => {
      if (!els.tagQ.contains(e.target) && !els.tagSuggest.contains(e.target)) closeSuggest();
    });
  }

  async function fetchTagSuggest(q) {
    try {
      const items = await apiJson("/api/tags?q=" + encodeURIComponent(q) + "&limit=8");
      tagSuggestItems = items;
      tagSuggestIndex = -1;
      renderSuggest(items);
    } catch (_) {
      closeSuggest();
    }
  }

  function renderSuggest(items) {
    els.tagSuggest.innerHTML = "";
    if (!items.length) {
      els.tagSuggest.append(el("div", "suggest-empty", "没有匹配的标签"));
    } else {
      for (const t of items) {
        const row = el("div", "suggest-item");
        row.append(el("span", null, t.name));
        row.append(el("span", "st-type", (TAG_LABEL[t.type] || t.type) + " · " + fmt(t.count)));
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickTagSuggest(t);
        });
        row.addEventListener("mouseenter", () => {
          const items = els.tagSuggest.querySelectorAll(".suggest-item");
          tagSuggestIndex = [...items].indexOf(row);
          paintSuggestHover(items);
        });
        els.tagSuggest.append(row);
      }
    }
    els.tagSuggest.classList.add("open");
  }

  function paintSuggestHover(items) {
    items.forEach((n, i) => n.classList.toggle("hover", i === tagSuggestIndex));
  }

  function pickTagSuggest(t) {
    selectTag(t);
    els.tagQ.value = "";
    closeSuggest();
  }

  function closeSuggest() {
    els.tagSuggest.classList.remove("open");
    tagSuggestItems = [];
    tagSuggestIndex = -1;
  }

  // ---- detail -------------------------------------------------------------
  async function openDetail(id, opts) {
    const push = !opts || opts.push !== false;
    show("detail");
    els.dCover.className = "cover skeleton";
    els.dTitle.textContent = "加载中…";
    els.dJp.textContent = "";
    els.dMeta.textContent = "";
    els.dTags.innerHTML = "";
    els.dPages.innerHTML = "";
    els.dlWrap.hidden = true;
    try {
      const g = await apiJson("/api/gallery/" + encodeURIComponent(id));
      renderDetail(g, push);
    } catch (err) {
      els.dTitle.textContent = "加载失败";
      els.dMeta.textContent = err.message;
      els.dCover.className = "cover";
    }
  }

  function renderDetail(g, push) {
    document.title = g.title + " · EroEroEro";
    els.dCover.className = "cover";
    els.dCover.src = g.cover;
    els.dCover.alt = g.title;
    els.dTitle.textContent = g.title;
    els.dJp.textContent = g.japanese_title || "";
    els.dMeta.textContent = [g.num_pages + " 页", "♥ " + fmt(g.num_favorites), "上传于 " + fmtDate(g.upload_date), g.scanlator].filter(Boolean).join(" · ");

    els.dTags.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const t of g.tags) {
      const chip = el("button", "chip", (TAG_LABEL[t.type] ? TAG_LABEL[t.type] + "：" : "") + t.name);
      chip.append(el("span", "chip-count", fmt(t.count)));
      chip.addEventListener("click", () => {
        selectTag(t);
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

    const readBtn = $("[data-read]");
    const dlBtn = $("[data-download]");
    readBtn.onclick = () => openReader(g, 1);
    dlBtn.onclick = () => download(g);

    if (push && location.hash !== "#/g/" + g.id) location.hash = "#/g/" + g.id;
  }

  function fmtDate(unix) {
    if (!unix) return "—";
    const d = new Date(unix * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // ---- reader -------------------------------------------------------------
  function openReader(g, page) {
    state.reader = { id: g.id, page, pages: g.pages };
    els.reader.hidden = false;
    document.body.style.overflow = "hidden";
    renderReaderPage();
  }

  async function renderReaderPage() {
    const r = state.reader;
    const pg = r.pages[r.page - 1];
    if (!pg) return;
    els.readerCount.textContent = `${r.page} / ${r.pages.length}`;
    const img = new Image();
    img.onload = () => {
      els.readerImg.src = pg.img;
    };
    img.src = pg.img;
    // preload neighbors
    if (r.pages[r.page]) preload(r.pages[r.page].img);
    if (r.pages[r.page - 2]) preload(r.pages[r.page - 2].img);
  }

  function preload(src) {
    const img = new Image();
    img.src = src;
  }

  function readerStep(delta) {
    const r = state.reader;
    const next = r.page + delta;
    if (next < 1 || next > r.pages.length) return;
    r.page = next;
    els.readerImg.style.opacity = "0.4";
    renderReaderPage();
    // small fade to signal page change
    setTimeout(() => (els.readerImg.style.opacity = "1"), 30);
  }

  function closeReader() {
    els.reader.hidden = true;
    document.body.style.overflow = "";
    els.readerImg.src = "";
    state.reader = { id: null, page: 1, pages: [] };
  }

  // ---- download (stream with progress) ------------------------------------
  async function download(g) {
    els.dlWrap.hidden = false;
    els.dlBar.innerHTML = '<div style="width:0%"></div>';
    els.dlText.textContent = "准备下载…";
    const bar = els.dlBar.firstChild;
    const total = g.num_pages;
    let received = 0;
    let last = Date.now();

    try {
      const res = await fetch("/api/download/" + encodeURIComponent(g.id));
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const contentLength = Number(res.headers.get("x-total-bytes") || res.headers.get("content-length") || 0);
      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
        }
        const now = Date.now();
        if (now - last > 120) {
          last = now;
          const pct = contentLength ? Math.min(100, (received / contentLength) * 100) : null;
          const label = contentLength
            ? pct.toFixed(0) + "% · " + fmtBytes(received) + " / " + fmtBytes(contentLength)
            : "已下载 " + fmtBytes(received) + "（"+ received + " 字节）";
          els.dlText.textContent = "打包下载中… " + label;
          if (pct != null) bar.style.width = pct + "%";
        }
      }
      const blob = new Blob(chunks, { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = sanitize(g.title) + ".zip";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      els.dlText.textContent = "下载完成（" + fmtBytes(received) + "）";
      bar.style.width = "100%";
    } catch (err) {
      els.dlText.textContent = "下载失败：" + err.message;
    }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  function sanitize(s) {
    return String(s || "download")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  }

  // ---- events -------------------------------------------------------------
  function bind() {
    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      state.query = els.q.value.trim();
      state.tagId = null;
      state.tagName = "";
      history.replaceState(null, "", "#/");
      runSearch(1);
    });

    els.sort.addEventListener("change", () => {
      state.sort = els.sort.value || "date";
      runSearch(1);
    });

    $("[data-clear-filter]").addEventListener("click", clearFilter);
    $("[data-home]").addEventListener("click", () => {
      location.hash = "#/";
      clearFilter();
    });
    $("[data-back]").addEventListener("click", () => {
      if (!els.grid.children.length) runSearch(1);
      else location.hash = "#/";
      show("search");
    });

    $("[data-read]").addEventListener("click", () => {});
    $("[data-download]").addEventListener("click", () => {});

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

    // lazy thumbnail error fallback
    els.grid.addEventListener("error", (e) => {
      if (e.target && e.target.tagName === "IMG") {
        e.target.style.opacity = "0.2";
      }
    }, true);
  }

  // ---- boot ---------------------------------------------------------------
  renderTabs();
  setupTagAutocomplete();
  bind();
  loadTagChips();

  const route = hashToRoute();
  if (route.view === "detail") openDetail(route.id, { push: false });
  else runSearch(1);
})();