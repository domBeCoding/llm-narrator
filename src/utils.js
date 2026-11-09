// QWERTY rows, including the punctuation keys on the home and bottom rows.
const KEYBOARD_ROWS = [
  'qwertyuiop',
  "asdfghjkl;'",
  'zxcvbnm,./',
];

// Walks shorter than four characters include real words such as "up" and
// "sad", so those go to Jev instead of being rejected here.
const MIN_KEYBOARD_WALK_LENGTH = 4;

// True when the whole string is a straight walk along one row, forwards or
// backwards (qwerty, ytrewq). Sharing a row is not enough: flask and pour
// use one row, but they do not walk along it.
function isSequentialKeyboardWalk(text) {
  const value = text.toLowerCase();
  if (value.length < MIN_KEYBOARD_WALK_LENGTH) return false;

  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('');
    if (row.includes(value) || reversed.includes(value)) return true;
  }

  return false;
}

// Cheap local pre-check for obvious junk only. Everything else is decided by
// Jev. This must not reject real words that happen to use one keyboard row.
function isGibberish(text) {
  const cleaned = text.toLowerCase().trim();

  // One character repeated (aaaa, hhh, !!!!).
  if (/^(.)\1{2,}$/.test(cleaned)) return true;

  // Digits only.
  if (/^\d+$/.test(cleaned)) return true;

  // No letters at all.
  if (/^[^a-z]*$/i.test(cleaned)) return true;

  if (isSequentialKeyboardWalk(cleaned)) return true;

  return false;
}

module.exports = { isGibberish, isSequentialKeyboardWalk };
