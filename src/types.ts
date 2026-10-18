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
  /** comma-separated addresses / CIDR ranges this user may sign in from (empty = anywhere) */
  allowedIps?: string | null;
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
  /** size of a completed transfer, when known */
  bytes?: number | null;
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

export type WebhookEvent = 'upload' | 'download' | 'delete' | 'login' | 'login_failed' | 'share';

export interface Webhook {
  id?: number;
  name: string;
  url: string;
  events: WebhookEvent[];
  format: 'json' | 'slack';
  /** only fire for this user (null = everyone) */
  usernameFilter?: string | null;
  /** only fire for paths at or below this virtual path */
  pathPrefix?: string | null;
  /** HMAC-SHA256 signing secret (X-SLightSFTP-Signature) */
  secret?: string | null;
  enabled: boolean;
  lastStatus?: string | null;
  lastDeliveredAt?: string | null;
  createdAt?: string;
}
