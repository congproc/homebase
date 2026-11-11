// Electricity cost of the server's energy. With a tiered tariff the server's kWh are not priced on their own:
// they sit on top of the rest of the household's monthly use, so they cost what the bill would drop by if the
// server were off — usually the household's highest tiers. That difference is what we report.

/** EVN residential retail tariff from 1 Nov 2026 (5 tiers, VND/kWh before VAT). Tier sizes in kWh; null = no upper limit. */
export const EVN_RESIDENTIAL = Object.freeze({
  id: 'evn', name: 'EVN residential, 5 tiers', effective: '2026-11-01', currency: 'VND', vat: 0.08,
  tiers: [[100, 1901], [100, 2289], [200, 2894], [300, 3456], [null, 3844]],
});

/** Validates a tariff from config: 'evn', {tiers: [[size|null, price], ...], vat, currency, name, effective}, or a flat price. */
export function parseTariff(value, {pricePerKwh, currency, vat} = {}) {
  let t = null;
  if (value === 'evn') t = {...EVN_RESIDENTIAL};
  else if (value && typeof value === 'object' && Array.isArray(value.tiers) && value.tiers.length) {
    const tiers = value.tiers.map(([size, price]) => [size == null ? null : Number(size), Number(price)]);
    if (tiers.every(([s, p], i) => (s === null ? i === tiers.length - 1 : s > 0) && p >= 0 && Number.isFinite(p)))
      t = {id: 'custom', name: String(value.name || 'Custom tariff'), effective: value.effective ? String(value.effective) : null,
        currency: String(value.currency || currency || ''), vat: Number(value.vat) >= 0 ? Number(value.vat) : 0, tiers};
  } else if (pricePerKwh > 0) t = {id: 'flat', name: 'Flat price', effective: null, currency: currency || '', vat: 0, tiers: [[null, pricePerKwh]]};
  if (t && Number(vat) >= 0 && vat !== undefined && vat !== null && vat !== '') t.vat = Number(vat);
  if (t) t.currency = String(t.currency).slice(0, 8);
  return t;
}

/** Bill before VAT for `kwh` in one month. */
export function bill(kwh, tiers) {
  let left = Math.max(0, kwh), total = 0;
  for (const [size, price] of tiers) {
    const used = size == null ? left : Math.min(left, size);
    total += used * price; left -= used;
    if (left <= 0) break;
  }
  return total;
}

/** Which tiers the kWh between `from` and `to` (household totals) fall in: [{tier: 1-based, kwh, price}]. */
export function tiersBetween(from, to, tiers) {
  const out = [];
  let start = 0;
  tiers.forEach(([size, price], i) => {
    const end = size == null ? Infinity : start + size;
    const used = Math.min(to, end) - Math.max(from, start);
    if (used > 1e-9) out.push({tier: i + 1, kwh: used, price});
    start = end;
  });
  return out;
}

/**
 * Monthly cost (incl. VAT) of `serverKwh` when the household — server included — uses `householdKwh` a month.
 * If the server alone uses more than the household figure, the household figure is raised to match.
 */
export function serverCost(serverKwh, householdKwh, tariff) {
  const total = Math.max(householdKwh || 0, serverKwh);
  const withVat = 1 + (tariff.vat || 0);
  const cost = (bill(total, tariff.tiers) - bill(total - serverKwh, tariff.tiers)) * withVat;
  return {
    kwh: serverKwh, cost, perKwh: serverKwh > 0 ? cost / serverKwh : (tiersBetween(Math.max(0, total - 1e-6), total + 1e-6, tariff.tiers)[0]?.price || 0) * withVat,
    tiers: tiersBetween(total - serverKwh, total, tariff.tiers), household: total,
  };
}
