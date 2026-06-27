// ==UserScript==
// @name         Allhomes Extra (stable overlay)
// @namespace    ahx
// @version      0.14.3
// @match        https://www.allhomes.com.au/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      suggest.realestate.com.au
// @connect      www.property.com.au
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "ahx_panel_stable";
  const SUBURB_PANEL_ID = "ahx_suburb_blocker";
  const SUBURB_STYLE_ID = "ahx_sb_style";
  const BLOCKED_SUBURBS_KEY = "ahx_blocked_suburbs";
  const APP_PROPS_KEY = "__domain_group/APP_PROPS";
  const ROUTE_POLL_MS = 500;
  const SUBURB_SYNC_MS = 1500;

  const LISTING_PATH_RE =
    /^\/(?!sale\/|sold\/|rent\/|rural\/|commercial\/|new-homes\/|nbh\/|agency\/|agents\/|research\/|news\/|sell(?:\/|$))[^?#]*-(?:act|nsw|vic|qld|sa|wa|tas|nt)-\d{4}\/?$/i;
  const ADDRESS_TAIL_RE =
    /,\s*([A-Za-z][A-Za-z'’.\- ]*?)\s+(ACT|NSW|VIC|QLD|SA|WA|TAS|NT)\s+\d{4}(?=\D|$)/;

  // State tracking
  let lastUrl = location.href;
  let lastListingId = null;
  let currentRunId = 0;
  let suburbBlockerStarted = false;

  function isSearchPage() {
    return /^\/(?:sale|sold|rent)\/search\/?$/i.test(location.pathname);
  }

  function removeElementById(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function removeDetailPanel() {
    removeElementById(PANEL_ID);
  }

  function removeSuburbPanel() {
    removeElementById(SUBURB_PANEL_ID);
  }

  function bindPanelToggle(el, { headerSelector, bodySelector, toggleSelector }) {
    const header = el.querySelector(headerSelector);
    const body = el.querySelector(bodySelector);
    const toggle = el.querySelector(toggleSelector);
    if (!header || !body || !toggle) return;

    header.onclick = () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "–" : "+";
    };
  }

  // ---- Utilities ----

  function escapeHtml(str) {
    if (typeof str !== "string") return str;
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function titleCase(s) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function daysFrom(value) {
    if (!value) return null;
    const t = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function fmtMoney(n) {
    return typeof n === "number" ? `$${n.toLocaleString()}` : "N/A";
  }

  function calcAnnualGrowth(prevPrice, prevDate, currPrice, currDate) {
    if (typeof prevPrice !== "number" || typeof currPrice !== "number") return null;
    if (!prevDate || !currDate) return null;
    const t1 = typeof prevDate === "number" ? prevDate : Date.parse(prevDate);
    const t2 = typeof currDate === "number" ? currDate : Date.parse(currDate);
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
    const years = (t2 - t1) / (365 * 24 * 60 * 60 * 1000);
    if (years <= 0) return null;
    const ratio = currPrice / prevPrice;
    if (ratio <= 0) return null;
    const cagr = (Math.pow(ratio, 1 / years) - 1) * 100;
    return cagr;
  }

  function fmtGrowth(pct) {
    if (pct === null || !Number.isFinite(pct)) return "";
    const sign = pct >= 0 ? "+" : "";
    return ` (${sign}${pct.toFixed(1)}%/yr)`;
  }

  function fmtElapsed(dateStr) {
    if (!dateStr) return "";
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t)) return "";
    const years = (Date.now() - t) / (365 * 24 * 60 * 60 * 1000);
    if (years < 0) return "";
    if (years < 1) {
      const months = Math.round(years * 12);
      return ` (${months} mo)`;
    }
    return ` (${years.toFixed(1)} yrs)`;
  }

  function randomDelay(min = 200, max = 350) {
    return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  }

  // ---- Search-page suburb blocker ----

  function startSuburbBlocker() {
    if (suburbBlockerStarted) return;
    suburbBlockerStarted = true;

    const hiddenCards = new Map();
    let nextHiddenId = 1;
    let scheduled = false;

    function loadBlocked() {
      try {
        const raw = localStorage.getItem(BLOCKED_SUBURBS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.map((s) => String(s).toLowerCase()) : [];
      } catch {
        return [];
      }
    }

    function saveBlocked(list) {
      const uniq = [...new Set(list.map((s) => String(s).toLowerCase()))].sort();
      localStorage.setItem(BLOCKED_SUBURBS_KEY, JSON.stringify(uniq));
    }

    let blocked = new Set(loadBlocked());

    function isBlocked(suburb) {
      return blocked.has(String(suburb).toLowerCase());
    }

    function blockSuburb(suburb) {
      blocked.add(String(suburb).toLowerCase());
      saveBlocked([...blocked]);
      sync();
    }

    function unblockSuburb(suburb) {
      blocked.delete(String(suburb).toLowerCase());
      saveBlocked([...blocked]);
      sync();
    }

    function clearBlocked() {
      blocked = new Set();
      saveBlocked([]);
      sync();
    }

    function listingPathFromHref(href) {
      if (!href) return null;
      try {
        const url = new URL(href, location.origin);
        const here = location.hostname.replace(/^www\./i, "");
        const host = url.hostname.replace(/^www\./i, "");
        if (host !== here) return null;
        return LISTING_PATH_RE.test(url.pathname) ? url.pathname : null;
      } catch {
        return null;
      }
    }

    function isListingHref(href) {
      return Boolean(listingPathFromHref(href));
    }

    function getListingLink(el) {
      return [...el.querySelectorAll("a[href]")].find((a) =>
        isListingHref(a.getAttribute("href") || "")
      );
    }

    function distinctListingHrefCount(el) {
      const set = new Set();
      el.querySelectorAll("a[href]").forEach((a) => {
        const path = listingPathFromHref(a.getAttribute("href") || "");
        if (path) set.add(path);
      });
      return set.size;
    }

    function findCardRoot(link) {
      let el = link;
      while (el.parentElement && el.parentElement !== document.body) {
        if (distinctListingHrefCount(el.parentElement) > 1) break;
        el = el.parentElement;
      }
      return el;
    }

    function getSuburbFromCard(card) {
      const locality = card
        .querySelector('[itemprop="addressLocality"]')
        ?.textContent?.trim();
      if (locality) return titleCase(locality.toLowerCase());

      const metaName = card
        .querySelector('meta[itemprop="name"][content]')
        ?.getAttribute("content");
      if (metaName) {
        const mm = metaName.match(ADDRESS_TAIL_RE);
        if (mm) return titleCase(mm[1].trim().toLowerCase());
      }

      const text = (card.textContent || "").replace(/\s+/g, " ");
      const m = text.match(ADDRESS_TAIL_RE);
      if (m) return titleCase(m[1].trim().toLowerCase());

      return null;
    }

    function getCards() {
      const links = [...document.querySelectorAll("a[href]")].filter((a) =>
        isListingHref(a.getAttribute("href") || "")
      );
      const cards = new Set();
      for (const a of links) {
        const card = findCardRoot(a);
        if (card && card !== document.body) cards.add(card);
      }
      return [...cards];
    }

    function countSuburb(counts, suburb, field) {
      const c = counts.get(suburb) || { suburb, visible: 0, hidden: 0 };
      c[field]++;
      counts.set(suburb, c);
    }

    function restoreUnblockedCards() {
      for (const [key, entry] of hiddenCards) {
        if (isBlocked(entry.suburb)) continue;
        if (entry.placeholder.isConnected && !entry.card.isConnected) {
          entry.placeholder.parentNode.insertBefore(entry.card, entry.placeholder);
        }
        if (entry.placeholder.isConnected) entry.placeholder.remove();
        entry.card.style.display = "";
        delete entry.card.dataset.ahxHidden;
        hiddenCards.delete(key);
      }
    }

    function pruneDetachedHiddenCards() {
      for (const [key, entry] of hiddenCards) {
        if (!entry.placeholder.isConnected) hiddenCards.delete(key);
      }
    }

    function removeCard(card, suburb) {
      if (!card.parentNode) return;
      let key = card.dataset.ahxHiddenKey;
      if (!key || hiddenCards.has(key)) {
        const link = getListingLink(card);
        const path = link ? listingPathFromHref(link.getAttribute("href") || "") : "listing";
        key = `${path || "listing"}:${nextHiddenId++}`;
        card.dataset.ahxHiddenKey = key;
      }

      const placeholder = document.createComment(`ahx hidden listing: ${suburb}`);
      card.dataset.ahxHidden = "1";
      card.parentNode.insertBefore(placeholder, card);
      card.remove();
      hiddenCards.set(key, { card, placeholder, suburb });
    }

    function scanAndApply() {
      restoreUnblockedCards();
      pruneDetachedHiddenCards();

      const counts = new Map();
      for (const card of getCards()) {
        const suburb = getSuburbFromCard(card);
        if (!suburb) continue;
        if (isBlocked(suburb)) {
          removeCard(card, suburb);
        } else {
          card.style.display = "";
          delete card.dataset.ahxHidden;
          countSuburb(counts, suburb, "visible");
        }
      }

      pruneDetachedHiddenCards();
      for (const entry of hiddenCards.values()) {
        if (isBlocked(entry.suburb)) countSuburb(counts, entry.suburb, "hidden");
      }

      return counts;
    }

    function ensureSuburbBlockerStyle() {
      if (document.getElementById(SUBURB_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = SUBURB_STYLE_ID;
      style.textContent = `
        #${SUBURB_PANEL_ID}{
          position:fixed;top:10px;left:10px;z-index:2147483647;
          background:rgba(255,255,255,.97);
          border:1px solid rgba(0,0,0,.2);border-radius:10px;
          font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI";
          width:280px;max-width:44vw;box-shadow:0 6px 18px rgba(0,0,0,.18);color:#111;
        }
        #${SUBURB_PANEL_ID} .ahx-header{
          display:flex;align-items:center;justify-content:space-between;
          padding:8px 10px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:600;cursor:pointer;user-select:none;
        }
        #${SUBURB_PANEL_ID} .ahx-toggle{cursor:pointer;user-select:none;font-size:14px;line-height:1;padding:0 4px;}
        #${SUBURB_PANEL_ID} .ahx-body{padding:8px 10px;max-height:70vh;overflow:auto;}
        #${SUBURB_PANEL_ID} .ahx-sec{font-weight:600;margin:8px 0 4px;}
        #${SUBURB_PANEL_ID} .ahx-sec:first-child{margin-top:0;}
        #${SUBURB_PANEL_ID} .ahx-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0;}
        #${SUBURB_PANEL_ID} .ahx-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        #${SUBURB_PANEL_ID} .ahx-count{color:rgba(0,0,0,.45);font-variant-numeric:tabular-nums;}
        #${SUBURB_PANEL_ID} a.ahx-act{color:#0066cc;cursor:pointer;text-decoration:none;white-space:nowrap;}
        #${SUBURB_PANEL_ID} a.ahx-act:hover{text-decoration:underline;}
        #${SUBURB_PANEL_ID} a.ahx-block{color:#c0392b;}
        #${SUBURB_PANEL_ID} .ahx-empty{color:rgba(0,0,0,.45);}
        #${SUBURB_PANEL_ID} .ahx-foot{display:flex;justify-content:space-between;margin-top:8px;border-top:1px solid rgba(0,0,0,.08);padding-top:6px;}
        #${SUBURB_PANEL_ID} .ahx-foot a{color:#0066cc;cursor:pointer;}
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function ensureSuburbBlockerPanel() {
      ensureSuburbBlockerStyle();
      let el = document.getElementById(SUBURB_PANEL_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = SUBURB_PANEL_ID;
        el.innerHTML = `
          <div class="ahx-header">
            <span id="ahx_sb_title">Suburb Blocker</span>
            <span class="ahx-toggle" id="ahx_sb_toggle">–</span>
          </div>
          <div class="ahx-body" id="ahx_sb_body"></div>
        `;
        document.documentElement.appendChild(el);
        bindPanelToggle(el, {
          headerSelector: ".ahx-header",
          bodySelector: "#ahx_sb_body",
          toggleSelector: "#ahx_sb_toggle",
        });
      }
      return el;
    }

    function renderSuburbBlockerPanel(counts) {
      const el = ensureSuburbBlockerPanel();
      const body = el.querySelector("#ahx_sb_body");
      const title = el.querySelector("#ahx_sb_title");

      const present = [...counts.values()].sort((a, b) =>
        a.suburb.localeCompare(b.suburb)
      );
      const visibleSuburbs = present.filter((c) => c.visible > 0);
      const totalVisible = visibleSuburbs.reduce((n, c) => n + c.visible, 0);

      title.textContent = `Suburb Blocker (${totalVisible})`;

      const onPageHtml = visibleSuburbs.length
        ? visibleSuburbs
            .map(
              (c) => `
          <div class="ahx-row">
            <span class="ahx-name" title="${escapeHtml(c.suburb)}">${escapeHtml(c.suburb)}</span>
            <span class="ahx-count">${c.visible}</span>
            <a class="ahx-act ahx-block" data-block="${escapeHtml(c.suburb)}">block</a>
          </div>`
            )
            .join("")
        : `<div class="ahx-empty">No suburbs found yet.</div>`;

      const blockedList = [...blocked].sort();
      const blockedHtml = blockedList.length
        ? blockedList
            .map((s) => {
              const c = counts.get(titleCase(s));
              const hiddenCount = c ? c.hidden : 0;
              return `
          <div class="ahx-row">
            <span class="ahx-name" title="${escapeHtml(titleCase(s))}">${escapeHtml(titleCase(s))}</span>
            <span class="ahx-count">${hiddenCount ? `-${hiddenCount}` : ""}</span>
            <a class="ahx-act" data-unblock="${escapeHtml(s)}">unblock</a>
          </div>`;
            })
            .join("")
        : `<div class="ahx-empty">Nothing blocked.</div>`;

      body.innerHTML = `
        <div class="ahx-sec">On this page</div>
        ${onPageHtml}
        <div class="ahx-sec">Blocked (${blockedList.length})</div>
        ${blockedHtml}
        <div class="ahx-foot">
          <a id="ahx_sb_clear">Clear all</a>
          <a id="ahx_sb_refresh">Refresh</a>
        </div>
      `;

      body.querySelectorAll("a[data-block]").forEach((a) =>
        a.addEventListener("click", () => blockSuburb(a.getAttribute("data-block")))
      );
      body.querySelectorAll("a[data-unblock]").forEach((a) =>
        a.addEventListener("click", () => unblockSuburb(a.getAttribute("data-unblock")))
      );
      body.querySelector("#ahx_sb_clear").addEventListener("click", clearBlocked);
      body.querySelector("#ahx_sb_refresh").addEventListener("click", sync);
    }

    function sync() {
      if (!isSearchPage()) {
        removeSuburbPanel();
        return;
      }

      const counts = scanAndApply();
      renderSuburbBlockerPanel(counts);
    }

    function scheduleSync() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        sync();
      });
    }

    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(sync, SUBURB_SYNC_MS);
    sync();
  }

  // ---- Property.com.au Enrichment ----

  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "undefined") {
        reject(new Error("GM_xmlhttpRequest not available - check Tampermonkey grants"));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method: options.method || "GET",
          url,
          headers: options.headers || {},
          data: options.body || null,
          onload: (res) =>
            resolve({
              ok: res.status >= 200 && res.status < 300,
              status: res.status,
              text: () => Promise.resolve(res.responseText),
              json: () => Promise.resolve(JSON.parse(res.responseText)),
            }),
          onerror: (err) => reject(new Error("Network error: " + (err?.error || "unknown"))),
          ontimeout: () => reject(new Error("Request timeout")),
        });
      } catch (e) {
        reject(new Error("GM_xmlhttpRequest failed: " + e.message));
      }
    });
  }

  function getAddressFromApp(app) {
    const addr = app?.body?.property?.address;
    if (!addr) return null;
    // Allhomes provides formattedFull: "18/15 Bowman Street, Macquarie ACT 2614"
    return addr.formattedFull || null;
  }

  async function fetchPropertyInfo(address) {
    const url = `https://suggest.realestate.com.au/consumer-suggest/suggestions?max=1&type=address&src=homepage&query=${encodeURIComponent(address)}`;
    const res = await gmFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const suggestion = data?._embedded?.suggestions?.[0];
    if (!suggestion?.id || !suggestion?.source) return null;

    const src = suggestion.source;
    const id = suggestion.id;

    // Build slug: {state}/{suburb}-{postcode}/{street}-{streetType}/{streetNumber}-pid-{id}/
    const state = (src.state || "").toLowerCase();
    const suburb = (src.suburb || "").toLowerCase().replace(/\s+/g, "-");
    const postcode = src.postcode || "";
    const street = (src.street || "").toLowerCase();
    const streetType = (src.streetType || "").toLowerCase();
    const streetNumber = (src.streetNumber || "").replace(/\//g, "-");

    return `${state}/${suburb}-${postcode}/${street}-${streetType}/${streetNumber}-pid-${id}/`;
  }

  function parsePropertyHtml(html) {
    const result = { avm: null, rental: null };

    // Extract sale estimate from valueEstimatesV2.estimates.sale section (display values)
    const saleSection = html.match(/\\*"sale\\*":\{.{0,2000}?\\*"__typename\\*":\\*"PropertyPage_PropTrackValueEstimateSale/);
    if (saleSection) {
      const section = saleSection[0];
      const valueMatch = section.match(/\\*"price\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const confMatch = section.match(/\\*"confidence\\*":\{\\*"type\\*":\\*"(\w+)/);
      const maxMatch = section.match(/\\*"range\\*":\{\\*"max\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const minMatch = section.match(/\\*"min\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const subtitleMatch = section.match(/\\*"subtitle\\*":\\*"([^\\]+)\\*/);

      if (valueMatch) {
        result.avm = {
          value: parseInt(valueMatch[1], 10),
          low: minMatch ? parseInt(minMatch[1], 10) : null,
          high: maxMatch ? parseInt(maxMatch[1], 10) : null,
          confidence: confMatch ? confMatch[1] : null,
          date: subtitleMatch ? subtitleMatch[1].replace("Last updated ", "") : null,
        };
      }
    }

    // Fallback: newer property.com.au embeds the estimate in a tracking-data blob
    // using avm_* fields (valueEstimatesV2 is often null now).
    if (!result.avm) {
      const valueMatch = html.match(/\\*"avm_estimated_value\\*":(\d+)/);
      if (valueMatch) {
        const lowMatch = html.match(/\\*"avm_low_range\\*":(\d+)/);
        const highMatch = html.match(/\\*"avm_high_range\\*":(\d+)/);
        const confMatch = html.match(/\\*"avm_confidence\\*":\\*"(\w+)/);
        const dateMatch = html.match(/\\*"avm_last_updated_date\\*":\\*"([\d-]+)/);
        result.avm = {
          value: parseInt(valueMatch[1], 10),
          low: lowMatch ? parseInt(lowMatch[1], 10) : null,
          high: highMatch ? parseInt(highMatch[1], 10) : null,
          confidence: confMatch ? confMatch[1] : null,
          date: dateMatch ? dateMatch[1] : null,
        };
      }
    }

    // Extract rental data from the rental section
    const rentalSection = html.match(/\\*"rental\\*":\{.{0,2000}?\\*"__typename\\*":\\*"PropertyPage_PropTrackValueEstimateRental/);
    if (rentalSection) {
      const section = rentalSection[0];
      const valueMatch = section.match(/\\*"price\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const confMatch = section.match(/\\*"confidence\\*":\{\\*"type\\*":\\*"(\w+)/);
      const maxMatch = section.match(/\\*"range\\*":\{\\*"max\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const minMatch = section.match(/\\*"min\\*":\{[^}]*\\*"value\\*":(\d+)/);
      const subtitleMatch = section.match(/\\*"subtitle\\*":\\*"([^\\]+)\\*/);

      if (valueMatch) {
        result.rental = {
          value: parseInt(valueMatch[1], 10),
          confidence: confMatch ? confMatch[1] : null,
          min: minMatch ? parseInt(minMatch[1], 10) : null,
          max: maxMatch ? parseInt(maxMatch[1], 10) : null,
          date: subtitleMatch ? subtitleMatch[1].replace("Last updated ", "") : null,
        };
      }
    }

    return result;
  }

  async function fetchPropertyData(app, setStatus) {
    const address = getAddressFromApp(app);
    if (!address) return { ok: false, message: "Could not extract address" };

    setStatus("Resolving property…");
    const slug = await fetchPropertyInfo(address);
    if (!slug) return { ok: false, message: "Property not found" };

    setStatus("Fetching valuation data…");
    const pageUrl = `https://www.property.com.au/${slug}`;
    const res = await gmFetch(pageUrl);
    if (!res.ok) {
      const hint =
        res.status === 429 || res.status === 403 ? ' – open this <a href="https://www.property.com.au" target="_blank">link</a>, close it, then retry' : "";
      return { ok: false, message: `Failed to fetch (${res.status})${hint}` };
    }

    const html = await res.text();
    const data = parsePropertyHtml(html);

    if (!data.avm && !data.rental) return { ok: false, message: "No valuation data found in page" };

    return { ok: true, data, url: pageUrl };
  }

  // ---- DOM Helpers ----

  function ensureStyle() {
    if (document.getElementById("ahx_style_stable")) return;
    const style = document.createElement("style");
    style.id = "ahx_style_stable";
    style.textContent = `
      #${PANEL_ID}{
        position:fixed;top:10px;left:10px;z-index:2147483647;
        background:rgba(255,255,255,.96);
        border:1px solid rgba(0,0,0,.2);
        border-radius:10px;
        font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI";
        width:340px;max-width:44vw;box-shadow:0 6px 18px rgba(0,0,0,.18);
      }
      #${PANEL_ID} .ahx-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:8px 10px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:600;cursor:pointer;user-select:none;
      }
      #${PANEL_ID} .ahx-toggle{cursor:pointer;user-select:none;font-size:14px;line-height:1;}
      #${PANEL_ID} .ahx-body{padding:10px 12px;}
      #${PANEL_ID} .k{color:rgba(0,0,0,.55)}
      #${PANEL_ID} .small{font-size:11px;color:rgba(0,0,0,.6)}
      #${PANEL_ID} .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
      #${PANEL_ID} button{
        margin-top:6px;border:1px solid rgba(0,0,0,.18);background:white;
        border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px;
      }
      #${PANEL_ID} button:disabled{opacity:.6;cursor:default;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function currentFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function currentGalleryLayer() {
    const dialog = document.querySelector(
      '#react-aria-modal-dialog[aria-label="Photo Gallery"], [role="dialog"][aria-label="Photo Gallery"]'
    );
    if (!dialog) return null;

    const layers = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.position !== "fixed") return false;
        const zIndex = Number.parseInt(style.zIndex, 10);
        if (!Number.isFinite(zIndex)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8;
      })
      .sort(
        (a, b) =>
          Number.parseInt(getComputedStyle(b).zIndex, 10) -
          Number.parseInt(getComputedStyle(a).zIndex, 10)
      );

    return layers[0] || dialog;
  }

  function currentPanelHost() {
    return currentFullscreenElement() || currentGalleryLayer();
  }

  // Keep the panel inside the active top layer. Allhomes uses native fullscreen
  // in some contexts and a React Aria photo-gallery dialog in others.
  function placeInTopLayer(el) {
    const host = currentPanelHost();
    if (host && host !== el) {
      if (!host.contains(el)) host.appendChild(el);
    } else if (el.parentNode !== document.documentElement) {
      document.documentElement.appendChild(el);
    }
  }

  let panelPlacementHooked = false;
  function hookPanelPlacement() {
    if (panelPlacementHooked) return;
    panelPlacementHooked = true;
    const reseat = () => {
      const el = document.getElementById(PANEL_ID);
      if (el) placeInTopLayer(el);
    };
    document.addEventListener("fullscreenchange", reseat, true);
    document.addEventListener("webkitfullscreenchange", reseat, true);
    new MutationObserver(reseat).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function ensurePanel() {
    ensureStyle();
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = PANEL_ID;
      document.documentElement.appendChild(el);
    }
    placeInTopLayer(el);
    return el;
  }

  function panelTemplate(bodyHtml) {
    return `
      <div class="ahx-header"><div>Allhomes Extra</div><div class="ahx-toggle" id="ahx_toggle">–</div></div>
      <div class="ahx-body" id="ahx_body">${bodyHtml}</div>
    `;
  }

  // ---- Data Extraction ----

  // Suburb (division) slug like "lawson-act-2617". Allhomes embeds this in several
  // places in APP_PROPS; the listing's own slug also ends with the same pattern but
  // has more segments, so we pick the shortest matching value.
  const DIVISION_SLUG_RE = /^[a-z][a-z0-9-]*-(?:act|nsw|vic|qld|sa|wa|tas|nt)-\d{4}$/;

  function getDivisionSlug(app) {
    const found = new Set();
    const seen = new Set();
    (function walk(x) {
      if (!x || typeof x !== "object" || seen.has(x)) return;
      seen.add(x);
      for (const k of Object.keys(x)) {
        const v = x[k];
        if (typeof v === "string") {
          if (DIVISION_SLUG_RE.test(v)) found.add(v);
        } else if (v && typeof v === "object") {
          walk(v);
        }
      }
    })(app?.body?.property ?? app);

    if (found.size) {
      return [...found].sort((a, b) => a.split("-").length - b.split("-").length || a.length - b.length)[0];
    }

    // Fallback: trailing "<suburb>-<state>-<postcode>" from the pathname (single-word suburb only).
    const m = (location.pathname || "").match(/-([a-z]+-(?:act|nsw|vic|qld|sa|wa|tas|nt)-\d{4})\/?$/);
    return m ? m[1] : null;
  }

  // Street locality slug like "wanderlight-avenue-lawson-act-2617" — used to keep the
  // API price probe scoped to a handful of results (avoids pagination).
  function findStreetSlugInObject(root) {
    const seen = new Set();
    function walk(x) {
      if (!x || typeof x !== "object" || seen.has(x)) return null;
      seen.add(x);
      if (x.type === "STREET" && typeof x.slug === "string" && x.slug.length > 3) return x.slug;
      for (const k of Object.keys(x)) {
        const hit = walk(x[k]);
        if (hit) return hit;
      }
      return null;
    }
    return walk(root);
  }

  function getStreetSlugFallbackFromPathname() {
    const p = (location.pathname || "").replace(/^\/+/, "").split("?")[0];
    if (!p) return null;
    const parts = p.split("-");
    const numLike = /^\d+[a-z]?$/i;
    let i = 0;
    if (parts[i] === "unit" || parts[i] === "level" || parts[i] === "lot" || parts[i] === "apartment") i++;
    while (i < parts.length && numLike.test(parts[i])) i++;
    if (i >= parts.length) return null;
    return parts.slice(i).join("-");
  }

  function getStreetSlug(app) {
    return findStreetSlugInObject(app?.body?.property) || getStreetSlugFallbackFromPathname();
  }

  function getTargetListingId(app) {
    const id = app?.body?.property?.listing?.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  }

  // ---- Search-index price band ----
  //
  // Allhomes retired POST /wsvc/search/sale-residential (now 404); the current API is
  // POST /wsvc/search. Two complementary ways to recover the indexed price:
  //
  //  1. Suburb results page (/sale/<division>/, /sold/<division>/) is server-rendered
  //     with each listing's priceRange {gte,lte} inline — instant, no API call. This
  //     covers listings that have an indexed price (incl. "Offers Over $X").
  //  2. For genuinely hidden listings (Auction / By negotiation) the page omits
  //     priceRange, so we binary-search price filters against /wsvc/search instead.

  const SEARCH_ENDPOINT = "https://www.allhomes.com.au/wsvc/search";
  const RANGE_LOW = 0;
  const RANGE_HIGH = 5000000;
  const STEP = 10000;

  function findBandInHtml(html, targetId) {
    const marker = `"id":${targetId}`;
    const idx = html.indexOf(marker);
    if (idx < 0) return null;
    const seg = html.slice(idx, idx + 2500);
    const m = seg.match(/"priceRange"\s*:\s*\{\s*"gte"\s*:\s*(\d+)\s*,\s*"lte"\s*:\s*(\d+)\s*\}/);
    if (!m) return null;
    const labelM = seg.match(/"priceLabel"\s*:\s*"([^"]*)"/);
    return { gte: parseInt(m[1], 10), lte: parseInt(m[2], 10), label: labelM ? labelM[1] : null };
  }

  async function readSuburbBand({ targetId, divisionSlug }) {
    if (!divisionSlug) return null;
    for (const segment of ["sale", "sold"]) {
      const url = `https://www.allhomes.com.au/${segment}/${divisionSlug}/`;
      let res;
      try {
        res = await fetch(url, { credentials: "include" });
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const band = findBandInHtml(await res.text(), targetId);
      if (band) return { ...band, segment };
    }
    return null;
  }

  function snapFloor(x) {
    return Math.floor(x / STEP) * STEP;
  }

  async function probeSearch({ min, max, locality }, retryCount = 0) {
    await randomDelay();
    const payload = {
      sort: { criteria: "AUCTION", order: "ASC" },
      page: 1,
      pageSize: 50,
      results: { type: "LIST" },
      filters: {
        price: { min, max },
        localities: [locality],
        propertyStatus: ["FOR_SALE", "UNDER_OFFER", "SOLD"],
      },
    };
    const res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if ((res.status === 429 || res.status === 503) && retryCount < 1) {
      await randomDelay(1000, 2000);
      return probeSearch({ min, max, locality }, retryCount + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) throw new Error("search API blocked (non-JSON)");
    return res.json();
  }

  function inResults(json, targetId) {
    const tid = String(targetId);
    const arr = json?.searchResults;
    return Array.isArray(arr) && arr.some((r) => String(r?.listing?.id) === tid);
  }

  // Binary-search the largest `min` price filter at which the listing still appears
  // (lower bound) and the smallest `max` at which it still appears (upper bound).
  async function inferBandViaFilters({ targetId, locality, setStatus }) {
    const wide = await probeSearch({ min: RANGE_LOW, max: RANGE_HIGH, locality });
    if (!inResults(wide, targetId)) return null;

    // Upper price = largest min where the listing is still present.
    let lo = snapFloor(RANGE_LOW);
    let hi = snapFloor(RANGE_HIGH) + STEP;
    while (lo + STEP < hi) {
      const mid = snapFloor((lo + hi) / 2);
      setStatus(`Probing ≥ ${mid.toLocaleString()}…`);
      if (inResults(await probeSearch({ min: mid, max: RANGE_HIGH, locality }), targetId)) lo = mid;
      else hi = mid;
    }
    const upper = lo;

    // Lower price = smallest max where the listing is still present.
    let lo2 = snapFloor(RANGE_LOW) - STEP;
    let hi2 = upper;
    while (lo2 + STEP < hi2) {
      const mid = snapFloor((lo2 + hi2) / 2);
      setStatus(`Probing ≤ ${mid.toLocaleString()}…`);
      if (inResults(await probeSearch({ min: RANGE_LOW, max: mid, locality }), targetId)) hi2 = mid;
      else lo2 = mid;
    }
    const lower = hi2;

    return { gte: Math.min(lower, upper), lte: Math.max(lower, upper), atOrAbove: upper >= RANGE_HIGH };
  }

  async function fetchSearchBand({ targetId, divisionSlug, streetSlug, setStatus }) {
    // 1. Fast path: read the indexed band straight from the suburb results page.
    setStatus("Reading suburb search index…");
    const fromPage = await readSuburbBand({ targetId, divisionSlug });
    if (fromPage) return { ok: true, source: fromPage.segment, label: fromPage.label, gte: fromPage.gte, lte: fromPage.lte };

    // 2. Hidden listings (Auction / By negotiation): binary-search the filter API.
    //    Prefer a STREET locality (tiny result set); fall back to the suburb DIVISION.
    const localities = [];
    if (streetSlug) localities.push({ type: "STREET", slug: streetSlug });
    if (divisionSlug) localities.push({ type: "DIVISION", slug: divisionSlug });
    if (!localities.length) return { ok: false, message: "Couldn't determine locality" };

    let lastErr = null;
    for (const locality of localities) {
      setStatus(`Probing filter index (${locality.type.toLowerCase()})…`);
      try {
        const band = await inferBandViaFilters({ targetId, locality, setStatus });
        if (band) return { ok: true, source: "filter", ...band };
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return { ok: false, message: "Listing not found in search index" };
  }

  // ---- Rendering ----

  function getAppProps() {
    const root = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    return root[APP_PROPS_KEY];
  }

  function isCurrentRun(el, runId) {
    return runId === currentRunId && el.isConnected;
  }

  function makeStatusSetter(el, status, runId) {
    return (message) => {
      if (isCurrentRun(el, runId)) status.textContent = message;
    };
  }

  function fmtListingDate(value) {
    return value ? `${String(value).slice(0, 10)} (${daysFrom(value)} days)` : "N/A";
  }

  function fmtRangeGrowth(lastSold, lower, upper, currDate = Date.now()) {
    if (!lastSold) return "";
    if (lower === upper) {
      return fmtGrowth(calcAnnualGrowth(lastSold.price, lastSold.date, lower, currDate));
    }

    const pctLower = calcAnnualGrowth(lastSold.price, lastSold.date, lower, currDate);
    const pctUpper = calcAnnualGrowth(lastSold.price, lastSold.date, upper, currDate);
    if (pctLower === null || pctUpper === null) return "";

    const signL = pctLower >= 0 ? "+" : "";
    const signU = pctUpper >= 0 ? "+" : "";
    return ` (${signL}${pctLower.toFixed(1)}%, ${signU}${pctUpper.toFixed(1)}%/yr)`;
  }

  function fmtPriceRangeWithGrowth({ lower, upper, lastSold, upperSuffix = "" }) {
    const growthStr = fmtRangeGrowth(lastSold, lower, upper);
    if (lower === upper) return `${fmtMoney(lower)}${growthStr}`;
    return `${fmtMoney(lower)} – ${fmtMoney(upper)}${upperSuffix}${growthStr}`;
  }

  function fmtListingPrice(listing, history) {
    if (typeof listing.priceLower !== "number" || typeof listing.priceUpper !== "number") {
      return listing.price ?? "N/A";
    }
    return fmtPriceRangeWithGrowth({
      lower: listing.priceLower,
      upper: listing.priceUpper,
      lastSold: getLastSoldEntry(history),
    });
  }

  function fmtPropertyDate(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Date(parsed).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  }

  function renderPropertyEstimate(data) {
    const { avm, rental } = data;
    let html = "";

    if (avm) {
      const conf = avm.confidence ? ` (${avm.confidence})` : "";
      const range = avm.low && avm.high ? `<br><span class="small">Range: ${fmtMoney(avm.low)} – ${fmtMoney(avm.high)}</span>` : "";
      const date = avm.date ? `<br><span class="small">Updated: ${fmtPropertyDate(avm.date)}</span>` : "";
      html += `<div><strong>Value:</strong> ${fmtMoney(avm.value)}${conf}${range}${date}</div>`;
    }

    if (rental) {
      const conf = rental.confidence ? ` (${rental.confidence})` : "";
      const range = rental.min && rental.max ? `<br><span class="small">Range: $${rental.min} – $${rental.max}/wk</span>` : "";
      const date = rental.date ? `<br><span class="small">Updated: ${rental.date}</span>` : "";
      html += `<div style="margin-top:4px"><strong>Rental:</strong> $${rental.value}/wk${conf}${range}${date}</div>`;
    }

    return html || "No data";
  }

  function renderHistory(history) {
    if (!Array.isArray(history) || !history.length) {
      return `<div class="k">Price History:</div><div>Not found</div>`;
    }

    // Build list of sold entries with prices for comparison
    const soldEntries = history.map((h, i) => ({ index: i, price: h.transfer?.price, date: h.date })).filter((e) => typeof e.price === "number");

    const items = history
      .map((h, i) => {
        const t = h.transfer || {};
        const label = escapeHtml(t.label ?? "Event");
        const currPrice = t.price;
        const currDate = h.date;

        // Find previous sold entry (earlier in array = more recent, so look for higher index)
        let growthStr = "";
        if (typeof currPrice === "number") {
          const prevEntry = soldEntries.find((e) => e.index > i && typeof e.price === "number");
          if (prevEntry) {
            const pct = calcAnnualGrowth(prevEntry.price, prevEntry.date, currPrice, currDate);
            growthStr = fmtGrowth(pct);
          }
        }

        const contractElapsed = fmtElapsed(t.contractDate);
        const transferElapsed = fmtElapsed(t.transferDate);

        return `
        <div style="margin-top:4px">
          • ${label}
          <div style="margin-left:10px">
            Sold Price: ${typeof currPrice === "number" ? fmtMoney(currPrice) + growthStr : "N/A"}<br>
            Contract: ${escapeHtml(t.contractDate?.slice(0, 10) ?? "N/A")}${contractElapsed}<br>
            Transfer: ${escapeHtml(t.transferDate?.slice(0, 10) ?? "N/A")}${transferElapsed}
          </div>
        </div>
      `;
      })
      .join("");
    return `<div class="k">Price History:</div>${items}`;
  }

  function getLastSoldEntry(history) {
    if (!Array.isArray(history)) return null;
    for (const h of history) {
      const t = h.transfer || {};
      if (typeof t.price === "number" && h.date) {
        return { price: t.price, date: h.date };
      }
    }
    return null;
  }

  function renderListingBody(app) {
    const listing = app?.body?.property?.listing;
    const history = app?.body?.property?.history || [];

    return `
      <div><span class="k">Date Posted:</span> ${escapeHtml(fmtListingDate(listing.publicVisibleDate))}</div>
      <div><span class="k">Relisted Date:</span> ${escapeHtml(fmtListingDate(listing.relistedDate))}</div>
      <div><span class="k">Page Views:</span> ${escapeHtml(String(listing.pageViews ?? "N/A"))}</div>
      <div><span class="k">Price:</span> ${escapeHtml(String(fmtListingPrice(listing, history)))}</div>
      <div style="margin-top:6px">${renderHistory(history)}</div>
      <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px">
        <div class="k">Search Price (indexed band):</div>
        <div id="ahx_fp_result" class="mono">Not run</div>
        <button id="ahx_fp_btn">Look up search band</button>
        <div id="ahx_fp_status" class="small"></div>
      </div>
      <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px">
        <div class="k">Property.com.au Estimate: <span id="ahx_pca_link"></span></div>
        <div id="ahx_pca_result" class="mono">Not run</div>
        <button id="ahx_pca_btn">Fetch valuation</button>
        <div id="ahx_pca_status" class="small"></div>
      </div>
    `;
  }

  function bindToggle(el) {
    bindPanelToggle(el, {
      headerSelector: ".ahx-header",
      bodySelector: "#ahx_body",
      toggleSelector: "#ahx_toggle",
    });
  }

  function bindBoundary(el, { targetId, divisionSlug, streetSlug, history }) {
    const btn = el.querySelector("#ahx_fp_btn");
    const status = el.querySelector("#ahx_fp_status");
    const result = el.querySelector("#ahx_fp_result");
    if (!btn || !status || !result) return;

    btn.onclick = async () => {
      const myRunId = ++currentRunId;
      btn.disabled = true;
      result.textContent = "Looking up…";
      status.textContent = "";
      const setStatus = makeStatusSetter(el, status, myRunId);

      try {
        const out = await fetchSearchBand({ targetId, divisionSlug, streetSlug, setStatus });

        if (!isCurrentRun(el, myRunId)) return;

        if (!out.ok) {
          result.textContent = "N/A";
          status.textContent = out.message;
          btn.disabled = false;
          return;
        }

        const lastSold = getLastSoldEntry(history);
        result.textContent = fmtPriceRangeWithGrowth({
          lower: out.gte,
          upper: out.lte,
          lastSold,
          upperSuffix: out.atOrAbove ? "+" : "",
        });
        const srcLabel = out.source === "filter" ? "filter probe" : `${out.source} page`;
        status.textContent = `${srcLabel}${out.label ? ` · label "${out.label}"` : ""}`;
        // Band is fixed for the listing — keep the button disabled once resolved.
      } catch (e) {
        if (!isCurrentRun(el, myRunId)) return;
        result.textContent = "N/A";
        status.textContent = `Error: ${String(e)}`;
        btn.disabled = false;
      }
    };
  }

  function bindPropertyComAu(el, app) {
    const btn = el.querySelector("#ahx_pca_btn");
    const status = el.querySelector("#ahx_pca_status");
    const result = el.querySelector("#ahx_pca_result");
    if (!btn || !status || !result) return;

    btn.onclick = async () => {
      const myRunId = ++currentRunId;
      btn.disabled = true;
      result.innerHTML = "Fetching…";
      status.textContent = "";
      const setStatus = makeStatusSetter(el, status, myRunId);

      try {
        const out = await fetchPropertyData(app, setStatus);

        if (!isCurrentRun(el, myRunId)) return;

        if (!out.ok) {
          result.textContent = "N/A";
          status.innerHTML = out.message;
        } else {
          result.innerHTML = renderPropertyEstimate(out.data);
          status.textContent = "";
          const link = el.querySelector("#ahx_pca_link");
          if (link) {
            link.innerHTML = `<a href="${escapeHtml(out.url)}" target="_blank" style="color:#0066cc">(link)</a>`;
          }
        }
      } catch (e) {
        if (!isCurrentRun(el, myRunId)) return;
        result.textContent = "N/A";
        status.textContent = `Error: ${String(e)}`;
      } finally {
        if (isCurrentRun(el, myRunId)) {
          btn.disabled = false;
        }
      }
    };
  }

  function renderListingOverlay() {
    const el = ensurePanel();
    const app = getAppProps();

    if (!app) {
      el.innerHTML = panelTemplate(`<div class="k">Waiting for data…</div>`);
      bindToggle(el);
      lastListingId = null;
      return;
    }

    const listing = app?.body?.property?.listing;
    if (!listing) {
      el.innerHTML = panelTemplate(`<div class="k">Listing not ready</div>`);
      bindToggle(el);
      lastListingId = null;
      return;
    }

    const targetId = getTargetListingId(app);

    // Short-circuit if same listing already rendered
    if (targetId && targetId === lastListingId && el.querySelector("#ahx_fp_btn")) {
      return;
    }
    lastListingId = targetId;

    const divisionSlug = getDivisionSlug(app);
    const streetSlug = getStreetSlug(app);
    const history = app?.body?.property?.history || [];

    el.innerHTML = panelTemplate(renderListingBody(app));
    bindToggle(el);
    bindBoundary(el, { targetId, divisionSlug, streetSlug, history });
    bindPropertyComAu(el, app);
  }

  // ---- Initialization ----

  function handleRoute() {
    const routeChanged = location.href !== lastUrl;
    if (routeChanged) {
      lastUrl = location.href;
      lastListingId = null;
    }

    if (isSearchPage()) {
      removeDetailPanel();
      lastListingId = null;
      startSuburbBlocker();
      return;
    }

    removeSuburbPanel();

    renderListingOverlay();
  }

  setInterval(handleRoute, ROUTE_POLL_MS);
  hookPanelPlacement();
  handleRoute();
  window.addEventListener("load", handleRoute);
  document.addEventListener("readystatechange", () => {
    if (document.readyState !== "interactive" && document.readyState !== "complete") return;
    handleRoute();
  });
})();
