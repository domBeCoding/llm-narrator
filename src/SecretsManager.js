const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

class SecretsManager {
  // The SSM client is built on the first lookup, not in the constructor.
  // Pass options.ssmClient or options.createClient(region) in tests.
  // Fly.io has no AWS credentials, so a client must not be built when the
  // process already has its secrets in the environment.
  constructor(region, options = {}) {
    this.region = region || process.env.AWS_REGION || 'eu-north-1';
    this._ssmClient = options.ssmClient || null;
    this._createClient = typeof options.createClient === 'function' ? options.createClient : null;
  }

  get ssmClient() {
    if (!this._ssmClient) {
      this._ssmClient = this._createClient
        ? this._createClient(this.region)
        : new SSMClient({ region: this.region });
    }
    return this._ssmClient;
  }

  set ssmClient(client) {
    this._ssmClient = client;
  }

  async getSecret(parameterName) {
    try {
      const command = new GetParameterCommand({
        Name: parameterName,
        WithDecryption: true
      });
      const response = await this.ssmClient.send(command);
      return response.Parameter.Value;
    } catch (error) {
      console.error(`Failed to retrieve parameter ${parameterName}:`, error.message);
      throw error;
    }
  }
}

module.exports = SecretsManager;
