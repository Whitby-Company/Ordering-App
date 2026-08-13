// iif.js — generate QuickBooks Desktop IIF invoice files from orders.
//
// IIF is a tab-separated text format. An invoice batch looks like:
//   !TRNS   TRNSTYPE  DATE      ACCNT                 NAME    AMOUNT  MEMO
//   !SPL    TRNSTYPE  DATE      ACCNT                 NAME    AMOUNT  INVITEM  QNTY  PRICE  MEMO
//   !ENDTRNS
//   TRNS    INVOICE   MM/DD/YYYY Accounts Receivable  Times   123.45  Kahala #2
//   SPL     INVOICE   MM/DD/YYYY Sales                        -100.00 AZLBA:53500c  -2  50.00
//   SPL     INVOICE   MM/DD/YYYY Sales                        -23.45  AT:1400c      -1  23.45
//   ENDTRNS
//
// Rules (confirmed against Intuit docs + working examples):
//  - The TRNS AMOUNT (positive, the A/R total) and the SPL AMOUNTs (negative)
//    must sum to zero — double-entry.
//  - QNTY on SPL lines is negative for an invoice (goods leaving inventory).
//  - Customers/items are matched by NAME/INVITEM; they must already exist in
//    QuickBooks (the app's SKUs match QB item codes exactly).
//  - Times: every "Times <Store>" app customer invoices to the single QB
//    customer "Times", with the store name in the invoice MEMO.

// Per-each price × pack = case price; × qty (cases) = line total.
function lineAmount(line) {
  const price = Number(line.price) || 0;
  const pack = Number(line.pack) || 1;
  const qty = Number(line.qty) || 0;
  return price * pack * qty;
}

// Case price (what QuickBooks should see as PRICE, since QNTY is in cases).
function casePrice(line) {
  const price = Number(line.price) || 0;
  const pack = Number(line.pack) || 1;
  return price * pack;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// MM/DD/YYYY from an ISO date string ('2026-08-20') without timezone drift.
function formatIIFDate(isoDate) {
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoDate);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// Map an app customer name to { qbName, memo } for QuickBooks.
// "Times Kahala #2" -> { qbName: 'Times', memo: 'Kahala #2' }
// "Times"            -> { qbName: 'Times', memo: '' }
// anything else      -> { qbName: <unchanged>, memo: '' }
function mapCustomer(appCustomerName) {
  const name = String(appCustomerName || '').trim();
  if (name === 'Times') return { qbName: 'Times', memo: '' };
  if (/^Times\s+/i.test(name)) {
    return { qbName: 'Times', memo: name.replace(/^Times\s+/i, '').trim() };
  }
  return { qbName: name, memo: '' };
}

// IIF fields are tab-separated, so strip tabs/newlines from any value.
function clean(val) {
  return String(val == null ? '' : val).replace(/[\t\r\n]+/g, ' ').trim();
}

// Build a complete IIF document for one or more orders.
// options: { arAccount = 'Accounts Receivable', incomeAccount = 'Sales' }
function buildIIF(orders, options = {}) {
  const arAccount = options.arAccount || 'Accounts Receivable';
  const incomeAccount = options.incomeAccount || 'Sales';

  const lines = [];
  // Header rows define the columns for each record type.
  lines.push(['!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'MEMO'].join('\t'));
  lines.push(['!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'INVITEM', 'QNTY', 'PRICE', 'MEMO'].join('\t'));
  lines.push('!ENDTRNS');

  for (const order of orders) {
    const { qbName, memo } = mapCustomer(order.customer);
    const date = formatIIFDate(order.deliveryDate);
    // Combine the store memo with any order notes for context on the invoice.
    const noteParts = [];
    if (memo) noteParts.push(memo);
    if (order.notes) noteParts.push(order.notes);
    const trnsMemo = clean(noteParts.join(' — '));

    const orderLines = Array.isArray(order.lines) ? order.lines : [];
    const total = round2(orderLines.reduce((s, l) => s + lineAmount(l), 0));

    // TRNS: the A/R side, positive total.
    lines.push([
      'TRNS', 'INVOICE', date, arAccount, clean(qbName), total.toFixed(2), trnsMemo,
    ].join('\t'));

    // One SPL per line item: income side, negative amount and negative qty.
    for (const l of orderLines) {
      const amt = round2(lineAmount(l));
      const qty = Number(l.qty) || 0;
      const price = round2(casePrice(l));
      lines.push([
        'SPL', 'INVOICE', date, incomeAccount, '', (-amt).toFixed(2),
        clean(l.id), (-qty).toString(), price.toFixed(2), clean(l.name),
      ].join('\t'));
    }

    lines.push('ENDTRNS');
  }

  // IIF files use CRLF line endings and a trailing newline.
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildIIF, mapCustomer, formatIIFDate, lineAmount, casePrice };
