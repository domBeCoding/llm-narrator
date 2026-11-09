const DEFAULT_PARAMETER = 'typesafe-api-key';

function missingKeyWarning(name) {
  return `TypeSafe API key is not configured (${name}). The bot will start, and junk checks will let messages through.`;
}

// Env wins when it is set. Otherwise load the SSM parameter. Never throws:
// a missing key must not stop the bot from starting, and the value is not logged.
async function loadTypesafeApiKey(secretsManager, env = process.env) {
  if (env && env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;

  const name = (env && env.TYPESAFE_CREDENTIALS_SECRET) || DEFAULT_PARAMETER;
  if (!secretsManager || typeof secretsManager.getSecret !== 'function') {
    console.warn(missingKeyWarning(name));
    return null;
  }

  try {
    const value = await secretsManager.getSecret(name);
    if (typeof value !== 'string' || value.length === 0) {
      console.warn(missingKeyWarning(name));
      return null;
    }
    return value;
  } catch (error) {
    console.warn(missingKeyWarning(name));
    return null;
  }
}

module.exports = { loadTypesafeApiKey, DEFAULT_PARAMETER };
