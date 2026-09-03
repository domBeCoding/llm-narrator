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
    /^[asdfghjkl;']+$/i,  // home row mashing
    /^[qwertyuiop]+$/i,   // top row mashing
    /^[zxcvbnm,./]+$/i,   // bottom row mashing
    /^\d+$/,              // just numbers
    /^[^a-z]*$/i,         // no letters at all
  ];

  for (const pattern of gibberishPatterns) {
    if (pattern.test(cleaned)) return true;
  }

  // Very short and not a recognizable word or command
  const recognizableWords = ['yes', 'no', 'ok', 'hi', 'hey', 'go', 'run', 'wait', 'stop', 'look', 'take', 'get', 'use', 'open', 'close', 'talk', 'ask', 'tell', 'give', 'drop', 'leave', 'enter', 'exit', 'help', 'continue', 'resume'];
  if (cleaned.length <= 3 && !recognizableWords.includes(cleaned)) return true;

  return false;
}

module.exports = { isGibberish };
