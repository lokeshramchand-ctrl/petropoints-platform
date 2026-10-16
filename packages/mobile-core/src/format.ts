export const formatPoints = (n: number) => new Intl.NumberFormat('en-IN').format(n);

export const formatRupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(paise / 100);

/** "₹2,500.50" / "2500.5" / "2500" -> paise. Returns null when it is not a valid positive amount. */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return paise > 0 ? paise : null;
}

/** Accepts "98765 43210", "+91 98765-43210", "09876543210" => +91XXXXXXXXXX, or null if not a valid mobile. */
export function normaliseMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}
