const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

class SecretsManager {
  constructor(region) {
    this.ssmClient = new SSMClient({ region: region || process.env.AWS_REGION || 'eu-north-1' });
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
