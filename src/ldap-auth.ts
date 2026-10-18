/**
 * LDAP / Active Directory sign-in. Users whose authSource is "ldap" keep their
 * listeners, folders and permissions in SLightSFTP; only the password is
 * checked against the directory: search the user's DN with the service
 * account, then bind as that DN with the password the user typed.
 */
import { Client } from 'ldapts';
import { DatabaseManager } from './database';
import logger from './logger';

export interface LdapSettings {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  /** "{username}" is replaced by the escaped login name */
  userFilter: string;
  tlsVerify: boolean;
}

export const LDAP_DEFAULT_FILTER = '(&(objectClass=person)(|(uid={username})(sAMAccountName={username})(userPrincipalName={username})))';

export function readLdapSettings(db: DatabaseManager): LdapSettings {
  const get = (k: string) => db.getSetting(k) || '';
  return {
    enabled: get('ldapEnabled') === 'true',
    url: get('ldapUrl'),
    bindDn: get('ldapBindDn'),
    bindPassword: get('ldapBindPassword'),
    baseDn: get('ldapBaseDn'),
    userFilter: get('ldapUserFilter') || LDAP_DEFAULT_FILTER,
    tlsVerify: get('ldapTlsVerify') !== 'false',
  };
}

export function saveLdapSettings(db: DatabaseManager, input: Partial<LdapSettings>): void {
  if (input.url !== undefined && input.url && !/^ldaps?:\/\/[^\s]+$/i.test(input.url)) throw new Error('The URL must start with ldap:// or ldaps://');
  if (input.userFilter !== undefined && input.userFilter && !input.userFilter.includes('{username}')) throw new Error('The user filter must contain {username}');
  const merged = { ...readLdapSettings(db), ...input };
  if (merged.enabled && (!merged.url || !merged.baseDn)) throw new Error('URL and base DN are required');
  const map: Record<string, string | undefined> = {
    ldapUrl: input.url, ldapBindDn: input.bindDn, ldapBaseDn: input.baseDn, ldapUserFilter: input.userFilter,
  };
  for (const [k, v] of Object.entries(map)) if (v !== undefined) db.setSetting(k, String(v).trim());
  // an empty bind password in the form means "keep the stored one"
  if (input.bindPassword) db.setSetting('ldapBindPassword', input.bindPassword);
  if (input.tlsVerify !== undefined) db.setSetting('ldapTlsVerify', input.tlsVerify ? 'true' : 'false');
  if (input.enabled !== undefined) db.setSetting('ldapEnabled', input.enabled ? 'true' : 'false');
}

/** What the GUI may see (never the bind password). */
export function publicLdapSettings(db: DatabaseManager) {
  const { bindPassword, ...rest } = readLdapSettings(db);
  return { ...rest, hasBindPassword: !!bindPassword };
}

/** RFC 4515 escaping for values inside a search filter. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

function client(settings: LdapSettings): Client {
  return new Client({
    url: settings.url,
    timeout: 5000,
    connectTimeout: 5000,
    // only for ldaps:// - with tlsOptions ldapts starts TLS even on a plain ldap:// URL
    ...(/^ldaps:/i.test(settings.url) ? { tlsOptions: { rejectUnauthorized: settings.tlsVerify } } : {}),
  });
}

async function findUserDn(settings: LdapSettings, username: string): Promise<string | null> {
  const c = client(settings);
  try {
    if (settings.bindDn) await c.bind(settings.bindDn, settings.bindPassword);
    const { searchEntries } = await c.search(settings.baseDn, {
      scope: 'sub',
      filter: settings.userFilter.split('{username}').join(escapeFilterValue(username)),
      attributes: ['dn'],
      sizeLimit: 2,
    });
    return searchEntries.length === 1 ? searchEntries[0].dn : null;
  } finally {
    await c.unbind().catch(() => undefined);
  }
}

/** Check a user's password against the directory. Never throws. */
export async function ldapVerify(settings: LdapSettings, username: string, password: string): Promise<boolean> {
  // an empty password would be an "unauthenticated bind" that many servers accept
  if (!settings.enabled || !settings.url || !username || typeof password !== 'string' || password.length === 0) return false;
  try {
    const dn = await findUserDn(settings, username);
    if (!dn) return false;
    const c = client(settings);
    try {
      await c.bind(dn, password);
      return true;
    } finally {
      await c.unbind().catch(() => undefined);
    }
  } catch (err: any) {
    if (!/invalid credentials/i.test(String(err?.message))) logger.warn(`LDAP sign-in check failed: ${err?.message || err}`);
    return false;
  }
}

/** "Test connection": bind with the service account and look the user up. */
export async function testLdap(settings: LdapSettings, username?: string): Promise<{ ok: boolean; message: string }> {
  if (!settings.url || !settings.baseDn) return { ok: false, message: 'URL and base DN are required' };
  try {
    if (username) {
      const dn = await findUserDn(settings, username);
      return dn ? { ok: true, message: `Found ${dn}` } : { ok: false, message: `No unique entry for "${username}"` };
    }
    const c = client(settings);
    try {
      if (settings.bindDn) await c.bind(settings.bindDn, settings.bindPassword);
      await c.search(settings.baseDn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] });
      return { ok: true, message: 'Connected' };
    } finally {
      await c.unbind().catch(() => undefined);
    }
  } catch (err: any) {
    return { ok: false, message: String(err?.message || err) };
  }
}
