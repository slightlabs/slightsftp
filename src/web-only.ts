import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { WebServer } from './web-server';
import logger from './logger';
import { getServerCertificate, setCertificateDir } from './tls';
import { WebhookDispatcher } from './webhooks';
import { SyslogForwarder } from './syslog';
import { purgeExpired } from './recycle-bin';
import { seedDefaultAdmin } from './default-admin';
import { createShutdown, installProcessHandlers, shutdownGraceMs } from './lifecycle';

// Initialize database and server manager
const db = new DatabaseManager();  // Use default config.db
const serverManager = new ServerManager(db);

// Web server port (can be configured)
const WEB_PORT = process.env.WEB_PORT ? parseInt(process.env.WEB_PORT) : 3000;

console.log('🚀 Starting SLightSFTP Server with Web GUI...\n');

// Initialize database asynchronously
(async () => {
  try {
    await db.init();
    logger.info('📊 Database initialized');
    
    // Fresh install only: create the default admin (a password change is forced on first sign-in)
    if (seedDefaultAdmin(db) !== null) {
      logger.info('👤 Created default admin user (username: admin, password: admin123 — change it on first sign-in)');
    }

    // Keep the activity log within its retention period (also daily while running)
    const cleanupActivities = () => {
      try {
        const removed = db.cleanupOldActivities();
        if (removed) logger.info(`🧹 Removed ${removed} activity log entr${removed === 1 ? 'y' : 'ies'} past the retention period`);
      } catch (err: any) {
        logger.error('Activity log cleanup failed:', err.message);
      }
    };
    cleanupActivities();
    setInterval(cleanupActivities, 86_400_000).unref();

    // Get all listeners and start them
    const listeners = db.getAllListeners();
    logger.info(`📡 Found ${listeners.length} listener(s) configured`);
  
    if (listeners.length === 0) {
      logger.warn('⚠️  No listeners configured in database');
      logger.info('💡 The test database should auto-create listeners on first run');
    }
  
    // Start all enabled listeners
    await serverManager.startAllEnabledListeners();
    
    // Start web GUI server (HTTPS when WEB_HTTPS=true or the webHttps setting is on)
    let tls: { key: string; cert: string } | undefined;
    if (process.env.WEB_HTTPS === 'true' || (process.env.WEB_HTTPS !== 'false' && db.getSetting('webHttps') === 'true')) {
      setCertificateDir(process.cwd());
      tls = await getServerCertificate({ certPath: db.getSetting('tlsCertPath'), keyPath: db.getSetting('tlsKeyPath') });
    }
    purgeExpired(db);
    setInterval(() => { try { purgeExpired(db); } catch { /* logged on next run */ } }, 3_600_000).unref();
    const webhooks = new WebhookDispatcher(db);
    const syslog = new SyslogForwarder(db);
    const webServer = new WebServer(db, serverManager, WEB_PORT, { tls, webhooks, syslog });
    await webServer.start();
    
    logger.info('🎯 Server is ready!');
    logger.info(`🌐 Access the Web GUI at: ${webServer.getUrl()}`);
    logger.info('⏹️  Press Ctrl+C to stop the server\n');
    
    // Graceful shutdown (docker stop, systemd, Ctrl+C): stop taking new work,
    // let transfers in progress finish within the grace period, then close
    const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise(resolve => setTimeout(resolve, ms).unref())]);
    const shutdown = createShutdown([
      ['web GUI', () => webServer.stop()],
      ['listeners', grace => serverManager.stopAllListeners(grace)],
      // deliver the events of the last transfers (bounded: an endpoint may be down)
      ['webhooks', () => timeout(webhooks.idle(), 2000).then(() => webhooks.stop())],
      ['syslog', () => timeout(syslog.idle(), 1000).then(() => syslog.stop())],
      ['database', () => db.close()],
    ], { graceMs: shutdownGraceMs(), log: logger });
    installProcessHandlers(shutdown, logger);

  } catch (error: any) {
    logger.error('❌ Failed to initialize:', error.message);
    process.exit(1);
  }
})();
