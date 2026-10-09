// Color notations people type for print: CMYK values, and spot color names in the Pantone,
// HKS and RAL formats print shops recognize. Print Kit ships no color libraries: Pantone, HKS
// and RAL license their values, and the print shop matches a spot color by its name anyway.

// Reads "0 100 100 0", "0/100/100/0", "C0 M100 Y100 K0", "0,100,100,0" or "0;5,5;100;0" as
// four percentages. Commas are decimals unless that leaves fewer than four numbers.
export function parseCmyk(text) {
  const numbers = (source) => (source.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(",", ".")));
  let values = numbers(String(text));
  if (values.length !== 4) values = numbers(String(text).replace(/,/g, " "));
  if (values.length !== 4) return null;
  const fractions = values.every((v) => v <= 1) && values.some((v) => v > 0 && v < 1);
  return values.map((v) => Math.round(Math.min(100, fractions ? v * 100 : v) * 10) / 10);
}

const title = (words) => words.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// Writes spot names the way swatch books print them: "hks 13k" becomes "HKS 13 K",
// "485c" becomes "PANTONE 485 C" and "ral3020" becomes "RAL 3020". Other names stay as typed.
export function normalizeSpot(text) {
  const s = String(text).trim().replace(/\s+/g, " ");
  let m;
  if ((m = s.match(/^hks\s*(\d{1,2})\s*([knez])?$/i))) return `HKS ${Number(m[1])}${m[2] ? " " + m[2].toUpperCase() : ""}`;
  if ((m = s.match(/^ral\s*(\d{4})$/i))) return `RAL ${m[1]}`;
  if ((m = s.match(/^(?:(?:pantone|pms)\s*)?(\d{3,4})\s*([cu])$/i))) return `PANTONE ${m[1]} ${m[2].toUpperCase()}`;
  if ((m = s.match(/^(?:pantone|pms)\s*(.*?)(?:(?<=\d)\s*|\s+)([cu])$/i))) return `PANTONE ${title(m[1])} ${m[2].toUpperCase()}`;
  if ((m = s.match(/^(?:pantone|pms)\s+(.+)$/i))) return `PANTONE ${title(m[1])}`;
  return s;
}

// Separations print shops use besides colors: die cut lines, spot varnish and white ink.
const SPECIALS = [
  { name: "Dieline", note: "dieline" },
  { name: "Varnish", note: "varnish" },
  { name: "White", note: "white" },
];

// Complete names for what has been typed so far, each with a note key for the UI to word.
export function spotSuggestions(text) {
  const s = String(text).trim();
  if (!s) return SPECIALS;
  let m;
  if ((m = s.match(/^hks\s*(\d{1,2})/i))) return ["K", "N", "E", "Z"].map((x) => ({ name: `HKS ${Number(m[1])} ${x}`, note: `hks${x}` }));
  if ((m = s.match(/^ral\s*(\d{4})/i))) return [{ name: `RAL ${m[1]}`, note: "ral" }];
  if ((m = s.match(/^(?:(?:pantone|pms)\s*)?(\d{3,4})/i))) return ["C", "U"].map((x) => ({ name: `PANTONE ${m[1]} ${x}`, note: `pantone${x}` }));
  const special = SPECIALS.filter((item) => item.name.toLowerCase().startsWith(s.toLowerCase()));
  return special.length ? special : [{ name: normalizeSpot(s), note: null }];
}

// A first guess at CMYK percentages without a profile, for prefilling fixed values.
export function roughCmyk(rgb) {
  const k = 1 - Math.max(...rgb);
  if (k >= 1) return [0, 0, 0, 100];
  return rgb.map((v) => Math.round(((1 - v - k) / (1 - k)) * 100)).concat(Math.round(k * 100));
}

function toLab(rgb) {
  const lin = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047;
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

// Color difference between two sRGB colors (CIE76). Around 10 and up, people see it at a glance.
export function deltaE(a, b) {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
