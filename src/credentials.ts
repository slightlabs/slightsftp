/**
 * One place that decides whether a password is right, for local users
 * (salted hash in the database) and directory users (LDAP / AD).
 *
 * Local checks stay synchronous (a boolean); directory checks return a Promise.
 */
import { DatabaseManager } from './database';
import { ldapVerify, readLdapSettings } from './ldap-auth';
import { User } from './types';

export function isDirectoryUser(user: Pick<User, 'authSource'> | undefined | null): boolean {
  return user?.authSource === 'ldap';
}

/**
 * @param protocol true for SFTP / FTP logins, which also require password
 *                 authentication to be enabled for the user
 */
export function verifyUserPassword(db: DatabaseManager, user: User, password: string, protocol = false): boolean | Promise<boolean> {
  if (protocol && !user.passwordEnabled) return false;
  if (isDirectoryUser(user)) return ldapVerify(readLdapSettings(db), user.username, password);
  return protocol ? db.verifyPassword(user.username, password) : db.checkPassword(user.username, password);
}
