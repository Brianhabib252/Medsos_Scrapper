const $ = (selector) => document.querySelector(selector);
const STORAGE_RESULTS = "social_scraper_results";
const STORAGE_STATUS = "social_scraper_status";
const LEGACY_RESULTS = "igs_results";
const LEGACY_STATUS = "igs_status";

const PLATFORM_LABELS = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook"
};

const elements = {
  platformSelect: $("#platformSelect"),
  untilDate: $("#untilDate"),
  maxPosts: $("#maxPosts"),
  delayMs: $("#delayMs"),
  startBtn: $("#startBtn"),
  stopBtn: $("#stopBtn"),
  exportBtn: $("#exportBtn"),
  clearBtn: $("#clearBtn"),
  stateBadge: $("#stateBadge"),
  statusTitle: $("#statusTitle"),
  statusText: $("#statusText"),
  countValue: $("#countValue"),
  lastDate: $("#lastDate"),
  resultsBody: $("#resultsBody")
};

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("id-ID") : String(value);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function detectPlatformFromUrl(url = "") {
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("facebook.com") || url.includes("web.facebook.com")) return "facebook";
  return "";
}

async function getActiveSocialTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("Tab aktif tidak ditemukan.");
  const detectedPlatform = detectPlatformFromUrl(tab.url || "");
  if (!detectedPlatform) {
    throw new Error("Buka halaman Instagram, TikTok, atau Facebook terlebih dahulu.");
  }

  const selectedPlatform = elements.platformSelect.value;
  if (selectedPlatform !== "auto" && selectedPlatform !== detectedPlatform) {
    throw new Error(`Tab aktif adalah ${PLATFORM_LABELS[detectedPlatform]}, bukan ${PLATFORM_LABELS[selectedPlatform]}.`);
  }

  return { tab, platform: detectedPlatform };
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

async function startScraping() {
  if (!elements.untilDate.value) {
    setStatus("Tanggal batas belum diisi", "Pilih tanggal paling lama yang ingin diambil.");
    elements.untilDate.focus();
    return;
  }

  try {
    const { tab, platform } = await getActiveSocialTab();
    const payload = {
      platform,
      untilDate: elements.untilDate.value,
      maxPosts: Number(elements.maxPosts.value || 100),
      delayMs: Number(elements.delayMs.value || 1400)
    };
    await sendToTab(tab.id, { type: "SCS_START", payload });
    setStatus("Berjalan", `Extension mulai membaca post yang terlihat di halaman ${PLATFORM_LABELS[platform]}.`);
  } catch (error) {
    setStatus("Tidak bisa mulai", error.message);
  }
}

async function stopScraping() {
  try {
    const { tab } = await getActiveSocialTab();
    await sendToTab(tab.id, { type: "SCS_STOP" });
    setStatus("Dihentikan", "Proses dihentikan oleh user.");
  } catch (error) {
    setStatus("Tidak bisa stop", error.message);
  }
}

function setStatus(title, text) {
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
}

function renderStatus(status = {}) {
  const running = status.state === "running";
  elements.stateBadge.textContent = running ? "Running" : "Idle";
  elements.stateBadge.classList.toggle("running", running);
  elements.startBtn.disabled = running;
  elements.stopBtn.disabled = !running;

  if (status.title || status.message) {
    setStatus(status.title || "Status", status.message || "");
  }
}

function renderResults(results = []) {
  elements.countValue.textContent = results.length.toLocaleString("id-ID");
  elements.lastDate.textContent = formatDate(results.at(-1)?.postedAt);
  elements.exportBtn.disabled = results.length === 0;

  if (!results.length) {
    elements.resultsBody.innerHTML = '<tr><td colspan="6" class="empty">Belum ada data.</td></tr>';
    return;
  }

  elements.resultsBody.innerHTML = results
    .slice(-25)
    .reverse()
    .map((item) => {
      const label = item.caption ? item.caption.slice(0, 58) : item.shortcode || item.url;
      return `
        <tr>
          <td title="${escapeHtml(item.url || "")}">${escapeHtml(label || "-")}</td>
          <td>${escapeHtml(formatPlatform(item.platform))}</td>
          <td>${escapeHtml(formatContentType(item))}</td>
          <td>${escapeHtml(formatNumber(item.likeCount))}</td>
          <td>${escapeHtml(formatNumber(item.commentCount))}</td>
          <td>${escapeHtml(formatDate(item.postedAt))}</td>
        </tr>
      `;
    })
    .join("");
}

function formatPlatform(platform) {
  return PLATFORM_LABELS[platform] || "-";
}

function formatContentType(item) {
  if (item.contentTypeLabel) {
    return item.mediaCount ? `${item.contentTypeLabel} (${item.mediaCount})` : item.contentTypeLabel;
  }
  if (item.videoCount > 0) return item.mediaCount > 1 ? `Carousel video (${item.mediaCount})` : "Video";
  return item.mediaCount ? `Gambar (${item.mediaCount})` : "-";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function hydrate() {
  const storage = await chrome.storage.local.get([
    STORAGE_STATUS,
    STORAGE_RESULTS,
    LEGACY_STATUS,
    LEGACY_RESULTS
  ]);
  const status = storage[STORAGE_STATUS] || storage[LEGACY_STATUS];
  const results = storage[STORAGE_RESULTS] || storage[LEGACY_RESULTS] || [];
  renderStatus(status);
  renderResults(results);
}

async function exportExcel() {
  const storage = await chrome.storage.local.get([STORAGE_RESULTS, LEGACY_RESULTS]);
  const results = storage[STORAGE_RESULTS] || storage[LEGACY_RESULTS] || [];
  if (!results?.length) return;

  const dataHeaders = [
    "Platform",
    "URL Post",
    "Caption",
    "Jenis Konten",
    "Jumlah Media",
    "Jumlah Gambar",
    "Jumlah Video",
    "Jumlah Like",
    "Jumlah Komentar",
    "Jumlah Share",
    "Jumlah Disimpan",
    "Tanggal Posting",
    "Tanggal Scraping"
  ];
  const dataRows = results.map((item) => [
    formatPlatform(item.platform),
    item.url || "",
    item.caption || "",
    item.contentTypeLabel || item.contentType || "",
    item.mediaCount ?? "",
    item.imageCount ?? "",
    item.videoCount ?? "",
    item.likeCount ?? "",
    item.commentCount ?? "",
    item.shareCount ?? "",
    item.savedCount ?? "",
    formatDateTimeForExcel(item.postedAt),
    formatDateTimeForExcel(item.scrapedAt)
  ]);
  const summaryRows = buildSummaryRows(results);
  const workbook = buildExcelWorkbook([
    { name: "Data Postingan", rows: [dataHeaders, ...dataRows] },
    { name: "Ringkasan", rows: summaryRows }
  ]);

  const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);

  chrome.downloads.download(
    {
      url,
      filename: `social-post-data-${date}.xls`,
      saveAs: true
    },
    () => setTimeout(() => URL.revokeObjectURL(url), 1000)
  );
}

function buildSummaryRows(results) {
  const validDates = results
    .map((item) => new Date(item.postedAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a - b);
  const oldestDate = validDates[0] || null;
  const newestDate = validDates.at(-1) || null;
  const weekSpan = oldestDate && newestDate
    ? Math.max(1, Math.ceil(((newestDate - oldestDate) / 86400000 + 1) / 7))
    : 1;
  const totalPosts = results.length;
  const totalLikes = sumField(results, "likeCount");
  const totalComments = sumField(results, "commentCount");
  const totalShares = sumField(results, "shareCount");
  const totalSaved = sumField(results, "savedCount");
  const instagramPosts = results.filter((item) => item.platform === "instagram" || !item.platform).length;
  const tiktokPosts = results.filter((item) => item.platform === "tiktok").length;
  const facebookPosts = results.filter((item) => item.platform === "facebook").length;
  const carouselImagePosts = results.filter((item) => item.contentType === "carousel_image").length;
  const videoPosts = results.filter((item) => item.contentType === "video" || item.contentType === "carousel_video" || Number(item.videoCount) > 0).length;
  const averagePostsPerWeek = totalPosts ? totalPosts / weekSpan : 0;

  return [
    ["Metrik", "Nilai"],
    ["Jumlah postingan", totalPosts],
    ["Jumlah postingan Instagram", instagramPosts],
    ["Jumlah postingan TikTok", tiktokPosts],
    ["Jumlah postingan Facebook", facebookPosts],
    ["Jumlah total like seluruh postingan", totalLikes],
    ["Jumlah seluruh komen", totalComments],
    ["Jumlah seluruh share", totalShares],
    ["Jumlah seluruh disimpan", totalSaved],
    ["Jumlah postingan carousel gambar", carouselImagePosts],
    ["Jumlah postingan video", videoPosts],
    ["Rata-rata postingan per minggu", roundNumber(averagePostsPerWeek, 2)],
    ["Periode posting terbaru", newestDate ? formatDateTimeForExcel(newestDate.toISOString()) : ""],
    ["Periode posting terlama", oldestDate ? formatDateTimeForExcel(oldestDate.toISOString()) : ""],
    ["Jumlah minggu dalam data", weekSpan]
  ];
}

function sumField(items, field) {
  return items.reduce((total, item) => {
    const value = Number(item[field]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function roundNumber(value, precision) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function buildExcelWorkbook(sheets) {
  const worksheets = sheets.map((sheet) => `
    <Worksheet ss:Name="${escapeXml(sheet.name)}">
      <Table>
        ${sheet.rows.map((row, index) => buildExcelRow(row, index === 0)).join("")}
      </Table>
    </Worksheet>
  `).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <Styles>
    <Style ss:ID="Header">
      <Font ss:Bold="1"/>
      <Interior ss:Color="#E2F3F1" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="Text">
      <Alignment ss:Vertical="Top" ss:WrapText="1"/>
    </Style>
    <Style ss:ID="Number">
      <NumberFormat ss:Format="#,##0"/>
    </Style>
    <Style ss:ID="Decimal">
      <NumberFormat ss:Format="#,##0.00"/>
    </Style>
  </Styles>
  ${worksheets}
</Workbook>`;
}

function buildExcelRow(row, isHeader) {
  return `<Row>${row.map((cell) => buildExcelCell(cell, isHeader)).join("")}</Row>`;
}

function buildExcelCell(value, isHeader) {
  const numericValue = typeof value === "number" ? value : Number(value);
  const isNumber = typeof value === "number"
    || (value !== "" && value !== null && value !== undefined && Number.isFinite(numericValue) && !String(value).startsWith("0"));
  const type = isNumber ? "Number" : "String";
  const style = isHeader ? "Header" : isNumber ? Number.isInteger(numericValue) ? "Number" : "Decimal" : "Text";
  const safeValue = isNumber ? String(numericValue) : sanitizeSpreadsheetText(value);

  return `<Cell ss:StyleID="${style}"><Data ss:Type="${type}">${escapeXml(safeValue)}</Data></Cell>`;
}

function formatDateTimeForExcel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (part) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(":");
}

function sanitizeSpreadsheetText(value) {
  let text = String(value ?? "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/^[=+\-@\t]/.test(text)) {
    text = `'${text}`;
  }

  return text;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function clearResults() {
  await chrome.storage.local.set({
    [STORAGE_RESULTS]: [],
    [STORAGE_STATUS]: { state: "idle", title: "Siap", message: "Hasil lokal sudah dibersihkan." },
    [LEGACY_RESULTS]: [],
    [LEGACY_STATUS]: { state: "idle", title: "Siap", message: "Hasil lokal sudah dibersihkan." }
  });
  await hydrate();
}

elements.startBtn.addEventListener("click", startScraping);
elements.stopBtn.addEventListener("click", stopScraping);
elements.exportBtn.addEventListener("click", exportExcel);
elements.clearBtn.addEventListener("click", clearResults);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[STORAGE_STATUS]) renderStatus(changes[STORAGE_STATUS].newValue);
  if (changes[STORAGE_RESULTS]) renderResults(changes[STORAGE_RESULTS].newValue || []);
  if (changes[LEGACY_STATUS] && !changes[STORAGE_STATUS]) renderStatus(changes[LEGACY_STATUS].newValue);
  if (changes[LEGACY_RESULTS] && !changes[STORAGE_RESULTS]) renderResults(changes[LEGACY_RESULTS].newValue || []);
});

hydrate();
