// ==UserScript==
// @name         Payslips downloader
// @version      0.1
// @description  Download the payslips
// @author       Feier Xiao
// @match        https://my.adppayroll.com.au/webapp/payforce/paydetails/payslips
// ==/UserScript==

const employeeID = "";

const makeRequest = async (url, method, data) =>
  fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  })
    .then((response) => {
      const isJson = response.headers.get("content-type")?.includes("application/json");
      return isJson ? response.json() : response.text();
    })
    .catch((error) => console.error(error));

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const downloadPDF = (pdf, fileName) => {
  const linkSource = `data:application/pdf;base64,${pdf}`;
  const downloadLink = document.createElement("a");
  downloadLink.href = linkSource;
  downloadLink.download = fileName;
  downloadLink.click();
};

const work = async () => {
  await delay(10000);
  const rows = document.getElementsByClassName("read ng-star-inserted");
  let index = 1;
  for (const row of rows) {
    await delay(1000);
    const { id } = row;
    const date = new Date(row.getElementsByClassName("my-pay__td-date")[0].textContent).toLocaleDateString();
    const fileName = `${index} - ${date}`;
    const result = await makeRequest(`https://my.adppayroll.com.au/reports-api/payslips/organisations/S118347/employees/${employeeID}/${id}`);
    const { fileContent } = result.reportData;
    downloadPDF(fileContent, fileName);
    index++;
  }
};

work();
