// Finds where the text of two documents differs. Pure functions, no pdf.js, so the tests
// can run them in Node.
//
// Text is compared as tokens: each Chinese character or punctuation mark on its own, and a
// run of letters or digits as one word. Spaces and line breaks are ignored, so text that
// only wraps differently counts as the same.

const SPACE = /^[\s\u{a0}\u{2000}-\u{200d}\u{2028}\u{2029}\u{3000}\u{feff}]$/u;
const WORD = /[\p{L}\p{N}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
// Characters that take a full square, for placing a word inside a run of text.
const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{20000}-\u{3fffd}]/u;

// Halfwidth and fullwidth forms of the same letter or digit count as the same.
function normalize(char) {
  const folded = char.normalize('NFKC');
  return [...folded].length === 1 ? folded : char;
}

export const widthOf = (char) => (WIDE.test(char) ? 1 : 0.55);

// The tokens in one piece of text: { text, start, end }, with start and end as positions
// in the string, so a token can be placed on the page.
export function splitTokens(str) {
  const tokens = [];
  let word = null;
  let at = 0;
  for (const char of str) {
    const next = at + char.length;
    const folded = normalize(char);
    if (SPACE.test(folded)) {
      word = null;
    } else if (WORD.test(folded) && !CJK.test(folded)) {
      if (word) {
        word.text += folded;
        word.end = next;
      } else {
        word = { text: folded, start: at, end: next };
        tokens.push(word);
      }
    } else {
      word = null;
      tokens.push({ text: folded, start: at, end: next });
    }
    at = next;
  }
  return tokens;
}

// ---- Matching two lists ---------------------------------------------------------------

// Above this the exact method would need too much memory, and the part is marked as changed.
const TABLE_LIMIT = 4_000_000;
const DEPTH_LIMIT = 64;

// The longest run of pairs whose second index keeps rising. Pairs come sorted by the first.
function longestRising(pairs) {
  const tails = [];
  const before = new Int32Array(pairs.length);
  for (let k = 0; k < pairs.length; k++) {
    const value = pairs[k][1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pairs[tails[middle]][1] < value) low = middle + 1;
      else high = middle;
    }
    before[k] = low > 0 ? tails[low - 1] : -1;
    tails[low] = k;
  }
  const out = [];
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = before[k]) out.push(pairs[k]);
  return out.reverse();
}

// Items found exactly once on each side make safe fixed points to split the work at.
function uniqueAnchors(a, aLow, aHigh, b, bLow, bHigh) {
  const seen = new Map();
  for (let i = aLow; i < aHigh; i++) {
    let entry = seen.get(a[i]);
    if (!entry) {
      entry = [0, -1, 0, -1];
      seen.set(a[i], entry);
    }
    entry[0]++;
    entry[1] = i;
  }
  for (let j = bLow; j < bHigh; j++) {
    const entry = seen.get(b[j]);
    if (entry) {
      entry[2]++;
      entry[3] = j;
    }
  }
  const pairs = [];
  for (const [countA, at, countB, bt] of seen.values()) {
    if (countA === 1 && countB === 1) pairs.push([at, bt]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return longestRising(pairs);
}

// The exact longest common part, for pieces small enough.
function commonByTable(a, aLow, aHigh, b, bLow, bHigh, out) {
  const n = aHigh - aLow;
  const m = bHigh - bLow;
  const w = m + 1;
  const table = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[aLow + i] === b[bLow + j]
        ? table[(i + 1) * w + j + 1] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aLow + i] === b[bLow + j]) {
      out.push(aLow + i, bLow + j);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
}

// Adds the matching pairs of a[aLow..aHigh) and b[bLow..bHigh) to out, in order.
function matchRange(a, aLow, aHigh, b, bLow, bHigh, out, state, depth) {
  while (aLow < aHigh && bLow < bHigh && a[aLow] === b[bLow]) {
    out.push(aLow, bLow);
    aLow++;
    bLow++;
  }
  let aEnd = aHigh;
  let bEnd = bHigh;
  while (aEnd > aLow && bEnd > bLow && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (aLow < aEnd && bLow < bEnd) {
    const anchors = depth < DEPTH_LIMIT ? uniqueAnchors(a, aLow, aEnd, b, bLow, bEnd) : [];
    if (anchors.length > 0) {
      let fromA = aLow;
      let fromB = bLow;
      for (const [at, bt] of anchors) {
        matchRange(a, fromA, at, b, fromB, bt, out, state, depth + 1);
        out.push(at, bt);
        fromA = at + 1;
        fromB = bt + 1;
      }
      matchRange(a, fromA, aEnd, b, fromB, bEnd, out, state, depth + 1);
    } else if ((aEnd - aLow + 1) * (bEnd - bLow + 1) <= TABLE_LIMIT) {
      commonByTable(a, aLow, aEnd, b, bLow, bEnd, out);
    } else {
      state.rough = true;
    }
  }
  for (let k = 0; k < aHigh - aEnd; k++) out.push(aEnd + k, bEnd + k);
}

// The stretches between matches: { aStart, aEnd, bStart, bEnd }, ends not included.
function stretchesBetween(pairs, n, m) {
  const out = [];
  let fromA = 0;
  let fromB = 0;
  for (let k = 0; k <= pairs.length; k += 2) {
    const at = k < pairs.length ? pairs[k] : n;
    const bt = k < pairs.length ? pairs[k + 1] : m;
    if (at > fromA || bt > fromB) out.push({ aStart: fromA, aEnd: at, bStart: fromB, bEnd: bt });
    fromA = at + 1;
    fromB = bt + 1;
  }
  return out;
}

const isLineBreak = (side, i) => i === 0 || i === side.tokens.length || side.line[i] !== side.line[i - 1];

// A line added or removed can often be marked a little higher or lower with the same
// result, such as taking the full stop of the line above instead of its own. Whole lines
// are what a reader expects, so such a mark is moved to start and end where lines do.
function slideToLines(stretches, left, right) {
  stretches.forEach((stretch, k) => {
    const onLeft = stretch.bStart === stretch.bEnd;
    const onRight = stretch.aStart === stretch.aEnd;
    if (onLeft === onRight) return;
    const side = onLeft ? left : right;
    const from = onLeft ? 'aStart' : 'bStart';
    const until = onLeft ? 'aEnd' : 'bEnd';
    const low = k > 0 ? stretches[k - 1][until] : 0;
    const high = k + 1 < stretches.length ? stretches[k + 1][from] : side.tokens.length;
    let start = stretch[from];
    let end = stretch[until];
    while (start > low && side.tokens[start - 1] === side.tokens[end - 1]) {
      start--;
      end--;
    }
    let best = start;
    let bestScore = -1;
    for (;;) {
      const score = (isLineBreak(side, start) ? 2 : 0) + (isLineBreak(side, end) ? 1 : 0);
      if (score > bestScore) {
        best = start;
        bestScore = score;
      }
      if (end >= high || side.tokens[start] !== side.tokens[end]) break;
      start++;
      end++;
    }
    // The empty side moves along with it: the same words are matched, one place over.
    const shift = best - stretch[from];
    stretch.aStart += shift;
    stretch.aEnd += shift;
    stretch.bStart += shift;
    stretch.bEnd += shift;
  });
}

// A rewritten sentence often shares a stray character or two with the old one. Those few
// do not split one change into many.
function joinNearby(stretches) {
  const size = (s) => Math.max(s.aEnd - s.aStart, s.bEnd - s.bStart);
  const out = [];
  for (const stretch of stretches) {
    const last = out[out.length - 1];
    const between = last ? stretch.aStart - last.aEnd : Infinity;
    if (last && between <= 2 && between * 2 < size(last) + size(stretch)) {
      last.aEnd = stretch.aEnd;
      last.bEnd = stretch.bEnd;
    } else {
      out.push({ ...stretch });
    }
  }
  return out;
}

// side: { tokens: string[], line: line number of each token, never going down }.
function linesOf({ tokens, line }) {
  const keys = [];
  const starts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i === 0 || line[i] !== line[i - 1]) {
      starts.push(i);
      keys.push(tokens[i]);
    } else {
      keys[keys.length - 1] += `\u{1}${tokens[i]}`;
    }
  }
  starts.push(tokens.length);
  return { keys, starts };
}

// The differences between two texts, as stretches of tokens: { aStart, aEnd, bStart, bEnd }.
// rough is true when a part was too different to be matched closely and is marked whole.
export function compareTexts(left, right) {
  const state = { rough: false };
  const linesA = linesOf(left);
  const linesB = linesOf(right);
  // Whole lines first, which is quick, then the tokens of the lines that did not match.
  const linePairs = [];
  matchRange(linesA.keys, 0, linesA.keys.length, linesB.keys, 0, linesB.keys.length, linePairs, state, 0);

  const pairs = [];
  let lineA = 0;
  let lineB = 0;
  const matchBetween = (untilA, untilB) => {
    matchRange(left.tokens, linesA.starts[lineA], linesA.starts[untilA], right.tokens, linesB.starts[lineB], linesB.starts[untilB], pairs, state, 0);
  };
  for (let k = 0; k < linePairs.length; k += 2) {
    const at = linePairs[k];
    const bt = linePairs[k + 1];
    matchBetween(at, bt);
    const startA = linesA.starts[at];
    const startB = linesB.starts[bt];
    for (let t = 0; t < linesA.starts[at + 1] - startA; t++) pairs.push(startA + t, startB + t);
    lineA = at + 1;
    lineB = bt + 1;
  }
  matchBetween(linesA.keys.length, linesB.keys.length);

  const stretches = stretchesBetween(pairs, left.tokens.length, right.tokens.length);
  slideToLines(stretches, left, right);
  const differences = joinNearby(stretches);
  return { differences, rough: state.rough };
}
