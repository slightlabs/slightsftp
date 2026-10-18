export interface User {
  id?: number;
  username: string;
  password?: string;
  passwordEnabled: boolean;
  publicKey?: string;
  guiEnabled: boolean;
  /** user must pick a new password at their next GUI / portal login */
  mustChangePassword?: boolean;
  /** may sign in to the browser file portal at /files */
  portalEnabled?: boolean;
  createdAt?: string;
}

export interface VirtualPath {
  id?: number;
  userId: number;
  virtualPath: string;
  localPath: string;
  canRead?: boolean;
  canWrite?: boolean;
  canAppend?: boolean;
  canDelete?: boolean;
  canList?: boolean;
  canCreateDir?: boolean;
  canRename?: boolean;
  applyToSubdirs?: boolean;
}

export interface Permission {
  id?: number;
  userId: number;
  listenerId: number;
  canRead: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canAppend: boolean;
  canDelete: boolean;
  canList: boolean;
  canCreateDir: boolean;
  canRename: boolean;
}

export interface Listener {
  id?: number;
  name: string;
  protocol: 'FTP' | 'SFTP' | 'HTTP' | 'HTTPS';
  bindingIp: string;
  port: number;
  enabled: boolean;
  maxConnections?: number;
  /** FTP only: explicit TLS (AUTH TLS). 'optional' allows plain FTP, 'required' refuses it. */
  tlsMode?: FtpTlsMode;
  createdAt?: string;
}

export type FtpTlsMode = 'none' | 'optional' | 'required';

export interface UserListener {
  id?: number;
  userId: number;
  listenerId: number;
}

export interface ServerActivity {
  id?: number;
  listenerId: number | null;
  username: string;
  action: string;
  path: string;
  timestamp?: string;
  success: boolean;
}

export type ShareType = 'download' | 'upload';

export interface Share {
  id?: number;
  /** unguessable URL token (/s/<token>) */
  token: string;
  owner: string;
  type: ShareType;
  /** virtual path of the shared file or folder, in the owner's namespace */
  virtualPath: string;
  passwordHash?: string | null;
  expiresAt?: string | null;
  maxDownloads?: number | null;
  downloadCount?: number;
  revoked?: boolean;
  createdAt?: string;
}
