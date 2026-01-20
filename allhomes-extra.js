// ==UserScript==
// @name         Allhomes Extra (stable overlay)
// @namespace    ahx
// @version      0.12.0
// @match        https://www.allhomes.com.au/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      suggest.realestate.com.au
// @connect      www.property.com.au
// ==/UserScript==

(function () {
  "use strict";

  if (location.pathname.startsWith("/sale/search")) return;

  const PANEL_ID = "ahx_panel_stable";
  const SEARCH_ENDPOINT = "https://www.allhomes.com.au/wsvc/search/sale-residential";
  const RANGE_LOW = 500000;
  const RANGE_HIGH = 1500000;
  const STEP = 10000;

  // Pre-computed formatted strings
  const RANGE_LOW_STR = RANGE_LOW.toLocaleString();
  const RANGE_HIGH_STR = RANGE_HIGH.toLocaleString();

  // State tracking
  let lastUrl = location.href;
  let lastListingId = null;
  let currentRunId = 0;

  // ---- Utilities ----

  function escapeHtml(str) {
    if (typeof str !== "string") return str;
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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

  function snapFloor(x) {
    return Math.floor(x / STEP) * STEP;
  }

  function randomDelay(min = 200, max = 350) {
    return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
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
        padding:8px 10px;border-bottom:1px solid rgba(0,0,0,.08);font-weight:600;
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
      <div class="ahx-header"><div>Allhomes Extra</div><div class="ahx-toggle" id="ahx_toggle">–</div></div>
      <div class="ahx-body" id="ahx_body">${bodyHtml}</div>
    `;
  }

  // ---- Data Extraction ----

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
    if (parts[0] === "unit" || parts[0] === "level") {
      let i = 1;
      while (i < parts.length && /^\d+$/.test(parts[i])) i++;
      if (i < parts.length && /^\d+$/.test(parts[i])) i++;
      return parts.slice(i).join("-");
    }
    return (/^\d+$/.test(parts[0]) ? parts.slice(1) : parts).join("-");
  }

  function getStreetLocalitySlug(app) {
    return findStreetSlugInObject(app?.body?.property) || getStreetSlugFallbackFromPathname();
  }

  function getTargetListingId(app) {
    const id = app?.body?.property?.listing?.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  }

  // ---- Search API ----

  async function postSearch({ min, max, streetSlug }, retryCount = 0) {
    await randomDelay();

    const payload = {
      sort: { criteria: "AUCTION", order: "ASC" },
      page: 1,
      pageSize: 50,
      results: { type: "LIST" },
      filters: {
        price: { min, max },
        localities: [{ type: "STREET", slug: streetSlug }],
        propertyStatus: ["FOR_SALE", "UNDER_OFFER", "SOLD"],
      },
    };
    const res = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if ((res.status === 429 || res.status === 503) && retryCount < 1) {
      await randomDelay(1000, 2000);
      return postSearch({ min, max, streetSlug }, retryCount + 1);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function containsTarget(searchJson, targetId) {
    const tid = String(targetId);
    const arr = searchJson?.searchResults;
    return Array.isArray(arr) && arr.some((r) => String(r?.listing?.id) === tid);
  }

  // ---- Boundary Search (binary search for price range) ----

  async function findUpperByMin({ targetId, streetSlug, setStatus, wideJson }) {
    if (!containsTarget(wideJson, targetId)) return { ok: false, message: "Target not found (slug mismatch?)" };

    // Binary search: find largest min where listing appears
    // lo = present side (confirmed by wideJson), hi = absent side
    let lo = snapFloor(RANGE_LOW);
    let hi = snapFloor(RANGE_HIGH) + STEP;

    while (lo + STEP < hi) {
      const mid = snapFloor((lo + hi) / 2);
      setStatus(`(Upper) min=${mid.toLocaleString()}…`);
      const j = await postSearch({ min: mid, max: RANGE_HIGH, streetSlug });
      if (containsTarget(j, targetId)) lo = mid;
      else hi = mid;
    }

    // lo is the largest min where listing appears (= upper price at 10k precision)
    const atUpperBound = lo >= RANGE_HIGH;
    return {
      ok: true,
      presentAt: lo,
      absentAt: atUpperBound ? null : hi,
      evidence: atUpperBound ? `present@${lo.toLocaleString()} (at or above upper bound)` : `present@${lo.toLocaleString()} absent@${hi.toLocaleString()}`,
    };
  }

  async function findLowerByMax({ targetId, streetSlug, setStatus, wideJson, upperBound }) {
    if (!containsTarget(wideJson, targetId)) return { ok: false, message: "Target not found (slug mismatch?)" };

    // Binary search: find smallest max where listing appears
    // lo = absent side, hi = present side (confirmed by wideJson)
    let lo = snapFloor(RANGE_LOW) - STEP;
    let hi = snapFloor(upperBound);

    while (lo + STEP < hi) {
      const mid = snapFloor((lo + hi) / 2);
      setStatus(`(Lower) max=${mid.toLocaleString()}…`);
      const j = await postSearch({ min: RANGE_LOW, max: mid, streetSlug });
      if (containsTarget(j, targetId)) hi = mid;
      else lo = mid;
    }

    // hi is the smallest max where listing appears
    const atLowerBound = hi <= RANGE_LOW;
    return {
      ok: true,
      presentAt: hi,
      absentAt: atLowerBound ? null : lo,
      evidence: atLowerBound ? `present@${hi.toLocaleString()} (at or below lower bound)` : `absent@${lo.toLocaleString()} present@${hi.toLocaleString()}`,
    };
  }

  async function runBoth({ targetId, streetSlug, setStatus }) {
    // Single wide check for both searches (de-duplicated)
    setStatus(`Checking presence in ${RANGE_LOW_STR}–${RANGE_HIGH_STR}…`);
    const wideJson = await postSearch({ min: RANGE_LOW, max: RANGE_HIGH, streetSlug });

    // Step 1: Find lower bound first (smallest max where listing appears)
    const lower = await findLowerByMax({ targetId, streetSlug, setStatus, wideJson, upperBound: RANGE_HIGH });
    if (!lower.ok) return { ok: false, message: lower.message };

    // Step 2: min+1 probe - check if price extends above lower bound
    setStatus(`(Probe) min=${lower.presentAt + 1}…`);
    const minProbeJson = await postSearch({ min: lower.presentAt + 1, max: RANGE_HIGH, streetSlug });

    if (!containsTarget(minProbeJson, targetId)) {
      // Price does not extend above lower.presentAt
      // Now check if price is exactly lower.presentAt or somewhere in (lower-STEP, lower)
      setStatus(`(Probe) max=${lower.presentAt - 1}…`);
      const maxProbeJson = await postSearch({ min: RANGE_LOW, max: lower.presentAt - 1, streetSlug });

      if (!containsTarget(maxProbeJson, targetId)) {
        // Price is exactly lower.presentAt (single number)
        return {
          ok: true,
          lowerMaxPresent: lower.presentAt,
          upperMinPresent: lower.presentAt,
          evidence: {
            lower: lower.evidence,
            upper: `exact@${lower.presentAt.toLocaleString()} (max-1 probe: absent)`,
          },
        };
      } else {
        // Price is in range (lower-STEP, lower), show as 10k range
        return {
          ok: true,
          lowerMaxPresent: lower.absentAt ?? lower.presentAt - STEP,
          upperMinPresent: lower.presentAt,
          evidence: {
            lower: lower.evidence,
            upper: `range (max-1 probe: present@${(lower.presentAt - 1).toLocaleString()})`,
          },
        };
      }
    }

    // Step 3: Price is a range, find upper bound (narrow search using lower bound)
    const upper = await findUpperByMin({ targetId, streetSlug, setStatus, wideJson });
    if (!upper.ok) return { ok: false, message: upper.message };

    // Step 4: min+1 probe on upper to check if upper is exact 10k-aligned
    setStatus(`(Probe) min=${upper.presentAt + 1}…`);
    const upperProbeJson = await postSearch({ min: upper.presentAt + 1, max: RANGE_HIGH, streetSlug });

    let finalUpper = upper.absentAt ?? upper.presentAt + STEP;
    let upperEvidence = upper.evidence;

    if (!containsTarget(upperProbeJson, targetId)) {
      // Upper is exactly upper.presentAt (10k-aligned)
      finalUpper = upper.presentAt;
      upperEvidence = `exact@${upper.presentAt.toLocaleString()} (min+1 probe: absent)`;
    }

    return {
      ok: true,
      lowerMaxPresent: lower.presentAt,
      upperMinPresent: finalUpper,
      evidence: { lower: lower.evidence, upper: upperEvidence },
    };
  }

  // ---- Rendering ----

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

    const datePostedVal = listing.publicVisibleDate;
    const relistedDateVal = listing.relistedDate;

    const datePosted = datePostedVal ? `${String(datePostedVal).slice(0, 10)} (${daysFrom(datePostedVal)} days)` : "N/A";
    const relistedDate = relistedDateVal ? `${String(relistedDateVal).slice(0, 10)} (${daysFrom(relistedDateVal)} days)` : "N/A";

    const pageViews = listing.pageViews ?? "N/A";

    let price = listing.price ?? "N/A";
    const lastSold = getLastSoldEntry(history);
    if (typeof listing.priceLower === "number" && typeof listing.priceUpper === "number") {
      if (listing.priceLower === listing.priceUpper) {
        let growthStr = "";
        if (lastSold) {
          const pct = calcAnnualGrowth(lastSold.price, lastSold.date, listing.priceLower, Date.now());
          growthStr = fmtGrowth(pct);
        }
        price = `$${listing.priceLower.toLocaleString()}${growthStr}`;
      } else {
        let growthStr = "";
        if (lastSold) {
          const pctLower = calcAnnualGrowth(lastSold.price, lastSold.date, listing.priceLower, Date.now());
          const pctUpper = calcAnnualGrowth(lastSold.price, lastSold.date, listing.priceUpper, Date.now());
          if (pctLower !== null && pctUpper !== null) {
            const signL = pctLower >= 0 ? "+" : "";
            const signU = pctUpper >= 0 ? "+" : "";
            growthStr = ` (${signL}${pctLower.toFixed(1)}%, ${signU}${pctUpper.toFixed(1)}%/yr)`;
          }
        }
        price = `$${listing.priceLower.toLocaleString()} – $${listing.priceUpper.toLocaleString()}${growthStr}`;
      }
    }

    return `
      <div><span class="k">Date Posted:</span> ${escapeHtml(datePosted)}</div>
      <div><span class="k">Relisted Date:</span> ${escapeHtml(relistedDate)}</div>
      <div><span class="k">Page Views:</span> ${escapeHtml(String(pageViews))}</div>
      <div><span class="k">Price:</span> ${escapeHtml(String(price))}</div>
      <div style="margin-top:6px">${renderHistory(history)}</div>
      <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px">
        <div class="k">Filter Price (inferred):</div>
        <div id="ahx_fp_result" class="mono">Not run</div>
        <button id="ahx_fp_btn">Run boundary test (both)</button>
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
    const toggle = el.querySelector("#ahx_toggle");
    const body = el.querySelector("#ahx_body");
    if (!toggle || !body) return;
    toggle.onclick = () => {
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "–" : "+";
    };
  }

  function bindBoundary(el, { targetId, streetSlug, history }) {
    const btn = el.querySelector("#ahx_fp_btn");
    const status = el.querySelector("#ahx_fp_status");
    const result = el.querySelector("#ahx_fp_result");
    if (!btn || !status || !result) return;

    btn.onclick = async () => {
      const myRunId = ++currentRunId;
      btn.disabled = true;
      result.textContent = "Running…";
      status.textContent = "";

      const setStatus = (s) => {
        if (myRunId !== currentRunId || !el.isConnected) return;
        status.textContent = s;
      };

      try {
        const out = await runBoth({ targetId, streetSlug, setStatus });

        // Guard against stale updates
        if (myRunId !== currentRunId || !el.isConnected) return;

        if (!out.ok) {
          result.textContent = "N/A";
          status.textContent = out.message;
        } else {
          // Calculate growth compared to last sold price
          const lastSold = getLastSoldEntry(history);

          if (out.lowerMaxPresent === out.upperMinPresent) {
            // Exact price locked
            let growthStr = "";
            if (lastSold) {
              const pct = calcAnnualGrowth(lastSold.price, lastSold.date, out.lowerMaxPresent, Date.now());
              growthStr = fmtGrowth(pct);
            }
            result.textContent = fmtMoney(out.lowerMaxPresent) + growthStr;
            status.textContent = `locked: ${out.evidence.upper}`;
          } else {
            // Range - show growth for both bounds
            let growthStr = "";
            if (lastSold) {
              const pctLower = calcAnnualGrowth(lastSold.price, lastSold.date, out.lowerMaxPresent, Date.now());
              const pctUpper = calcAnnualGrowth(lastSold.price, lastSold.date, out.upperMinPresent, Date.now());
              if (pctLower !== null && pctUpper !== null) {
                const signL = pctLower >= 0 ? "+" : "";
                const signU = pctUpper >= 0 ? "+" : "";
                growthStr = ` (${signL}${pctLower.toFixed(1)}%, ${signU}${pctUpper.toFixed(1)}%/yr)`;
              }
            }
            result.textContent = `${fmtMoney(out.lowerMaxPresent)} – ${fmtMoney(out.upperMinPresent)}${growthStr}`;
            status.textContent = `lower: ${out.evidence.lower} | upper: ${out.evidence.upper}`;
          }
        }
      } catch (e) {
        if (myRunId !== currentRunId || !el.isConnected) return;
        result.textContent = "N/A";
        status.textContent = `Error: ${String(e)}`;
      } finally {
        if (myRunId === currentRunId && el.isConnected) {
          btn.disabled = false;
        }
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

      const setStatus = (s) => {
        if (myRunId !== currentRunId || !el.isConnected) return;
        status.textContent = s;
      };

      try {
        const out = await fetchPropertyData(app, setStatus);

        if (myRunId !== currentRunId || !el.isConnected) return;

        if (!out.ok) {
          result.textContent = "N/A";
          status.innerHTML = out.message;
        } else {
          const { avm, rental } = out.data;
          let html = "";

          const fmtDate = (d) => {
            if (!d) return null;
            const parsed = Date.parse(d);
            if (!Number.isFinite(parsed)) return d;
            return new Date(parsed).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
          };

          if (avm) {
            const conf = avm.confidence ? ` (${avm.confidence})` : "";
            const range = avm.low && avm.high ? `<br><span class="small">Range: ${fmtMoney(avm.low)} – ${fmtMoney(avm.high)}</span>` : "";
            const date = avm.date ? `<br><span class="small">Updated: ${fmtDate(avm.date)}</span>` : "";
            html += `<div><strong>Value:</strong> ${fmtMoney(avm.value)}${conf}${range}${date}</div>`;
          }

          if (rental) {
            const conf = rental.confidence ? ` (${rental.confidence})` : "";
            const range = rental.min && rental.max ? `<br><span class="small">Range: $${rental.min} – $${rental.max}/wk</span>` : "";
            const date = rental.date ? `<br><span class="small">Updated: ${rental.date}</span>` : "";
            html += `<div style="margin-top:4px"><strong>Rental:</strong> $${rental.value}/wk${conf}${range}${date}</div>`;
          }

          result.innerHTML = html || "No data";
          status.textContent = "";
          const link = el.querySelector("#ahx_pca_link");
          if (link) {
            link.innerHTML = `<a href="${escapeHtml(out.url)}" target="_blank" style="color:#0066cc">(link)</a>`;
          }
        }
      } catch (e) {
        if (myRunId !== currentRunId || !el.isConnected) return;
        result.textContent = "N/A";
        status.textContent = `Error: ${String(e)}`;
      } finally {
        if (myRunId === currentRunId && el.isConnected) {
          btn.disabled = false;
        }
      }
    };
  }

  function render() {
    const el = ensurePanel();
    const app = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window)["__domain_group/APP_PROPS"];

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

    const streetSlug = getStreetLocalitySlug(app);
    const history = app?.body?.property?.history || [];

    el.innerHTML = panelTemplate(renderListingBody(app));
    bindToggle(el);
    bindBoundary(el, { targetId, streetSlug, history });
    bindPropertyComAu(el, app);
  }

  // ---- Initialization ----

  setInterval(() => {
    if (location.pathname.startsWith("/sale/search")) {
      const existing = document.getElementById(PANEL_ID);
      if (existing) existing.remove();
      lastListingId = null;
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastListingId = null;
      render();
    }
    if (!document.getElementById(PANEL_ID)) render();
  }, 500);

  render();
  window.addEventListener("load", render);
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive" || document.readyState === "complete") render();
  });
})();
