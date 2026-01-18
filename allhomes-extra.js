// ==UserScript==
// @name         Allhomes Extra (stable overlay)
// @namespace    ahx
// @version      0.8.0
// @match        https://www.allhomes.com.au/*
// @run-at       document-start
// @grant        none
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

  function snapFloor(x) {
    return Math.floor(x / STEP) * STEP;
  }

  function randomDelay(min = 200, max = 350) {
    return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
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
      return `<div class="k">priceHistory:</div><div>Not found</div>`;
    }
    const items = history
      .map((h) => {
        const t = h.transfer || {};
        const label = escapeHtml(t.label ?? "Event");
        return `
        <div style="margin-top:4px">
          • ${label} (${escapeHtml(h.date?.slice(0, 10) ?? "N/A")})
          <div style="margin-left:10px">
            soldPrice: ${typeof t.price === "number" ? fmtMoney(t.price) : "N/A"}<br>
            contract: ${escapeHtml(t.contractDate?.slice(0, 10) ?? "N/A")}<br>
            transfer: ${escapeHtml(t.transferDate?.slice(0, 10) ?? "N/A")}
          </div>
        </div>
      `;
      })
      .join("");
    return `<div class="k">priceHistory:</div>${items}`;
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
    if (typeof listing.priceLower === "number" && typeof listing.priceUpper === "number") {
      price = `$${listing.priceLower.toLocaleString()} – $${listing.priceUpper.toLocaleString()}`;
    }

    return `
      <div><span class="k">datePosted:</span> ${escapeHtml(datePosted)}</div>
      <div><span class="k">relistedDate:</span> ${escapeHtml(relistedDate)}</div>
      <div><span class="k">pageViews:</span> ${escapeHtml(String(pageViews))}</div>
      <div><span class="k">price:</span> ${escapeHtml(String(price))}</div>
      <div style="margin-top:6px">${renderHistory(history)}</div>
      <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px">
        <div class="k">filterPrice (inferred):</div>
        <div id="ahx_fp_result" class="mono">Not run</div>
        <button id="ahx_fp_btn">Run boundary test (both)</button>
        <div id="ahx_fp_status" class="small"></div>
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

  function bindBoundary(el, { targetId, streetSlug }) {
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
        } else if (out.lowerMaxPresent === out.upperMinPresent) {
          // Exact price locked
          result.textContent = fmtMoney(out.lowerMaxPresent);
          status.textContent = `locked: ${out.evidence.upper}`;
        } else {
          result.textContent = `${fmtMoney(out.lowerMaxPresent)} – ${fmtMoney(out.upperMinPresent)}`;
          status.textContent = `lower: ${out.evidence.lower} | upper: ${out.evidence.upper}`;
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
    const app = window["__domain_group/APP_PROPS"];

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

    el.innerHTML = panelTemplate(renderListingBody(app));
    bindToggle(el);
    bindBoundary(el, { targetId, streetSlug });
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
