// ==UserScript==
// @name         Realestate Extra (stable overlay)
// @namespace    rex
// @version      0.3.0
// @match        https://www.realestate.com.au/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      suggest.realestate.com.au
// @connect      www.property.com.au
// ==/UserScript==

(function () {
  "use strict";

  const PANEL_ID = "rex_panel_stable";
  const LISTING_MODULE = "resi-property_listing-experience-web";
  const PROFILE_MODULE = "resi-property_property-profile";

  // State tracking
  let lastUrl = location.href;
  let lastKey = null;

  // ---- Utilities ----

  function escapeHtml(str) {
    if (typeof str !== "string") return str;
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function fmtMoney(n) {
    return typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString()}` : "N/A";
  }

  function daysFrom(value) {
    if (!value) return null;
    const t = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function fmtElapsed(dateStr) {
    if (!dateStr) return "";
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t)) return "";
    const years = (Date.now() - t) / (365 * 24 * 60 * 60 * 1000);
    if (years < 0) return "";
    if (years < 1) return ` (${Math.round(years * 12)} mo ago)`;
    return ` (${years.toFixed(1)} yrs ago)`;
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
    return (Math.pow(ratio, 1 / years) - 1) * 100;
  }

  function fmtGrowth(pct) {
    if (pct === null || !Number.isFinite(pct)) return "";
    const sign = pct >= 0 ? "+" : "";
    return ` (${sign}${pct.toFixed(1)}%/yr)`;
  }

  // Parse "$1.3m", "$899,000", "1,270,000", "$780 per week" → number
  function parseMoney(str) {
    if (typeof str === "number") return str;
    if (!str || typeof str !== "string") return null;
    const s = str.toLowerCase().replace(/per week|per annum|\/wk|\/yr|approx\.?|from/g, "").trim();
    let m;
    if ((m = s.match(/\$?\s*([\d.]+)\s*m\b/))) return Math.round(parseFloat(m[1]) * 1e6);
    if ((m = s.match(/\$?\s*([\d.]+)\s*k\b/))) return Math.round(parseFloat(m[1]) * 1e3);
    const cleaned = s.replace(/[^\d.]/g, "");
    if (cleaned && /^\d/.test(cleaned)) {
      const n = parseFloat(cleaned);
      if (Number.isFinite(n)) return Math.round(n);
    }
    return null;
  }

  // Parse a price-guide range like "$1.3m–$1.5m" or "$899,000 - $950,000"
  function parseRange(str) {
    if (!str || typeof str !== "string") return null;
    const parts = str.split(/\s*[–—-]\s*/).filter(Boolean);
    if (parts.length >= 2) {
      const low = parseMoney(parts[0]);
      const high = parseMoney(parts[parts.length - 1]);
      if (low && high) return { low, high, mid: Math.round((low + high) / 2) };
    }
    const v = parseMoney(str);
    return v ? { low: v, high: v, mid: v } : null;
  }

  function randomDelay(min = 200, max = 350) {
    return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
  }

  // ---- Argonaut data extraction ----

  // The page hydrates and then empties window.ArgonautExchange, so the only
  // durable copy of the embedded data is the inline <script> tag itself.
  function getArgonautModule(moduleKey) {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.startsWith("window.ArgonautExchange=")) {
        const mod = parseArgonautFromHtml(t, moduleKey);
        if (mod) return mod;
      }
    }
    return null;
  }

  // Turn a listing module (live or fetched) into its GraphQL component tree.
  function treeFromListingModule(mod) {
    if (!mod || !mod.urqlClientCache) return null;
    try {
      const cache = JSON.parse(mod.urqlClientCache);
      for (const k of Object.keys(cache)) {
        const entry = cache[k];
        if (entry && typeof entry.data === "string") {
          try {
            return JSON.parse(entry.data);
          } catch (e) {
            /* try next */
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Parse the listing-page GraphQL component tree from the live document.
  function getListingTree() {
    return treeFromListingModule(getArgonautModule(LISTING_MODULE));
  }

  // Pull just the hidden price-band fields from a listing tree (live or fetched).
  function extractBand(tree) {
    const price = findByTypename(tree, "BuyPrice");
    const published = findByKey(tree, "publishedDate");
    return {
      searchRange: price && price.searchRange,
      priceDisplay: price && price.display,
      productDepth: findByKey(tree, "productDepth"),
      publishedRaw: typeof published === "string" ? published.replace(/^Date Published:\s*/i, "").trim() : null,
    };
  }

  // Parse the property-profile data object.
  function getProfileData() {
    const mod = getArgonautModule(PROFILE_MODULE);
    if (!mod || !mod.property_detail_data) return null;
    try {
      const parsed = typeof mod.property_detail_data === "string" ? JSON.parse(mod.property_detail_data) : mod.property_detail_data;
      return parsed && parsed.propertyProfile ? parsed.propertyProfile : null;
    } catch (e) {
      return null;
    }
  }

  // Generic: find first object with a given __typename.
  function findByTypename(root, typename) {
    const seen = new Set();
    function walk(x) {
      if (!x || typeof x !== "object" || seen.has(x)) return null;
      seen.add(x);
      if (x.__typename === typename) return x;
      for (const k of Object.keys(x)) {
        const hit = walk(x[k]);
        if (hit) return hit;
      }
      return null;
    }
    return walk(root);
  }

  // Generic: find first primitive value for a given key anywhere in the tree.
  function findByKey(root, key) {
    const seen = new Set();
    function walk(x) {
      if (!x || typeof x !== "object" || seen.has(x)) return undefined;
      seen.add(x);
      for (const k of Object.keys(x)) {
        const v = x[k];
        if (k === key && v !== null && typeof v !== "object") return v;
        if (v && typeof v === "object") {
          const hit = walk(v);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    }
    return walk(root);
  }

  // Find an Argonaut module's raw JSON inside arbitrary page HTML (for fetched pages).
  function parseArgonautFromHtml(html, moduleKey) {
    const marker = "window.ArgonautExchange=";
    const start = html.indexOf(marker);
    if (start < 0) return null;
    // Find the JSON object that follows; it ends right before a closing </script>.
    const after = html.slice(start + marker.length);
    const scriptEnd = after.indexOf("</script>");
    let jsonStr = (scriptEnd >= 0 ? after.slice(0, scriptEnd) : after).trim();
    jsonStr = jsonStr.replace(/;\s*$/, "");
    try {
      const outer = JSON.parse(jsonStr);
      return outer[moduleKey] || null;
    } catch (e) {
      return null;
    }
  }

  // ---- Cross-origin fetch (Tampermonkey) ----

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
              finalUrl: res.finalUrl,
              text: () => Promise.resolve(res.responseText),
              json: () => Promise.resolve(JSON.parse(res.responseText)),
            }),
          onerror: (err) => reject(new Error("Network error: " + (err && err.error ? err.error : "unknown"))),
          ontimeout: () => reject(new Error("Request timeout")),
        });
      } catch (e) {
        reject(new Error("GM_xmlhttpRequest failed: " + e.message));
      }
    });
  }

  // ---- Address resolution (shared with property.com.au + realestate lookup) ----

  async function resolveSuggestion(address) {
    const url = `https://suggest.realestate.com.au/consumer-suggest/suggestions?max=1&type=address&src=homepage&query=${encodeURIComponent(address)}`;
    const res = await gmFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const suggestion = data && data._embedded && data._embedded.suggestions && data._embedded.suggestions[0];
    if (!suggestion || !suggestion.id || !suggestion.source) return null;
    return suggestion;
  }

  function buildPropertyComAuSlug(src, id) {
    const state = (src.state || "").toLowerCase();
    const suburb = (src.suburb || "").toLowerCase().replace(/\s+/g, "-");
    const postcode = src.postcode || "";
    const street = (src.street || "").toLowerCase();
    const streetType = (src.streetType || "").toLowerCase();
    const streetNumber = (src.streetNumber || "").replace(/\//g, "-").toLowerCase();
    return `${state}/${suburb}-${postcode}/${street}-${streetType}/${streetNumber}-pid-${id}/`;
  }

  // ---- property.com.au valuation enrichment (PropTrack AVM) ----

  function parsePropertyHtml(html) {
    const result = { avm: null, rental: null };

    // Legacy structure: valueEstimatesV2.estimates.sale
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

    // Newer structure: tracking-data avm_* fields
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

    return result;
  }

  async function fetchPropertyComAuValuation(address, setStatus) {
    if (!address) return { ok: false, message: "No address" };
    setStatus("Resolving property…");
    const suggestion = await resolveSuggestion(address);
    if (!suggestion) return { ok: false, message: "Property not found" };

    setStatus("Fetching valuation…");
    const slug = buildPropertyComAuSlug(suggestion.source, suggestion.id);
    const pageUrl = `https://www.property.com.au/${slug}`;
    const res = await gmFetch(pageUrl);
    if (!res.ok) {
      const hint =
        res.status === 429 || res.status === 403 ? ' – open <a href="https://www.property.com.au" target="_blank">property.com.au</a>, then retry' : "";
      return { ok: false, message: `Failed to fetch (${res.status})${hint}` };
    }
    const html = await res.text();
    const data = parsePropertyHtml(html);
    if (!data.avm && !data.rental) return { ok: false, message: "No valuation data found" };
    return { ok: true, data, url: pageUrl };
  }

  // ---- Property history (from realestate /property/ profile page) ----

  async function fetchTimelineByLookup(address, setStatus) {
    setStatus("Resolving property…");
    const suggestion = await resolveSuggestion(address);
    if (!suggestion) return { ok: false, message: "Property not found" };

    setStatus("Fetching history…");
    const lookupUrl = `https://www.realestate.com.au/property/lookup?id=${suggestion.id}`;
    // Same-origin: a plain fetch follows the redirect to the canonical /property/ slug.
    let html;
    try {
      const res = await fetch(lookupUrl, { credentials: "include" });
      if (!res.ok) return { ok: false, message: `Lookup failed (${res.status})` };
      html = await res.text();
    } catch (e) {
      return { ok: false, message: "Lookup error: " + String(e) };
    }

    const mod = parseArgonautFromHtml(html, PROFILE_MODULE);
    if (!mod || !mod.property_detail_data) return { ok: false, message: "No profile data" };
    let pp;
    try {
      const parsed = typeof mod.property_detail_data === "string" ? JSON.parse(mod.property_detail_data) : mod.property_detail_data;
      pp = parsed.propertyProfile;
    } catch (e) {
      return { ok: false, message: "Profile parse error" };
    }
    return { ok: true, profile: pp };
  }

  // Profile pages don't embed the price band; fetch it from the linked listing.
  async function fetchListingBand(listingUrl) {
    try {
      const res = await fetch(listingUrl, { credentials: "include" });
      if (!res.ok) return null;
      const html = await res.text();
      const tree = treeFromListingModule(parseArgonautFromHtml(html, LISTING_MODULE));
      if (!tree) return null;
      return extractBand(tree);
    } catch (e) {
      return null;
    }
  }

  function getTimeline(profile) {
    const tl = profile && profile.property && profile.property.propertyTimeline;
    if (!Array.isArray(tl)) return [];
    return tl
      .map((e) => ({ date: e.date, price: parseMoney(e.price), priceDisplay: e.price, eventType: e.eventType, agency: e.agency }))
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  }

  function getLastSold(timeline) {
    return timeline.find((e) => e.eventType === "sold" && typeof e.price === "number" && e.date) || null;
  }

  // ---- Panel / Styling ----

  function ensureStyle() {
    if (document.getElementById("rex_style")) return;
    const style = document.createElement("style");
    style.id = "rex_style";
    style.textContent = `
      #${PANEL_ID}{
        position:fixed;top:90px;right:16px;z-index:2147483647;width:320px;max-height:80vh;overflow:auto;
        background:rgba(255,255,255,.98);color:#111;border:1px solid rgba(0,0,0,.15);border-radius:12px;
        box-shadow:0 8px 30px rgba(0,0,0,.18);font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
      }
      #${PANEL_ID} .rex-header{
        display:flex;justify-content:space-between;align-items:center;
        padding:8px 10px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:600;
        background:#e4002b;color:#fff;border-radius:12px 12px 0 0;
      }
      #${PANEL_ID} .rex-toggle{cursor:pointer;user-select:none;font-size:15px;line-height:1;}
      #${PANEL_ID} .rex-body{padding:10px 12px;}
      #${PANEL_ID} .k{color:rgba(0,0,0,.55)}
      #${PANEL_ID} .small{font-size:11px;color:rgba(0,0,0,.6)}
      #${PANEL_ID} .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
      #${PANEL_ID} .sec{margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px;}
      #${PANEL_ID} .big{font-size:15px;font-weight:600;}
      #${PANEL_ID} button{
        margin-top:6px;border:1px solid rgba(0,0,0,.18);background:white;
        border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px;
      }
      #${PANEL_ID} button:disabled{opacity:.6;cursor:default;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensurePanel() {
    ensureStyle();
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = PANEL_ID;
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function panelTemplate(bodyHtml) {
    return `
      <div class="rex-header"><div>Realestate Extra</div><div class="rex-toggle" id="rex_toggle">–</div></div>
      <div class="rex-body" id="rex_body">${bodyHtml}</div>
    `;
  }

  function bindToggle(el) {
    const toggle = el.querySelector("#rex_toggle");
    const body = el.querySelector("#rex_body");
    if (!toggle || !body) return;
    toggle.onclick = () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "–" : "+";
    };
  }

  // ---- Page detection ----

  function detectPage() {
    const p = location.pathname;
    if (/^\/property-.+-\d+\/?$/.test(p)) return "listing";
    if (/^\/property\/.+/.test(p)) return "profile";
    return null;
  }

  // ---- Listing-page extraction ----

  function extractListing(tree) {
    const out = {};
    const addr = findByTypename(tree, "Address");
    out.address =
      (addr && addr.display && (addr.display.fullAddress || addr.display.shortAddress)) ||
      (document.querySelector("h1") && document.querySelector("h1").textContent.trim()) ||
      null;
    out.suburb = addr && addr.suburb;
    out.state = addr && addr.state;
    out.postcode = addr && addr.postcode;

    const band = extractBand(tree);
    out.priceDisplay = band.priceDisplay;
    out.searchRange = band.searchRange;
    out.productDepth = band.productDepth;
    out.publishedRaw = band.publishedRaw;

    const views = findByTypename(tree, "Views");
    out.pageViews = views && views.display;
    out.viewsUpdated = views && views.lastUpdated && views.lastUpdated.value;
    return out;
  }

  function renderListingBody(L) {
    let priceBlock;
    const range = parseRange(L.searchRange);
    if (L.searchRange) {
      priceBlock = `<div class="big">${escapeHtml(L.searchRange)}</div>
        <div class="small">Display: ${escapeHtml(L.priceDisplay || "N/A")}${range ? ` · mid ${fmtMoney(range.mid)}` : ""}</div>`;
    } else {
      priceBlock = `<div class="big">${escapeHtml(L.priceDisplay || "N/A")}</div>`;
    }

    // Days on market from the hidden publishedDate.
    let listedLine = "N/A";
    if (L.publishedRaw) {
      const dom = daysFrom(L.publishedRaw);
      listedLine = `${escapeHtml(L.publishedRaw)}${dom != null ? ` <span class="small">(${dom} days on market)</span>` : ""}`;
    }

    const viewsLine =
      L.pageViews != null
        ? `${escapeHtml(String(L.pageViews))}${L.viewsUpdated ? ` <span class="small">(as of ${String(L.viewsUpdated).slice(0, 10)})</span>` : ""}`
        : "N/A";

    const tierLine = L.productDepth ? `<div><span class="k">Ad tier:</span> ${escapeHtml(String(L.productDepth))}</div>` : "";

    return `
      <div class="k">Price guide (hidden search band):</div>
      ${priceBlock}
      <div class="sec">
        <div><span class="k">Listed:</span> ${listedLine}</div>
        <div><span class="k">Page views:</span> ${viewsLine}</div>
        ${tierLine}
      </div>
      <div class="sec">
        <div class="k">Sold history &amp; growth:</div>
        <div id="rex_hist_result" class="mono">Loading…</div>
        <div id="rex_hist_status" class="small"></div>
      </div>
      <div class="sec">
        <div class="k">PropTrack estimate (property.com.au): <span id="rex_val_link"></span></div>
        <div id="rex_val_result" class="mono">Not run</div>
        <button id="rex_val_btn">Fetch valuation</button>
        <div id="rex_val_status" class="small"></div>
      </div>
    `;
  }

  // ---- Profile-page extraction ----

  function extractProfile(pp) {
    const out = {};
    const prop = pp.property || {};
    out.address = prop.fullAddress || (document.querySelector("h1") && document.querySelector("h1").textContent.trim()) || null;
    out.marketStatus = prop.marketStatus;
    const a = prop.attributes || {};
    out.beds = a.bedrooms && a.bedrooms.value;
    out.baths = a.bathrooms && a.bathrooms.value;
    out.cars = a.carSpaces && a.carSpaces.value;
    out.land = a.landArea && a.landArea.display;
    out.floor = a.floorArea && a.floorArea.display;
    out.propertyType = a.propertyType;
    out.timeline = getTimeline(pp);

    // Profile pages don't embed the price band, but if there's an active listing
    // we can follow it. Prefer the explicit "View listing" link.
    const links = [...document.querySelectorAll('a[href*="/property-"]')];
    const viewListing = links.find((x) => /view listing/i.test(x.textContent || ""));
    const cand = viewListing || links.find((x) => /\/property-.+-\d+\/?(?:$|\?)/.test(x.getAttribute("href") || ""));
    out.listingUrl = cand ? cand.href : null;
    return out;
  }

  function renderTimeline(timeline, currentGuide) {
    if (!timeline.length) return `<div>No history available</div>`;
    const sold = timeline.filter((e) => e.eventType === "sold" && typeof e.price === "number");
    const items = timeline
      .map((e, i) => {
        let growthStr = "";
        if (e.eventType === "sold" && typeof e.price === "number") {
          // compare to the next-older sold event
          const prev = sold.find((s) => (Date.parse(s.date) || 0) < (Date.parse(e.date) || 0));
          if (prev) growthStr = fmtGrowth(calcAnnualGrowth(prev.price, prev.date, e.price, e.date));
        }
        const label = e.eventType ? e.eventType.charAt(0).toUpperCase() + e.eventType.slice(1) : "Event";
        return `<div style="margin-top:4px">• <strong>${escapeHtml(label)}</strong> ${escapeHtml(e.priceDisplay || (e.price ? fmtMoney(e.price) : "N/A"))}${growthStr}
          <div class="small" style="margin-left:10px">${escapeHtml(String(e.date || ""))}${fmtElapsed(e.date)}${e.agency ? " · " + escapeHtml(e.agency) : ""}</div></div>`;
      })
      .join("");

    let guideBlock = "";
    const lastSold = getLastSold(timeline);
    if (lastSold && currentGuide && currentGuide.mid) {
      const pct = calcAnnualGrowth(lastSold.price, lastSold.date, currentGuide.mid, Date.now());
      guideBlock = `<div style="margin-top:6px"><span class="k">Guide vs last sold:</span> ${fmtMoney(lastSold.price)} → ${fmtMoney(currentGuide.mid)}${fmtGrowth(pct)}</div>`;
    }
    return items + guideBlock;
  }

  // ---- Bindings ----

  async function loadHistory(el, address, currentGuide) {
    const status = el.querySelector("#rex_hist_status");
    const result = el.querySelector("#rex_hist_result");
    if (!status || !result) return;
    const setStatus = (s) => {
      status.textContent = s;
    };
    try {
      const out = await fetchTimelineByLookup(address, setStatus);
      if (!out.ok) {
        result.textContent = "N/A";
        status.innerHTML = out.message;
      } else {
        const timeline = getTimeline(out.profile);
        result.innerHTML = renderTimeline(timeline, currentGuide);
        status.textContent = "";
      }
    } catch (e) {
      result.textContent = "N/A";
      status.textContent = "Error: " + String(e);
    }
  }

  function bindValuation(el, address) {
    const btn = el.querySelector("#rex_val_btn");
    const status = el.querySelector("#rex_val_status");
    const result = el.querySelector("#rex_val_result");
    if (!btn || !status || !result) return;
    btn.onclick = async () => {
      btn.disabled = true;
      result.innerHTML = "Fetching…";
      status.textContent = "";
      const setStatus = (s) => {
        status.textContent = s;
      };
      try {
        const out = await fetchPropertyComAuValuation(address, setStatus);
        if (!out.ok) {
          result.textContent = "N/A";
          status.innerHTML = out.message;
        } else {
          const { avm, rental } = out.data;
          let html = "";
          const fmtDate = (d) => {
            if (!d) return null;
            const parsed = Date.parse(d);
            return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : d;
          };
          if (avm) {
            const conf = avm.confidence ? ` (${avm.confidence})` : "";
            const rangeStr = avm.low && avm.high ? `<br><span class="small">Range: ${fmtMoney(avm.low)} – ${fmtMoney(avm.high)}</span>` : "";
            const dateStr = avm.date ? `<br><span class="small">Updated: ${fmtDate(avm.date)}</span>` : "";
            html += `<div><strong>Value:</strong> ${fmtMoney(avm.value)}${conf}${rangeStr}${dateStr}</div>`;
          }
          if (rental) {
            const conf = rental.confidence ? ` (${rental.confidence})` : "";
            html += `<div style="margin-top:4px"><strong>Rental:</strong> $${rental.value}/wk${conf}</div>`;
          }
          result.innerHTML = html || "No data";
          status.textContent = "";
          const link = el.querySelector("#rex_val_link");
          if (link) link.innerHTML = `<a href="${escapeHtml(out.url)}" target="_blank" style="color:#0066cc">(link)</a>`;
        }
      } catch (e) {
        result.textContent = "N/A";
        status.textContent = "Error: " + String(e);
      } finally {
        btn.disabled = false;
      }
    };
  }

  // ---- Render orchestration ----

  function renderListing(el) {
    const tree = getListingTree();
    if (!tree) {
      el.innerHTML = panelTemplate(`<div class="k">Waiting for data…</div>`);
      bindToggle(el);
      return false;
    }
    const L = extractListing(tree);
    el.innerHTML = panelTemplate(renderListingBody(L));
    bindToggle(el);
    loadHistory(el, L.address, parseRange(L.searchRange));
    bindValuation(el, L.address);
    return true;
  }

  async function loadProfileBand(el, listingUrl, timeline) {
    const band = el.querySelector("#rex_band");
    const sub = el.querySelector("#rex_band_sub");
    if (!band) return;
    const data = await fetchListingBand(listingUrl);
    if (!data || !data.searchRange) {
      band.textContent = (data && data.priceDisplay) || "N/A";
      if (sub) sub.textContent = "";
      return;
    }
    const range = parseRange(data.searchRange);
    band.textContent = data.searchRange;
    const bits = [];
    if (data.priceDisplay) bits.push(`Display: ${data.priceDisplay}`);
    if (range) bits.push(`mid ${fmtMoney(range.mid)}`);
    if (data.publishedRaw) {
      const dom = daysFrom(data.publishedRaw);
      bits.push(`listed ${data.publishedRaw}${dom != null ? ` (${dom}d)` : ""}`);
    }
    if (data.productDepth) bits.push(`tier ${data.productDepth}`);
    if (sub) sub.textContent = bits.join(" · ");
    // Now that we have a guide mid, re-render the timeline with growth-vs-guide.
    const histEl = el.querySelector("#rex_profile_hist");
    if (histEl && range) histEl.innerHTML = renderTimeline(timeline, range);
  }

  function renderProfile(el) {
    const pp = getProfileData();
    if (!pp) {
      el.innerHTML = panelTemplate(`<div class="k">Waiting for data…</div>`);
      bindToggle(el);
      return false;
    }
    const P = extractProfile(pp);

    const guideSection = P.listingUrl
      ? `<div class="k">Price guide (hidden search band):</div>
         <div id="rex_band" class="big">Loading…</div>
         <div id="rex_band_sub" class="small"></div>`
      : `<div class="k">Price guide:</div><div>No active listing</div>`;

    const body = `
      ${guideSection}
      <div class="sec">
        <div><span class="k">Status:</span> ${escapeHtml(String(P.marketStatus || "N/A"))}</div>
        <div><span class="k">Address:</span> ${escapeHtml(P.address || "N/A")}</div>
      </div>
      <div class="sec">
        <div class="k">Sold history &amp; growth:</div>
        <div id="rex_profile_hist" class="mono">${renderTimeline(P.timeline, null)}</div>
      </div>
      <div class="sec">
        <div class="k">PropTrack estimate (property.com.au): <span id="rex_val_link"></span></div>
        <div id="rex_val_result" class="mono">Not run</div>
        <button id="rex_val_btn">Fetch valuation</button>
        <div id="rex_val_status" class="small"></div>
      </div>
    `;
    el.innerHTML = panelTemplate(body);
    bindToggle(el);
    bindValuation(el, P.address);
    if (P.listingUrl) loadProfileBand(el, P.listingUrl, P.timeline);
    return true;
  }

  function render() {
    const page = detectPage();
    if (!page) {
      const existing = document.getElementById(PANEL_ID);
      if (existing) existing.remove();
      lastKey = null;
      return;
    }
    const el = ensurePanel();
    const key = page + ":" + location.pathname;
    // Avoid re-rendering the same page once buttons are bound.
    if (key === lastKey && el.querySelector("#rex_val_btn")) return;

    const ok = page === "listing" ? renderListing(el) : renderProfile(el);
    if (ok) lastKey = key;
  }

  // ---- Initialization ----

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastKey = null;
    }
    render();
  }, 600);

  render();
  window.addEventListener("load", render);
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive" || document.readyState === "complete") render();
  });
})();
