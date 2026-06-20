// list-preview.js — spreadsheet-style preview of first 5 records (popup + HUD)

const XC_LIST_PREVIEW_OVERLAY_ID = 'xc-list-preview-overlay';
const XC_LIST_PREVIEW_MAX_ROWS = 5;

function xcFormatPreviewCell(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function xcInjectListPreviewStyles(doc) {
  if (doc.getElementById('xc-list-preview-styles')) return;
  const style = doc.createElement('style');
  style.id = 'xc-list-preview-styles';
  style.textContent = `
    #${XC_LIST_PREVIEW_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      padding: 16px;
      box-sizing: border-box;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-window {
      background: #fff;
      color: #111;
      border: 1px solid #999;
      border-radius: 4px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
      width: min(920px, 96vw);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      font-family: "Segoe UI", Calibri, Arial, sans-serif;
      font-size: 12px;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid #d4d4d4;
      background: #f3f3f3;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-title {
      font-weight: 700;
      font-size: 13px;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-close {
      border: 1px solid #aaa;
      background: #fff;
      border-radius: 3px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-close:hover {
      background: #eee;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-scroll {
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table {
      border-collapse: collapse;
      table-layout: auto;
      min-width: 100%;
      width: max-content;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table th,
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table td {
      border: 1px solid #c8c8c8;
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table th {
      background: #e8e8e8;
      font-weight: 700;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table tbody tr {
      height: 28px;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table tbody tr:nth-child(even) td {
      background: #fafafa;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-table tbody tr:hover td {
      background: #e8f4fc;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-foot {
      padding: 8px 12px;
      border-top: 1px solid #d4d4d4;
      color: #555;
      font-size: 11px;
      background: #fafafa;
    }
    #${XC_LIST_PREVIEW_OVERLAY_ID} .xc-preview-empty td {
      color: #888;
      font-style: italic;
      text-align: center;
    }
  `;
  doc.head.appendChild(style);
}

function xcCloseListPreviewModal(doc = document) {
  const existing = doc.getElementById(XC_LIST_PREVIEW_OVERLAY_ID);
  if (existing) existing.remove();
}

function xcShowListPreviewModal(doc, payload = {}) {
  if (!doc) return;
  xcInjectListPreviewStyles(doc);
  xcCloseListPreviewModal(doc);

  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, XC_LIST_PREVIEW_MAX_ROWS) : [];
  const listLabel = payload.listLabel || payload.listType || 'List';
  const total = payload.total != null ? payload.total : rows.length;

  const overlay = doc.createElement('div');
  overlay.id = XC_LIST_PREVIEW_OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${listLabel} preview`);

  const windowEl = doc.createElement('div');
  windowEl.className = 'xc-preview-window';

  const header = doc.createElement('div');
  header.className = 'xc-preview-header';
  const title = doc.createElement('div');
  title.className = 'xc-preview-title';
  title.textContent = `${listLabel} — first ${XC_LIST_PREVIEW_MAX_ROWS} of ${total.toLocaleString()}`;
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'xc-preview-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => xcCloseListPreviewModal(doc));
  header.appendChild(title);
  header.appendChild(closeBtn);

  const scroll = doc.createElement('div');
  scroll.className = 'xc-preview-scroll';

  const table = doc.createElement('table');
  table.className = 'xc-preview-table';

  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const col of columns) {
    const th = doc.createElement('th');
    th.textContent = col.label || col.key || '';
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  if (!rows.length) {
    const emptyRow = doc.createElement('tr');
    emptyRow.className = 'xc-preview-empty';
    const td = doc.createElement('td');
    td.colSpan = Math.max(columns.length, 1);
    td.textContent = 'No records in the active list yet.';
    emptyRow.appendChild(td);
    tbody.appendChild(emptyRow);
  } else {
    for (const row of rows) {
      const tr = doc.createElement('tr');
      for (const col of columns) {
        const td = doc.createElement('td');
        const key = col.key || col.label;
        td.textContent = xcFormatPreviewCell(row?.[key]);
        td.title = row?.[key] != null ? String(row[key]) : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  scroll.appendChild(table);

  const foot = doc.createElement('div');
  foot.className = 'xc-preview-foot';
  foot.textContent = rows.length
    ? `Showing ${rows.length} row(s). Scroll horizontally for all columns.`
    : 'Collect or import a list, then open View again.';

  windowEl.appendChild(header);
  windowEl.appendChild(scroll);
  windowEl.appendChild(foot);
  overlay.appendChild(windowEl);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) xcCloseListPreviewModal(doc);
  });

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      xcCloseListPreviewModal(doc);
      doc.removeEventListener('keydown', onKeyDown);
    }
  };
  doc.addEventListener('keydown', onKeyDown);

  doc.body.appendChild(overlay);
}

async function xcOpenListPreview(fetchPreview, listType) {
  const payload = await fetchPreview(listType);
  if (!payload?.ok) {
    const message = payload?.error || 'Could not load list preview.';
    if (typeof window !== 'undefined' && window.alert) window.alert(message);
    return;
  }
  xcShowListPreviewModal(document, payload);
}