// ==UserScript==
// @name         Payslip Downloader
// @version      0.1
// @description  The script to download the payslip with formatted file name.
// @author       Feier Xiao
// @match        https://mypay.management/payroll/payslip
// @icon         https://www.google.com/s2/favicons?sz=64&domain=mypay.management
// ==/UserScript==

const extractPayDate = (rowElement) => {
  const payDateElement = rowElement.querySelector('div[aria-colindex="8"] span');
  if (payDateElement) {
    return payDateElement.textContent.trim();
  }
  return null;
};

const downloadFile = (url, filename, token) => {
  const headers = new Headers();
  headers.append("Authorization", `Bearer ${token}`);

  fetch(url, { headers })
    .then((response) => response.blob())
    .then((blob) => {
      const fileUrl = URL.createObjectURL(blob);
      const element = document.createElement("a");
      element.setAttribute("href", fileUrl);
      element.setAttribute("download", filename);
      element.style.display = "none";
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
      URL.revokeObjectURL(fileUrl);
    });
};

const downloadPDFs = async (rowDataMap) => {
  const token = localStorage.getItem("token");
  const sortedRowDataMap = new Map([...rowDataMap.entries()].sort(([a], [b]) => a - b));
  let index = 1;
  for (const [rowId, payDate] of sortedRowDataMap) {
    const downloadUrl = `https://mypay.management/api/v1/pay-transaction/${rowId}/download`;
    const filename = `${index} - ${payDate}.pdf`;
    downloadFile(downloadUrl, filename, token);
    index++;
    await delay(1000);
  }
};

const extractRowData = (rowElements, rowDataMap) => {
  rowElements.forEach((rowElement, index) => {
    const rowId = rowElement.getAttribute("row-id");
    const payDate = extractPayDate(rowElement);
    if (payDate && !rowDataMap.has(rowId)) {
      rowDataMap.set(rowId, payDate);
    }
  });
};

const scrollAndCollectRowData = async () => {
  const rowDataMap = new Map();
  let rowDataMapSize = rowDataMap.size;
  const viewportElement = document.querySelector(".ag-center-cols-container");

  while (true) {
    await delay(2000);
    const rowElements = document.querySelectorAll(".ag-row");
    extractRowData(rowElements, rowDataMap);
    console.error(rowDataMapSize);
    console.error(rowDataMap.size);

    if (rowDataMapSize === rowDataMap.size) {
      break;
    }
    rowDataMapSize = rowDataMap.size;
    const lastElement = rowElements[rowElements.length - 1];
    if (lastElement) {
      lastElement.scrollIntoView();
    }
  }

  return rowDataMap;
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const work = async () => {
  await delay(3000);
  const rowDataMap = await scrollAndCollectRowData();
  downloadPDFs(rowDataMap);
};

work();
