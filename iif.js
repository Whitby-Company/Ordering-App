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

// Map an app customer name to { qbName, memo, storeNum } for QuickBooks.
// "Times Kahala #2" -> { qbName: 'Times', memo: 'Kahala #2', storeNum: '2' }
// "Times"            -> { qbName: 'Times', memo: '', storeNum: '' }
// anything else      -> { qbName: <unchanged>, memo: '', storeNum: '' }
function mapCustomer(appCustomerName) {
  const name = String(appCustomerName || '').trim();
  if (name === 'Times') return { qbName: 'Times', memo: '', storeNum: '' };
  if (/^Times\s+/i.test(name)) {
    const store = name.replace(/^Times\s+/i, '').trim();
    const numMatch = store.match(/#\s*(\d+)/);
    return { qbName: 'Times', memo: store, storeNum: numMatch ? numMatch[1] : '' };
  }
  return { qbName: name, memo: '', storeNum: '' };
}

// Build the PO number from the order-placed date and the customer.
// Date format matches the user's convention: month + day + 2-digit year with
// no leading zeros (Aug 12 2026 -> "81226"). Times orders append "TMS-<store#>"
// (e.g. "81226TMS-18"); other customers get just the date.
function buildPONumber(order) {
  const m = String(order.submittedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  let datePart = '';
  if (m) {
    const yy = m[1].slice(2);
    const mm = String(parseInt(m[2], 10)); // no leading zero
    const dd = String(parseInt(m[3], 10)); // no leading zero
    datePart = `${mm}${dd}${yy}`;
  }
  const { qbName, storeNum } = mapCustomer(order.customer);
  if (qbName === 'Times' && storeNum) return `${datePart}TMS-${storeNum}`;
  return datePart;
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
  lines.push(['!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'PONUM', 'MEMO'].join('\t'));
  lines.push(['!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'INVITEM', 'QNTY', 'PRICE', 'MEMO'].join('\t'));
  lines.push('!ENDTRNS');

  for (const order of orders) {
    const { qbName, memo } = mapCustomer(order.customer);
    const date = formatIIFDate(order.deliveryDate);
    const poNumber = buildPONumber(order);
    // Combine the store memo with any order notes for context on the invoice.
    const noteParts = [];
    if (memo) noteParts.push(memo);
    if (order.notes) noteParts.push(order.notes);
    const trnsMemo = clean(noteParts.join(' — '));

    const orderLines = Array.isArray(order.lines) ? order.lines : [];
    const total = round2(orderLines.reduce((s, l) => s + lineAmount(l), 0));

    // TRNS: the A/R side, positive total. DOCNUM left blank so QuickBooks
    // assigns the next invoice number; PONUM carries our generated PO.
    lines.push([
      'TRNS', 'INVOICE', date, arAccount, clean(qbName), total.toFixed(2), '', clean(poNumber), trnsMemo,
    ].join('\t'));

    // One SPL per line item: income side, negative amount. Quantities are sent
    // in EACHES (cases × pack) with the per-each price, because QuickBooks reads
    // IIF quantities in the item's base unit (each). This makes the CS/EACHES
    // columns and the "each" unit of measure come out correct.
    for (const l of orderLines) {
      const amt = round2(lineAmount(l));
      const pack = Number(l.pack) || 1;
      const eaches = (Number(l.qty) || 0) * pack;
      const eachPrice = round2(Number(l.price) || 0);
      lines.push([
        'SPL', 'INVOICE', date, incomeAccount, '', (-amt).toFixed(2),
        clean(l.id), (-eaches).toString(), eachPrice.toFixed(2), clean(l.name),
      ].join('\t'));
    }

    lines.push('ENDTRNS');
  }

  // IIF files use CRLF line endings and a trailing newline.
  return lines.join('\r\n') + '\r\n';
}

// EXPERIMENTAL variant: attempts to get QuickBooks to split the CS and EACH
// columns by sending the quantity in CASES and adding a unit-of-measure hint
// column on the SPL lines. IIF has no officially-documented per-line U/M
// column, so this is a best-effort test — QuickBooks may honor it, ignore the
// extra column, or reject the file. The regular buildIIF() remains the safe
// default. We send cases + case price here (so if QB reads it straight, the
// CS column shows the case count); the U/M column is set to "CS".
function buildIIFExperimental(orders, options = {}) {
  const arAccount = options.arAccount || 'Accounts Receivable';
  const incomeAccount = options.incomeAccount || 'Sales';
  const caseUnit = options.caseUnit || 'CS';

  const lines = [];
  // SPL header includes an extra U/M column after QNTY/PRICE. QuickBooks
  // versions that support unit of measure on import look for this.
  lines.push(['!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'PONUM', 'MEMO'].join('\t'));
  lines.push(['!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'INVITEM', 'QNTY', 'PRICE', 'UOM', 'MEMO'].join('\t'));
  lines.push('!ENDTRNS');

  for (const order of orders) {
    const { qbName, memo } = mapCustomer(order.customer);
    const date = formatIIFDate(order.deliveryDate);
    const poNumber = buildPONumber(order);
    const noteParts = [];
    if (memo) noteParts.push(memo);
    if (order.notes) noteParts.push(order.notes);
    const trnsMemo = clean(noteParts.join(' — '));

    const orderLines = Array.isArray(order.lines) ? order.lines : [];
    const total = round2(orderLines.reduce((s, l) => s + lineAmount(l), 0));

    lines.push([
      'TRNS', 'INVOICE', date, arAccount, clean(qbName), total.toFixed(2), '', clean(poNumber), trnsMemo,
    ].join('\t'));

    // Send CASES as the quantity with the CASE price, plus a U/M column = "CS".
    // The line AMOUNT is still the true line total so it balances regardless.
    for (const l of orderLines) {
      const amt = round2(lineAmount(l));
      const cases = Number(l.qty) || 0;
      const cPrice = round2(casePrice(l));
      lines.push([
        'SPL', 'INVOICE', date, incomeAccount, '', (-amt).toFixed(2),
        clean(l.id), (-cases).toString(), cPrice.toFixed(2), caseUnit, clean(l.name),
      ].join('\t'));
    }

    lines.push('ENDTRNS');
  }

  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildIIF, buildIIFExperimental, mapCustomer, buildPONumber, formatIIFDate, lineAmount, casePrice };
