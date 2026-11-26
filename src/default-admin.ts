/**
 * The seeded `admin` / `admin123` account is created exactly once, on a fresh
 * install. An operator who deletes or renames it must not get it back (with
 * its published password) on the next restart.
 */
import { DatabaseManager } from './database';
import { DEFAULT_ADMIN_PASSWORD } from './password';

export const DEFAULT_ADMIN_SEEDED = 'defaultAdminSeeded';

/**
 * True when the default admin should be created now: never seeded before and
 * the database has no users. Existing installs (users present) are marked as
 * seeded so a later deletion of `admin` is permanent.
 */
export function shouldSeedDefaultAdmin(db: DatabaseManager): boolean {
  if (db.getSetting(DEFAULT_ADMIN_SEEDED) === 'true') return false;
  if (db.getAllUsers().length > 0) {
    db.setSetting(DEFAULT_ADMIN_SEEDED, 'true');
    return false;
  }
  return true;
}

/** Create the default admin if this is a fresh install; returns its id, or null. */
export function seedDefaultAdmin(db: DatabaseManager): number | null {
  if (!shouldSeedDefaultAdmin(db)) return null;
  const id = db.createUser({
    username: 'admin',
    password: DEFAULT_ADMIN_PASSWORD,
    passwordEnabled: true,
    publicKey: '',
    guiEnabled: true,
    mustChangePassword: true,
  });
  db.setSetting(DEFAULT_ADMIN_SEEDED, 'true');
  return id;
}
