// QWERTY rows, including the punctuation keys on the home and bottom rows.
const KEYBOARD_ROWS = [
  'qwertyuiop',
  "asdfghjkl;'",
  'zxcvbnm,./',
];

// True when the whole string is a straight walk along one row, forwards or
// backwards (qwerty, ytrewq). Sharing a row is not enough: flask and pour
// use one row, but they do not walk along it.
function isSequentialKeyboardWalk(text) {
  const value = text.toLowerCase();
  if (value.length < 2) return false;

  for (const row of KEYBOARD_ROWS) {
    const reversed = [...row].reverse().join('');
    if (row.includes(value) || reversed.includes(value)) return true;
  }

  return false;
}

function isGibberish(text) {
  const cleaned = text.toLowerCase().trim();

  // Too short to be meaningful
  if (cleaned.length < 2) return true;

  // Single character repeated (e.g., "aaaa", "hhh")
  if (/^(.)\1{2,}$/.test(cleaned)) return true;

  // Random keyboard mashing patterns (no vowels, or very few)
  const vowels = cleaned.match(/[aeiou]/g);
  const consonants = cleaned.match(/[bcdfghjklmnpqrstvwxyz]/g);
  if (consonants && consonants.length > 4 && (!vowels || vowels.length === 0)) return true;

  // Common gibberish patterns
  const gibberishPatterns = [
    /^\d+$/,              // just numbers
    /^[^a-z]*$/i,         // no letters at all
  ];

  if (isSequentialKeyboardWalk(cleaned)) return true;

  for (const pattern of gibberishPatterns) {
    if (pattern.test(cleaned)) return true;
  }

  // Very short and not a recognizable word or command
  const recognizableWords = ['yes', 'no', 'ok', 'hi', 'hey', 'go', 'run', 'wait', 'stop', 'look', 'take', 'get', 'use', 'open', 'close', 'talk', 'ask', 'tell', 'give', 'drop', 'leave', 'enter', 'exit', 'help', 'continue', 'resume'];
  if (cleaned.length <= 3 && !recognizableWords.includes(cleaned)) return true;

  return false;
}

module.exports = { isGibberish };
