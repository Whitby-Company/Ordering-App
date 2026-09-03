// tp.js — generate a Transaction Pro Importer CSV for QuickBooks Desktop.
//
// Matches Transaction Pro's official invoice import template exactly (the 56
// column headers below, in this order), so the importer auto-maps every field.
//
// KEY LESSON (proven by testing): the "AR Account" column must be FILLED IN
// with the real A/R account name ("Accounts Receivable"). This Transaction Pro
// build does NOT auto-fill A/R from a blank column — it passes the blank to
// WriteInvoice, which QuickBooks rejects as "invalid account specified". The
// error surfaces on the item-settings screen but is really the invoice's A/R
// account. QuickBooks still fills Terms, Memo, Class, U/M from its own records,
// so those stay blank.
//
// What we populate (the essentials that build a correct invoice):
//   Customer, Transaction Date, RefNumber, Item, Quantity, Description, Price,
//   plus Memo (which Times store, when the app customer is a Times ship-to).
// Everything else is intentionally blank for a clean baseline import; fields
// like PO Number, Terms, tax, and ship-to can be layered in later.
//
// Quantity is in EACHES (cases x pack) and Price is per-each, so
// Quantity x Price = the correct line total — no unit-of-measure step needed.

const { mapCustomer, formatIIFDate } = require('./iif');

// The full Transaction Pro invoice template header row, in order (reference).
const TP_HEADERS = [
  'Customer', 'Transaction Date', 'RefNumber', 'PO Number', 'Terms', 'Class',
  'Template Name', 'To Be Printed', 'Ship Date',
  'BillTo Line1', 'BillTo Line2', 'BillTo Line3', 'BillTo Line4',
  'BillTo City', 'BillTo State', 'BillTo PostalCode', 'BillTo Country',
  'ShipTo Line1', 'ShipTo Line2', 'ShipTo Line3', 'ShipTo Line4',
  'ShipTo City', 'ShipTo State', 'ShipTo PostalCode', 'ShipTo Country',
  'Phone', 'Fax', 'Email', 'Contact Name', 'First Name', 'Last Name', 'Rep',
  'Due Date', 'Ship Method', 'Customer Message', 'Memo', 'Cust. Tax Code',
  'Item', 'Quantity', 'Description', 'Price', 'Is Pending', 'Item Line Class',
  'Service Date', 'FOB', 'Customer Acct No', 'Sales Tax Item', 'To Be E-Mailed',
  'Other', 'Other1', 'Other2', 'Unit of Measure', 'AR Account', 'Currency',
  'Exchange Rate', 'Sales Tax Code',
];

// The columns we actually export, in the template's original order. Only the
// fields we populate — Price and Description come from the QuickBooks item, and
// everything else (Terms, addresses, etc.) is left to QuickBooks / the customer.
const TP_COLUMNS = [
  'Customer', 'Transaction Date', 'RefNumber', 'PO Number', 'Template Name',
  'ShipTo Line1', 'ShipTo Line2', 'ShipTo Line3', 'ShipTo Line4',
  'Customer Message', 'Memo', 'Cust. Tax Code', 'Item', 'Quantity', 'FOB',
  'Other', 'Other1', 'Unit of Measure', 'AR Account', 'Sales Tax Code',
];

// Per-each price x pack x qty(cases) = line total; quantity is exported as eaches.
function eaches(line) {
  const pack = Number(line.pack) || 1;
  const qty = Number(line.qty) || 0;
  return pack * qty;
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// RFC-4180 CSV quoting: wrap in double-quotes if the value has a comma, quote,
// or newline; escape embedded quotes by doubling them.
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Build one CSV row from the kept columns.
function rowFor(fields) {
  return TP_COLUMNS.map(h => csvCell(fields[h] ?? ''));
}

// Format an ISO date (yyyy-mm-dd) as MMDDYY for the PO number.
function poDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}${d}${y.slice(2)}`;
}

// Compose "City, State Zip" from an order's ship-to parts, skipping any blanks.
function cityStateZip(order) {
  const cs = [order.shipToCity, order.shipToState].map(v => (v || '').trim()).filter(Boolean).join(', ');
  return [cs, (order.shipToZip || '').trim()].filter(Boolean).join(' ').trim();
}

// Today's date as ISO yyyy-mm-dd (used for the PO number = the invoice/export date).
function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Build the full Transaction Pro CSV for one or more orders.
// Each order becomes an invoice; every line item is one CSV row that repeats
// the invoice-level fields (Customer/Date/RefNumber/PO/Memo/totals) — exactly
// how TP's sample groups multiple lines into a single invoice by RefNumber.
function buildTP(orders, brandAbbrev = {}, invoiceOffset = 0) {
  const lines = [TP_COLUMNS.join(',')];
  // PO number uses the export date (when the invoice is being created).
  const exportPoDate = poDate(todayISO());

  for (const order of orders) {
    const { qbName } = mapCustomer(order.customer);
    const date = formatIIFDate(order.deliveryDate);
    const allLines = order.lines || [];
    // Lines with a real quantity come first; out-of-stock / backorder lines
    // (qty 0) still go on the invoice as $0 rows, sorted to the very bottom.
    const positive = allLines.filter(l => (Number(l.qty) || 0) > 0);
    const zeros = allLines.filter(l => (Number(l.qty) || 0) === 0);
    const orderLines = [...positive, ...zeros];
    if (orderLines.length === 0) continue;

    // PO Number = the order's custom po_number if set, else MMDDYY(export date)-<abbr>.
    const abbr = (order.abbreviation || '').trim();
    const shortName = (order.shortName || '').trim();
    const autoPo = abbr ? `${exportPoDate}-${abbr}` : '';
    const poNumber = (order.poNumber && String(order.poNumber).trim()) ? String(order.poNumber).trim() : autoPo;
    // In the memo the PO is labeled "PO#"; the PO Number column stays plain.
    const poForMemo = poNumber ? `PO# ${poNumber}` : '';

    // Memo prefix: "Asst" when the order spans 2+ brands; for a single brand,
    // that brand's abbreviation (falling back to the full brand name). Based on
    // the real (positive) lines so a backorder doesn't flip a single-brand order.
    const brandBasis = positive.length > 0 ? positive : orderLines;
    const brands = [...new Set(brandBasis.map(l => (l.brand || String(l.id).split(':')[0] || '').trim()).filter(Boolean))];
    let prefix = '';
    if (brands.length > 1) prefix = 'Asst';
    else if (brands.length === 1) prefix = brandAbbrev[brands[0]] || brands[0];

    let memo = '';
    if (shortName) {
      const poSuffix = poForMemo ? ` ${poForMemo}` : '';
      memo = `${prefix ? prefix + ' ' : ''}${shortName}${poSuffix}`;
    }

    // Whole-order totals (positive lines only — backorders add nothing).
    const totalCases = positive.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalEaches = positive.reduce((s, l) => s + eaches(l), 0);

    for (const l of orderLines) {
      const fields = {
        Customer: qbName,
        'Transaction Date': date,
        RefNumber: Number(order.id) + Number(invoiceOffset || 0),
        'PO Number': poNumber,
        'Template Name': '1 - HG  INV W/ UPC',
        // Ship-to block, composed explicitly so it prints in this exact order:
        //   store name / street / City, State Zip / Ph. <phone>
        'ShipTo Line1': order.shipToLine1 || '',
        'ShipTo Line2': order.shipToLine2 || '',
        'ShipTo Line3': cityStateZip(order),
        'ShipTo Line4': order.shipToPhone ? `Ph. ${order.shipToPhone}` : '',
        'Customer Message': 'Thank you for your business.',
        Memo: memo,
        // Taxable, matching the real QuickBooks invoices.
        'Cust. Tax Code': 'Tax',
        'Sales Tax Code': 'Tax',
        Item: l.id, // app SKU matches the QuickBooks item name exactly
        Quantity: eaches(l),
        // Price and Description are intentionally omitted — QuickBooks fills
        // them from the item record.
        // Other = total cases on the order; FOB = total eaches on the order;
        // Other1 = this line's case count.
        Other: totalCases,
        FOB: totalEaches,
        Other1: Number(l.qty) || 0,
        'Unit of Measure': 'ea',
        // A/R account MUST be filled in for this Transaction Pro build — leaving
        // it blank makes WriteInvoice fail with "invalid account specified".
        'AR Account': 'Accounts Receivable',
      };
      lines.push(rowFor(fields).join(','));
    }
  }

  // CRLF line endings are the most import-friendly for Windows tools.
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildTP, TP_HEADERS };
