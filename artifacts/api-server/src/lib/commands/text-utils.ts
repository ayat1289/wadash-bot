const FANCY_MAP: Record<string, string> = {
  a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
  j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
  s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
};

const BOLD_MAP: Record<string, string> = {
  a: "𝗮", b: "𝗯", c: "𝗰", d: "𝗱", e: "𝗲", f: "𝗳", g: "𝗴", h: "𝗵", i: "𝗶",
  j: "𝗷", k: "𝗸", l: "𝗹", m: "𝗺", n: "𝗻", o: "𝗼", p: "𝗽", q: "𝗾", r: "𝗿",
  s: "𝘀", t: "𝘁", u: "𝘂", v: "𝘃", w: "𝘄", x: "𝘅", y: "𝘆", z: "𝘇",
  A: "𝗔", B: "𝗕", C: "𝗖", D: "𝗗", E: "𝗘", F: "𝗙", G: "𝗚", H: "𝗛", I: "𝗜",
  J: "𝗝", K: "𝗞", L: "𝗟", M: "𝗠", N: "𝗡", O: "𝗢", P: "𝗣", Q: "𝗤", R: "𝗥",
  S: "𝗦", T: "𝗧", U: "𝗨", V: "𝗩", W: "𝗪", X: "𝗫", Y: "𝗬", Z: "𝗭",
};

const FLIP_MAP: Record<string, string> = {
  a: "ɐ", b: "q", c: "ɔ", d: "p", e: "ǝ", f: "ɟ", g: "ƃ", h: "ɥ", i: "ᴉ",
  j: "ɾ", k: "ʞ", l: "l", m: "ɯ", n: "u", o: "o", p: "d", q: "b", r: "ɹ",
  s: "s", t: "ʇ", u: "n", v: "ʌ", w: "ʍ", x: "x", y: "ʎ", z: "z",
  ".": "˙", ",": "'", "?": "¿", "!": "¡", "'": ",", "(": ")", ")": "(",
};

const MORSE_MAP: Record<string, string> = {
  a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.",
  h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.",
  o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-",
  v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  " ": "/",
};

export function toFancy(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((c) => FANCY_MAP[c] ?? c)
    .join("");
}

export function toBold(text: string): string {
  return text
    .split("")
    .map((c) => BOLD_MAP[c] ?? c)
    .join("");
}

export function flipText(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((c) => FLIP_MAP[c] ?? c)
    .reverse()
    .join("");
}

export function toMorse(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((c) => MORSE_MAP[c] ?? "")
    .join(" ")
    .trim();
}

export function toBinary(text: string): string {
  return text
    .split("")
    .map((c) => c.charCodeAt(0).toString(2).padStart(8, "0"))
    .join(" ");
}

export function genPassword(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_-+=";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fancy fonts (~50 styles) for `.fancy`                                       */
/* -------------------------------------------------------------------------- */

type StyleFn = (s: string) => string;

/**
 * Build a per-character mapper for Unicode alphabets that are mostly laid out
 * contiguously from a base code point. `ex` patches the holes (e.g. the script
 * alphabet borrows several letters from the Letterlike Symbols block).
 */
function styler(opts: {
  upper?: number;
  lower?: number;
  digit?: number;
  ex?: Record<string, string>;
  upperForLower?: boolean;
}): StyleFn {
  const { upper, lower, digit, ex = {}, upperForLower = false } = opts;
  return (text) =>
    [...text]
      .map((ch) => {
        if (ex[ch] !== undefined) return ex[ch];
        const c = ch.codePointAt(0);
        if (c === undefined) return ch;
        if (c >= 65 && c <= 90 && upper !== undefined) return String.fromCodePoint(upper + c - 65);
        if (c >= 97 && c <= 122) {
          if (lower !== undefined) return String.fromCodePoint(lower + c - 97);
          if (upperForLower && upper !== undefined) return String.fromCodePoint(upper + c - 97);
        }
        if (c >= 48 && c <= 57 && digit !== undefined) return String.fromCodePoint(digit + c - 48);
        return ch;
      })
      .join("");
}

/** Append a combining mark after every visible (non-space) character. */
function combiner(mark: string): StyleFn {
  return (text) =>
    [...text].map((ch) => (ch === " " ? ch : ch + mark)).join("");
}

const wrap = (pre: string, post: string): StyleFn => (text) => `${pre}${text}${post}`;

const smallCaps = styler({
  upper: undefined,
  lower: undefined,
  ex: {
    a: "ᴀ", b: "ʙ", c: "ᴄ", d: "ᴅ", e: "ᴇ", f: "ꜰ", g: "ɢ", h: "ʜ", i: "ɪ",
    j: "ᴊ", k: "ᴋ", l: "ʟ", m: "ᴍ", n: "ɴ", o: "ᴏ", p: "ᴘ", q: "ǫ", r: "ʀ",
    s: "s", t: "ᴛ", u: "ᴜ", v: "ᴠ", w: "ᴡ", x: "x", y: "ʏ", z: "ᴢ",
  },
});

const circledDigits: Record<string, string> = {
  "0": "⓪", "1": "①", "2": "②", "3": "③", "4": "④",
  "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨",
};
const parenDigits: Record<string, string> = {
  "1": "⑴", "2": "⑵", "3": "⑶", "4": "⑷", "5": "⑸",
  "6": "⑹", "7": "⑺", "8": "⑻", "9": "⑼",
};

export interface FancyStyle {
  name: string;
  fn: StyleFn;
}

export const FANCY_STYLES: FancyStyle[] = [
  { name: "Bold", fn: styler({ upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce }) },
  { name: "Italic", fn: styler({ upper: 0x1d434, lower: 0x1d44e, ex: { h: "ℎ" } }) },
  { name: "Bold Italic", fn: styler({ upper: 0x1d468, lower: 0x1d482 }) },
  {
    name: "Script",
    fn: styler({
      upper: 0x1d49c,
      lower: 0x1d4b6,
      ex: {
        B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ",
        e: "ℯ", g: "ℊ", o: "ℴ",
      },
    }),
  },
  { name: "Bold Script", fn: styler({ upper: 0x1d4d0, lower: 0x1d4ea }) },
  {
    name: "Fraktur",
    fn: styler({
      upper: 0x1d504,
      lower: 0x1d51e,
      ex: { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" },
    }),
  },
  { name: "Bold Fraktur", fn: styler({ upper: 0x1d56c, lower: 0x1d586 }) },
  {
    name: "Double Struck",
    fn: styler({
      upper: 0x1d538,
      lower: 0x1d552,
      digit: 0x1d7d8,
      ex: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
    }),
  },
  { name: "Sans", fn: styler({ upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 }) },
  { name: "Sans Bold", fn: styler({ upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec }) },
  { name: "Sans Italic", fn: styler({ upper: 0x1d608, lower: 0x1d622 }) },
  { name: "Sans Bold Italic", fn: styler({ upper: 0x1d63c, lower: 0x1d656 }) },
  { name: "Monospace", fn: styler({ upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 }) },
  { name: "Fullwidth", fn: styler({ upper: 0xff21, lower: 0xff41, digit: 0xff10 }) },
  { name: "Small Caps", fn: smallCaps },
  { name: "Circled", fn: styler({ upper: 0x24b6, lower: 0x24d0, ex: circledDigits }) },
  { name: "Circled Filled", fn: styler({ upper: 0x1f150, upperForLower: true }) },
  { name: "Squared", fn: styler({ upper: 0x1f130, upperForLower: true }) },
  { name: "Squared Filled", fn: styler({ upper: 0x1f170, upperForLower: true }) },
  { name: "Parenthesized", fn: styler({ upper: 0x1f110, lower: 0x249c, ex: parenDigits }) },
  { name: "Boxed", fn: styler({ upper: 0x1f1e6, upperForLower: true }) },
  { name: "Strikethrough", fn: combiner("\u0336") },
  { name: "Underline", fn: combiner("\u0332") },
  { name: "Double Underline", fn: combiner("\u0333") },
  { name: "Slashed", fn: combiner("\u0337") },
  { name: "Overline", fn: combiner("\u0305") },
  { name: "Upside Down", fn: flipText },
  { name: "Reversed", fn: (t) => [...t].reverse().join("") },
  { name: "Spaced", fn: (t) => [...t.replace(/\s+/g, " ")].join(" ").trim() },
  { name: "Dotted", fn: (t) => [...t].filter((c) => c !== " ").join("·") },
  { name: "Royal", fn: wrap("꧁༺ ", " ༻꧂") },
  { name: "Glitter", fn: wrap("✦ ", " ✦") },
  { name: "Sparkle", fn: wrap("✧･ﾟ ", " ･ﾟ✧") },
  { name: "Stars", fn: wrap("★彡 ", " 彡★") },
  { name: "Hearts", fn: wrap("ღ ", " ღ") },
  { name: "Flower", fn: wrap("❀ ", " ❀") },
  { name: "Fire", fn: wrap("🔥 ", " 🔥") },
  { name: "Crown", fn: wrap("👑 ", " 👑") },
  { name: "Wave", fn: wrap("≋ ", " ≋") },
  { name: "Arrow", fn: wrap("➫ ", " ➬") },
  { name: "Corner", fn: wrap("「 ", " 」") },
  { name: "Corner Filled", fn: wrap("『 ", " 』") },
  { name: "Lenticular", fn: wrap("【 ", " 】") },
  { name: "Tortoise", fn: wrap("〖 ", " 〗") },
  { name: "Angle", fn: wrap("❮ ", " ❯") },
  { name: "Double Angle", fn: wrap("≪ ", " ≫") },
  { name: "Bracket", fn: wrap("⟦ ", " ⟧") },
  { name: "Diamond", fn: wrap("◈ ", " ◈") },
  { name: "Bar", fn: wrap("▌║▌ ", " ▌║▌") },
  { name: "Ribbon", fn: wrap("╰☆╮ ", " ╭☆╯") },
];

/** Render every fancy style for `text`, numbered, as a single message body. */
export function fancyAll(text: string): string {
  const clipped = text.length > 30 ? `${text.slice(0, 30)}…` : text;
  const lines = FANCY_STYLES.map((s, i) => `${i + 1}. ${s.fn(clipped)}`);
  return `✨ *Fancy Text* — "${clipped}"\n\n${lines.join("\n")}`;
}
