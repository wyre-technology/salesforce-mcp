/**
 * jsforce connection factory — given a credential bundle, produce an
 * authenticated jsforce.Connection.
 *
 * Two flows supported per Salesforce OAuth docs:
 *
 *  - Client Credentials: POST to <instance_url>/services/oauth2/token with
 *    grant_type=client_credentials + client_id/client_secret. The Connected
 *    App must have "Enable Client Credentials Flow" turned on; a run-as user
 *    must be selected on the Connected App's policies page. Returns an
 *    access_token bound to the run-as user's permissions.
 *
 *  - Username/Password (SOAP login): jsforce.Connection.login(username,
 *    password + securityToken). instanceUrl defaults to
 *    https://login.salesforce.com. Sandboxes use https://test.salesforce.com.
 *
 * Connections are NOT cached here — the gateway treats each request as
 * independent. In hot-path use this means an OAuth round-trip per call; the
 * token cache (if any) is a future optimization keyed on a hash of
 * (clientId, instanceUrl).
 */

import jsforce, { type Connection } from 'jsforce';
import type { SalesforceCredentials } from '../utils/config.js';

export interface ConnectionResult {
  connection: Connection;
  /** The instance URL the token is bound to (may differ from the requested
   *  instanceUrl if the SF org has a My Domain configured). */
  resolvedInstanceUrl: string;
  authFlow: SalesforceCredentials['authFlow'];
}

/**
 * Build a jsforce.Connection from a credential bundle. Throws on any auth
 * failure with a Salesforce-specific error message so the gateway can surface
 * a useful error to the customer.
 */
export async function buildConnection(
  creds: SalesforceCredentials,
): Promise<ConnectionResult> {
  if (creds.authFlow === 'client_credentials') {
    return buildClientCredentialsConnection(creds);
  }
  return buildUsernamePasswordConnection(creds);
}

async function buildClientCredentialsConnection(
  creds: SalesforceCredentials,
): Promise<ConnectionResult> {
  if (!creds.clientId || !creds.clientSecret || !creds.instanceUrl) {
    throw new Error(
      'Client Credentials Flow requires clientId, clientSecret, and instanceUrl',
    );
  }

  const tokenUrl = `${creds.instanceUrl.replace(/\/$/, '')}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Salesforce OAuth token endpoint returned ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  const payload = (await res.json()) as {
    access_token?: string;
    instance_url?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (payload.error) {
    throw new Error(
      `Salesforce OAuth error: ${payload.error} — ${payload.error_description ?? 'no description'}`,
    );
  }

  if (!payload.access_token) {
    throw new Error('Salesforce OAuth response missing access_token');
  }

  const resolvedInstanceUrl = payload.instance_url ?? creds.instanceUrl;
  const connection = new jsforce.Connection({
    instanceUrl: resolvedInstanceUrl,
    accessToken: payload.access_token,
  });

  return { connection, resolvedInstanceUrl, authFlow: 'client_credentials' };
}

async function buildUsernamePasswordConnection(
  creds: SalesforceCredentials,
): Promise<ConnectionResult> {
  if (!creds.username || !creds.password) {
    throw new Error('Username/Password flow requires username and password');
  }

  const loginUrl = creds.instanceUrl ?? 'https://login.salesforce.com';
  const connection = new jsforce.Connection({ loginUrl });

  // SOAP login — security token is appended to the password per Salesforce
  // convention. If the org has IP allowlisting, token may not be required.
  const passwordWithToken = creds.securityToken
    ? `${creds.password}${creds.securityToken}`
    : creds.password;

  const userInfo = await connection.login(creds.username, passwordWithToken);

  // After login, connection.instanceUrl is populated with the user's actual
  // org instance URL (may differ from the loginUrl which is just the auth
  // entry point).
  return {
    connection,
    resolvedInstanceUrl: connection.instanceUrl ?? loginUrl,
    authFlow: 'username_password',
  };
}
