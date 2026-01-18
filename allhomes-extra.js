// ==UserScript==
// @name         Allhomes Extra (stable overlay)
// @namespace    ahx
// @version      0.6.5
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
    document.documentElement.appendChild(style);
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

  function daysFrom(value) {
    if (!value) return null;
    const t = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function fmtMoney(n) {
    if (typeof n !== "number") return "N/A";
    return `$${n.toLocaleString()}`;
  }

  // ---- Street locality slug (robust) ----
  function findStreetSlugInObject(root) {
    const seen = new Set();
    function walk(x) {
      if (!x || typeof x !== "object") return null;
      if (seen.has(x)) return null;
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
    const rest = /^\d+$/.test(parts[0]) ? parts.slice(1) : parts;
    return rest.join("-");
  }

  function getStreetLocalitySlug(app) {
    const root = app?.body?.property;
    return findStreetSlugInObject(root) || getStreetSlugFallbackFromPathname();
  }

  function getTargetListingId(app) {
    const id = app?.body?.property?.listing?.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  }

  async function postSearch({ min, max, streetSlug }) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  function containsTarget(searchJson, targetId) {
    const tid = String(targetId);
    const arr = searchJson?.searchResults;
    if (!Array.isArray(arr)) return false;
    return arr.some((r) => String(r?.listing?.id) === tid);
  }

  function snapFloor(x) {
    return Math.floor(x / STEP) * STEP;
  }

  // upper side: find largest min that still includes target
  async function findUpperByMin({ targetId, streetSlug, setStatus }) {
    setStatus(`(Upper) check min=${RANGE_LOW.toLocaleString()}…`);
    const lowJson = await postSearch({ min: RANGE_LOW, max: RANGE_HIGH, streetSlug });
    if (!containsTarget(lowJson, targetId)) return { ok: false, message: "Target not found (slug mismatch?)" };

    setStatus(`(Upper) check min=${RANGE_HIGH.toLocaleString()}…`);
    const highJson = await postSearch({ min: RANGE_HIGH, max: RANGE_HIGH, streetSlug });
    if (containsTarget(highJson, targetId)) return { ok: false, message: "Still present at upper bound (>1.5M?)" };

    let lo = snapFloor(RANGE_LOW);
    let hi = snapFloor(RANGE_HIGH);

    while (lo + STEP < hi) {
      const mid = snapFloor((lo + hi) / 2);
      setStatus(`(Upper) min=${mid.toLocaleString()}…`);
      const j = await postSearch({ min: mid, max: RANGE_HIGH, streetSlug });
      if (containsTarget(j, targetId)) lo = mid;
      else hi = mid;
    }

    return {
      ok: true,
      presentAt: lo,
      absentAt: lo + STEP,
      evidence: `present@${lo.toLocaleString()} absent@${(lo + STEP).toLocaleString()}`,
    };
  }

  // lower side: find smallest max that still includes target
  async function findLowerByMax({ targetId, streetSlug, setStatus }) {
    setStatus(`(Lower) check max=${RANGE_HIGH.toLocaleString()}…`);
    const wide = await postSearch({ min: RANGE_LOW, max: RANGE_HIGH, streetSlug });
    if (!containsTarget(wide, targetId)) return { ok: false, message: "Target not found (slug mismatch?)" };

    setStatus(`(Lower) check max=${RANGE_LOW.toLocaleString()}…`);
    const tooLow = await postSearch({ min: RANGE_LOW, max: RANGE_LOW, streetSlug });
    if (containsTarget(tooLow, targetId)) {
      return {
        ok: true,
        presentAt: RANGE_LOW,
        absentAt: null,
        evidence: `present@${RANGE_LOW.toLocaleString()} (range may start <= ${RANGE_LOW.toLocaleString()})`,
      };
    }

    let lo = snapFloor(RANGE_LOW); // absent side
    let hi = snapFloor(RANGE_HIGH); // present side

    while (lo + STEP < hi) {
      const mid = snapFloor((lo + hi) / 2);
      setStatus(`(Lower) max=${mid.toLocaleString()}…`);
      const j = await postSearch({ min: RANGE_LOW, max: mid, streetSlug });
      if (containsTarget(j, targetId)) hi = mid; // try smaller max
      else lo = mid; // need larger max
    }

    return {
      ok: true,
      presentAt: hi,
      absentAt: hi - STEP,
      evidence: `absent@${(hi - STEP).toLocaleString()} present@${hi.toLocaleString()}`,
    };
  }

  async function runBoth({ targetId, streetSlug, setStatus }) {
    const upper = await findUpperByMin({ targetId, streetSlug, setStatus });
    if (!upper.ok) return { ok: false, message: upper.message };

    const lower = await findLowerByMax({ targetId, streetSlug, setStatus });
    if (!lower.ok) return { ok: false, message: lower.message };

    // 10k precision display:
    // lower.presentAt is the first 10k max that includes target => lower edge ≈ lower.presentAt - STEP + ???,
    // but per your requirement we just show the tested 10k boundaries.
    return {
      ok: true,
      lowerMaxPresent: lower.presentAt, // e.g. 880,000 means max must be >= 880,000
      upperMinPresent: upper.presentAt, // e.g. 920,000 means min can be up to 920,000
      evidence: { lower: lower.evidence, upper: upper.evidence },
    };
  }

  function render() {
    const el = ensurePanel();
    const app = window["__domain_group/APP_PROPS"];

    if (!app) {
      el.innerHTML = `
        <div class="ahx-header"><div>Allhomes Extra</div><div class="ahx-toggle" id="ahx_toggle">–</div></div>
        <div class="ahx-body" id="ahx_body"><div class="k">Waiting for data…</div></div>
      `;
      bindToggle(el);
      return;
    }

    const listing = app?.body?.property?.listing;
    const history = app?.body?.property?.history || [];
    if (!listing) {
      el.innerHTML = `
        <div class="ahx-header"><div>Allhomes Extra</div><div class="ahx-toggle" id="ahx_toggle">–</div></div>
        <div class="ahx-body" id="ahx_body"><div class="k">Listing not ready</div></div>
      `;
      bindToggle(el);
      return;
    }

    const datePostedVal = listing.publicVisibleDate;
    const relistedDateVal = listing.relistedDate;

    const datePosted = datePostedVal ? `${String(datePostedVal).slice(0, 10)} (${daysFrom(datePostedVal)} days)` : "N/A";
    const relistedDate = relistedDateVal ? `${String(relistedDateVal).slice(0, 10)} (${daysFrom(relistedDateVal)} days)` : "N/A";

    const pageViews = listing.pageViews ?? "N/A";

    let price = listing.price ?? "N/A";
    if (typeof listing.priceLower === "number" && typeof listing.priceUpper === "number") {
      price = `$${listing.priceLower.toLocaleString()} – $${listing.priceUpper.toLocaleString()}`;
    }

    let historyHtml = `<div class="k">priceHistory:</div><div>Not found</div>`;
    if (Array.isArray(history) && history.length) {
      historyHtml =
        `<div class="k">priceHistory:</div>` +
        history
          .map((h) => {
            const t = h.transfer || {};
            const label = t.label ?? "Event";
            return `
            <div style="margin-top:4px">
              • ${label} (${h.date?.slice(0, 10) ?? "N/A"})
              <div style="margin-left:10px">
                soldPrice: ${typeof t.price === "number" ? fmtMoney(t.price) : "N/A"}<br>
                contract: ${t.contractDate?.slice(0, 10) ?? "N/A"}<br>
                transfer: ${t.transferDate?.slice(0, 10) ?? "N/A"}
              </div>
            </div>
          `;
          })
          .join("");
    }

    const targetId = getTargetListingId(app);
    const streetSlug = getStreetLocalitySlug(app);

    el.innerHTML = `
      <div class="ahx-header">
        <div>Allhomes Extra</div>
        <div class="ahx-toggle" id="ahx_toggle">–</div>
      </div>
      <div class="ahx-body" id="ahx_body">
        <div><span class="k">datePosted:</span> ${datePosted}</div>
        <div><span class="k">relistedDate:</span> ${relistedDate}</div>
        <div><span class="k">pageViews:</span> ${pageViews}</div>
        <div><span class="k">price:</span> ${price}</div>
        <div style="margin-top:6px">${historyHtml}</div>

        <div style="margin-top:10px;border-top:1px solid rgba(0,0,0,.08);padding-top:8px">
          <div class="k">filterPrice (inferred):</div>
          <div id="ahx_fp_result" class="mono">Not run</div>
          <button id="ahx_fp_btn">Run boundary test (both)</button>
          <div id="ahx_fp_status" class="small"></div>
        </div>
      </div>
    `;

    bindToggle(el);
    bindBoundary(el, { targetId, streetSlug });
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
      btn.disabled = true;
      result.textContent = "Running…";
      status.textContent = "";

      const setStatus = (s) => (status.textContent = s);

      try {
        const out = await runBoth({ targetId, streetSlug, setStatus });
        if (!out.ok) {
          result.textContent = "N/A";
          status.textContent = out.message;
        } else {
          // ✅ 10k precision display only
          result.textContent = `${fmtMoney(out.lowerMaxPresent)} – ${fmtMoney(out.upperMinPresent + STEP)}`;
          status.textContent = `lower: ${out.evidence.lower} | upper: ${out.evidence.upper}`;
        }
      } catch (e) {
        result.textContent = "N/A";
        status.textContent = `Error: ${String(e)}`;
      } finally {
        btn.disabled = false;
      }
    };
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.pathname.startsWith("/sale/search")) {
      const existing = document.getElementById(PANEL_ID);
      if (existing) existing.remove();
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
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
