/**
 * Configuration + credential resolution for salesforce-mcp.
 *
 * Two auth modes:
 *   - `gateway` (default in container): credentials arrive per-request via HTTP
 *      headers injected by the WYRE Gateway. Container holds NO startup creds.
 *   - `env`: credentials read from process.env at startup. Used for local /
 *      standalone testing (Claude Desktop, dev shells).
 *
 * Two Salesforce auth flows supported:
 *   - OAuth 2.0 Client Credentials (default): client_id + client_secret +
 *     instance_url. Salesforce Connected App must have "Enable Client
 *     Credentials Flow" turned on.
 *   - Username+Password (fallback): username + password + security token.
 *     instance_url optional (defaults to https://login.salesforce.com).
 */

export type AuthMode = 'gateway' | 'env';
export type SalesforceAuthFlow = 'client_credentials' | 'username_password';

export interface SalesforceCredentials {
  authFlow: SalesforceAuthFlow;
  // Client Credentials fields
  clientId?: string;
  clientSecret?: string;
  // Username/Password fields
  username?: string;
  password?: string;
  securityToken?: string;
  // Common
  instanceUrl?: string;
}

export interface EnvironmentConfig {
  authMode: AuthMode;
  transport: {
    type: 'http' | 'stdio';
    port: number;
    host: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  build: {
    version: string;
    commitSha: string;
    buildDate: string;
  };
}

const HEADER_NAMES = {
  authFlow: 'x-salesforce-auth-mode',
  clientId: 'x-salesforce-client-id',
  clientSecret: 'x-salesforce-client-secret',
  username: 'x-salesforce-username',
  password: 'x-salesforce-password',
  securityToken: 'x-salesforce-token',
  instanceUrl: 'x-salesforce-instance-url',
} as const;

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Parse per-request Salesforce credentials from HTTP headers. The WYRE Gateway
 * injects these via `vendor.buildHeadersAsync` against the per-(user, team,
 * org)-resolved BYOC credential row.
 *
 * Returns whatever subset of fields is present — callers decide whether enough
 * is there to construct a valid jsforce connection (see services/connection.ts).
 */
export function parseCredentialsFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): SalesforceCredentials {
  const rawFlow = getHeader(headers, HEADER_NAMES.authFlow);
  const authFlow: SalesforceAuthFlow =
    rawFlow === 'username_password' ? 'username_password' : 'client_credentials';

  return {
    authFlow,
    clientId: getHeader(headers, HEADER_NAMES.clientId),
    clientSecret: getHeader(headers, HEADER_NAMES.clientSecret),
    username: getHeader(headers, HEADER_NAMES.username),
    password: getHeader(headers, HEADER_NAMES.password),
    securityToken: getHeader(headers, HEADER_NAMES.securityToken),
    instanceUrl: getHeader(headers, HEADER_NAMES.instanceUrl),
  };
}

/**
 * Parse Salesforce credentials from environment variables. Used in `env` auth
 * mode for standalone / local-dev usage. NOT used in container prod.
 */
export function parseCredentialsFromEnv(): SalesforceCredentials {
  const rawFlow = process.env.SALESFORCE_AUTH_FLOW;
  const authFlow: SalesforceAuthFlow =
    rawFlow === 'username_password' ? 'username_password' : 'client_credentials';

  return {
    authFlow,
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    username: process.env.SALESFORCE_USERNAME,
    password: process.env.SALESFORCE_PASSWORD,
    securityToken: process.env.SALESFORCE_TOKEN,
    instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
  };
}

export function loadEnvironmentConfig(): EnvironmentConfig {
  const rawTransport = process.env.MCP_TRANSPORT;
  const transportType: 'http' | 'stdio' = rawTransport === 'stdio' ? 'stdio' : 'http';

  const rawLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const level =
    rawLevel === 'debug' || rawLevel === 'warn' || rawLevel === 'error'
      ? (rawLevel as 'debug' | 'warn' | 'error')
      : 'info';

  const authMode: AuthMode = process.env.AUTH_MODE === 'env' ? 'env' : 'gateway';

  return {
    authMode,
    transport: {
      type: transportType,
      port: Number(process.env.PORT ?? 8080),
      host: process.env.HOST ?? '0.0.0.0',
    },
    logging: { level },
    build: {
      version: process.env.BUILD_VERSION ?? 'unknown',
      commitSha: process.env.BUILD_COMMIT_SHA ?? 'unknown',
      buildDate: process.env.BUILD_DATE ?? 'unknown',
    },
  };
}

/**
 * Validate a credential bundle is sufficient to construct a jsforce connection
 * for the chosen auth flow. Returns a list of human-readable problems (empty
 * if valid).
 */
export function validateCredentials(creds: SalesforceCredentials): string[] {
  const problems: string[] = [];
  if (creds.authFlow === 'client_credentials') {
    if (!creds.clientId) problems.push('clientId missing (X-Salesforce-Client-Id)');
    if (!creds.clientSecret) problems.push('clientSecret missing (X-Salesforce-Client-Secret)');
    if (!creds.instanceUrl)
      problems.push(
        'instanceUrl missing (X-Salesforce-Instance-Url) — required for Client Credentials Flow',
      );
  } else {
    if (!creds.username) problems.push('username missing (X-Salesforce-Username)');
    if (!creds.password) problems.push('password missing (X-Salesforce-Password)');
    // securityToken is optional if IP allowlisting is configured at the SF org
    // level; instanceUrl is optional (defaults to login.salesforce.com).
  }
  return problems;
}
