// ==UserScript==
// @name         Gmail Payslip Downloader (open email, top right button)
// @namespace    https://tampermonkey.net/
// @version      0.5
// @description  Open each payslip email, download first attachment as dated PDF. Button in top-right tools bar.
// @author       You
// @match        https://mail.google.com/*
// @run-at       document-idle
// @grant        GM_download
// ==/UserScript==

(function () {
  "use strict";

  const BUTTON_ID = "tm-payslip-download-btn";
  const DEBUG = true;

  const BETWEEN_DOWNLOAD_DELAY = 500;
  const OPEN_EMAIL_TIMEOUT = 15000;
  const BACK_TO_LIST_TIMEOUT = 15000;

  function log(...args) {
    console.log("[PayslipDownloader]", ...args);
  }

  function delay(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  function waitFor(fn, timeoutMs = 10000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        try {
          const result = fn();
          if (result) {
            clearInterval(timer);
            resolve(result);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error("waitFor timeout"));
          }
        } catch (e) {
          clearInterval(timer);
          reject(e);
        }
      }, intervalMs);
    });
  }

  const MONTH_MAP = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // Parse a date from the subject and return yyyy-MM-dd
  function parseDateFromSubject(subject) {
    if (!subject) return null;
    subject = subject.replace(/\u00A0/g, " ");

    // 1) dd/MM/yyyy or dd-MM-yyyy
    let m = subject.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (m) {
      let [, d, mo, y] = m;
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }

    // 2) yyyy-MM-dd
    m = subject.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
      let [, y, mo, d] = m;
      return `${y}-${pad2(mo)}-${pad2(d)}`;
    }

    // 3) dd/MM/yy or dd-MM-yy (e.g. 16/11/25)
    m = subject.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})(?!\d)/);
    if (m) {
      let [, d, mo, yy] = m;
      let yearNum = parseInt(yy, 10);
      let fullYear = yearNum >= 80 ? 1900 + yearNum : 2000 + yearNum;
      return `${fullYear}-${pad2(mo)}-${pad2(d)}`;
    }

    // 4) "16 Nov 2025"
    m = subject.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
    if (m) {
      let [, d, monthName, y] = m;
      const key = monthName.toLowerCase();
      const mo = MONTH_MAP[key];
      if (mo) {
        return `${y}-${mo}-${pad2(d)}`;
      }
    }

    return null;
  }

  function getEmailRows() {
    return Array.from(document.querySelectorAll("tr.zA"));
  }

  // Attachment URL from the opened email view
  function findAttachmentUrlInMessage() {
    // Look inside the attachments bar (div.aQH)
    const containers = Array.from(document.querySelectorAll('div.aQH, div.aQw, div[data-tooltip*="attachment"], span[data-tooltip*="attachment"]'));

    for (const c of containers) {
      // 1) classic <a> links
      let a = c.querySelector('a[href*="view=att"], a[href*="disp=safe"], a[href*="attid="]');
      if (a) {
        let url = a.href || a.getAttribute("href");
        if (url && !url.startsWith("http")) url = location.origin + url;
        if (DEBUG) log("Message: found attachment link <a>", url);
        return url;
      }

      // 2) download_url attribute
      let dlEl = c.querySelector("[download_url]");
      if (dlEl) {
        const dl = dlEl.getAttribute("download_url"); // mime:filename:url
        if (dl) {
          const parts = dl.split(":");
          const url = parts[parts.length - 1];
          if (DEBUG) log("Message: found download_url", dl);
          if (url) return url;
        }
      }
    }

    // Global fallback (just in case)
    let anyLink = document.querySelector('a[href*="view=att"], a[href*="disp=safe"], a[href*="attid="], [download_url]');
    if (anyLink) {
      let url = anyLink.getAttribute("download_url") || anyLink.href || anyLink.getAttribute("href");
      if (url && !url.startsWith("http")) url = location.origin + url;
      if (DEBUG) log("Message: found global attachment link", url);
      return url;
    }

    if (DEBUG) log("Message: no attachment URL found");
    return null;
  }

  function downloadAttachment(url, filename) {
    return new Promise((resolve, reject) => {
      log("Downloading", filename, "from", url);
      GM_download({
        url,
        name: filename,
        onload: function () {
          log("Download completed:", filename);
          resolve();
        },
        ontimeout: function () {
          log("Download timeout:", filename);
          reject(new Error("Download timeout"));
        },
        onerror: function (err) {
          log("Download error:", err);
          reject(err);
        },
      });
    });
  }

  async function openRow(row, rowIndex) {
    // click the subject cell or the whole row
    const subjectLink = row.querySelector(".bog") || row.querySelector("span.bog") || row.querySelector("td");

    (subjectLink || row).click();

    if (DEBUG) log(`Row ${rowIndex}: clicked, waiting for message view`);

    // wait for subject header in message view
    await waitFor(() => document.querySelector("h2.hP"), OPEN_EMAIL_TIMEOUT);
  }

  async function goBackToList() {
    // easiest: history.back(), then wait for list rows to reappear
    history.back();
    await waitFor(() => document.querySelector("tr.zA"), BACK_TO_LIST_TIMEOUT);
  }

  async function mainDownloadFlow(btn) {
    const initialRows = getEmailRows();
    if (!initialRows.length) {
      alert("No email rows found. Make sure you are in list view and have filtered payroll emails.");
      return;
    }

    const total = initialRows.length;
    if (!confirm(`Found ${total} email row(s) on this page. Open each email, download first attachment as payslip?`)) {
      return;
    }

    let attempted = 0;

    for (let i = 0; i < total; i++) {
      // Always re-query rows after coming back, because Gmail re-renders the list
      const rowsNow = getEmailRows();
      const row = rowsNow[i];
      const rowIndex = i + 1;

      if (!row) {
        if (DEBUG) log(`Row ${rowIndex}: no row found on re-query, skipping`);
        continue;
      }

      row.scrollIntoView({ behavior: "smooth", block: "center" });

      const subjectEl = row.querySelector(".bog") || row.querySelector("span.bog");
      const subject = subjectEl ? subjectEl.textContent.trim() : "";

      if (DEBUG) log(`Row ${rowIndex}: subject =`, subject);

      if (!subject) {
        if (DEBUG) log(`Row ${rowIndex}: no subject text, skipping`);
        continue;
      }

      const dateIso = parseDateFromSubject(subject);
      if (!dateIso) {
        if (DEBUG) log(`Row ${rowIndex}: could not parse date, skipping`);
        continue;
      }
      const filename = `${dateIso} payslip.pdf`;

      try {
        await openRow(row, rowIndex);

        // message view: find attachment
        const url = findAttachmentUrlInMessage();
        if (!url) {
          if (DEBUG) log(`Row ${rowIndex}: opened message but no attachment found, skipping`);
        } else {
          attempted++;
          btn.textContent = `Download Payslips (${attempted}/${total})`;
          await downloadAttachment(url, filename);
        }
      } catch (e) {
        console.error(`Row ${rowIndex}: error while opening/downloading`, e);
      }

      // go back to list for next iteration
      try {
        await goBackToList();
      } catch (e) {
        console.error("Error going back to list:", e);
        alert("Stopped because Gmail did not return to the list view. You may need to refresh the page.");
        break;
      }

      await delay(BETWEEN_DOWNLOAD_DELAY);
    }

    btn.textContent = "Download Payslips";
    alert(`Done.\nRows processed: ${total}\nRows with date + attachment attempted: ${attempted}`);
  }

  // ---------- UI: button in top-right tools bar ----------

  function findTopRightToolsContainer() {
    const geminiBtn = document.querySelector('button[aria-label="Try Gemini"]');
    if (geminiBtn) {
      const container = geminiBtn.closest("div.gb_v");
      if (container) return container;
    }
    const fallback = document.querySelector("div.gb_v.gb_re.bGJ");
    if (fallback) return fallback;
    return null;
  }

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const container = findTopRightToolsContainer();
    if (!container) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.textContent = "Download Payslips";
    btn.title = "Download payslip PDFs from this page";
    btn.setAttribute("aria-label", "Download Payslips");

    // Styling similar to top-right tools
    btn.style.marginRight = "8px";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "999px";
    btn.style.border = "1px solid #dadce0";
    btn.style.background = "#fff";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "12px";
    btn.style.fontFamily = "system-ui, sans-serif";
    btn.style.height = "32px";
    btn.style.alignSelf = "center";

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = "Preparing...";
      try {
        await mainDownloadFlow(btn);
      } catch (e) {
        console.error(e);
        alert("Error while downloading payslips. Check console for details.");
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });

    container.insertBefore(btn, container.firstChild);
    log("Payslip button inserted in top-right tools area");
  }

  function setupToolbarObserver() {
    const observer = new MutationObserver(() => {
      insertButton();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    insertButton();
  }

  setupToolbarObserver();
})();
