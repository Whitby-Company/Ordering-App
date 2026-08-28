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

// The exact Transaction Pro invoice template header row, in order.
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

// Build one CSV row (array of 56 cells) from a base field map.
function rowFor(fields) {
  return TP_HEADERS.map(h => csvCell(fields[h] ?? ''));
}

// Format a delivery date (ISO yyyy-mm-dd) as MMDDYY for the PO number.
function poDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}${d}${y.slice(2)}`;
}

// Build the full Transaction Pro CSV for one or more orders.
// Each order becomes an invoice; every line item is one CSV row that repeats
// the invoice-level fields (Customer/Date/RefNumber/PO/Memo/totals) — exactly
// how TP's sample groups multiple lines into a single invoice by RefNumber.
function buildTP(orders) {
  const lines = [TP_HEADERS.join(',')];

  for (const order of orders) {
    const { qbName } = mapCustomer(order.customer);
    const date = formatIIFDate(order.deliveryDate);
    // Only real (qty > 0) lines go on the invoice; check-in / zero lines are
    // skipped so they don't create $0 invoice rows.
    const orderLines = (order.lines || []).filter(l => (Number(l.qty) || 0) > 0);
    if (orderLines.length === 0) continue;

    // Invoice-level values built from the customer's abbreviation / short name.
    // PO Number = MMDDYY-<abbr>; Memo = <short name>. Blank if not set.
    const abbr = (order.abbreviation || '').trim();
    const shortName = (order.shortName || '').trim();
    const poNumber = abbr ? `${poDate(order.deliveryDate)}-${abbr}` : '';
    const memo = shortName;

    // Whole-order totals (repeated on every line for the Other1/Other2 fields).
    const totalCases = orderLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    const totalEaches = orderLines.reduce((s, l) => s + eaches(l), 0);

    for (const l of orderLines) {
      const fields = {
        Customer: qbName,
        'Transaction Date': date,
        RefNumber: order.id,
        'PO Number': poNumber,
        'Template Name': '1-HG INV W/UPC',
        'To Be Printed': 'Y',
        Memo: memo,
        // Taxable, matching the real QuickBooks invoices. Sales Tax Item is
        // left blank so QuickBooks applies the customer's default tax item.
        'Cust. Tax Code': 'Tax',
        'Sales Tax Code': 'Tax',
        Item: l.id, // app SKU matches the QuickBooks item name exactly
        Quantity: eaches(l),
        Description: l.name,
        Price: round2(l.price),
        // Custom "Other" fields: Other = this line's cases; Other1 = total cases
        // on the order; Other2 = total eaches on the order.
        Other: Number(l.qty) || 0,
        Other1: totalCases,
        Other2: totalEaches,
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
