// Single source of truth for the auto-generated PO# format, used both when a
// new order is created (routes/orders.js) and as a fallback for old orders
// that predate that feature (iif.js, tp.js). Everywhere else should just read
// the order's saved po_number — this function only computes what that value
// would be when one hasn't been saved.
//
// Format: MMDDYY(date)-<customer abbreviation>, e.g. "091626-ABC".
// Special case: "Times" stores (e.g. "Times Kunia #18") get "MMDDYY(date)TMS-
// <store#>" instead (no leading zeros on the date part), matching how
// QuickBooks has always identified their invoices — this does NOT use the
// customer's abbreviation field.
function timesStoreNumber(customerName) {
  const name = String(customerName || '').trim();
  if (!/^Times(\s|$)/i.test(name)) return null;
  const m = name.match(/#\s*(\d+)/);
  return m ? m[1] : (name === 'Times' ? '' : null);
}

function datePartsFrom(dateOrIso) {
  const m = String(dateOrIso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { yy: m[1].slice(2), mm: m[2], dd: m[3] };
}

// Zero-padded MMDDYY — used for the standard (non-Times) format, matching
// what the order form, printed invoices, and the TP export have always shown.
function buildAutoPoBase(customerName, abbreviation, dateOrIso) {
  const parts = datePartsFrom(dateOrIso);
  if (!parts) return '';
  const storeNum = timesStoreNumber(customerName);
  if (storeNum !== null) {
    // No leading zeros for Times, matching the existing QuickBooks convention.
    const noZero = `${parseInt(parts.mm, 10)}${parseInt(parts.dd, 10)}${parts.yy}`;
    return storeNum ? `${noZero}TMS-${storeNum}` : noZero;
  }
  const padded = `${parts.mm}${parts.dd}${parts.yy}`;
  const abbr = (abbreviation || '').trim();
  return abbr ? `${padded}-${abbr}` : padded;
}

module.exports = { buildAutoPoBase };
