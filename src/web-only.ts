import { DatabaseManager } from './database';
import { ServerManager } from './server-manager';
import { WebServer } from './web-server';
import logger from './logger';
import { getServerCertificate, setCertificateDir } from './tls';
import { WebhookDispatcher } from './webhooks';
import { SyslogForwarder } from './syslog';
import { purgeExpired } from './recycle-bin';
import { seedDefaultAdmin } from './default-admin';

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
    
    // Graceful shutdown
    const shutdown = async () => {
      logger.info('\n🛑 Shutting down servers...');
      
      try {
        await webServer.stop();
        logger.info('✅ Web server stopped');
      } catch (err: any) {
        logger.error('❌ Error stopping web server:', err.message);
      }
      
      await serverManager.stopAllListeners();
      logger.info('✅ All FTP/SFTP servers stopped');
      
      db.close(); // writes any pending activity log entries
      logger.info('👋 Goodbye!\n');
      process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
  } catch (error: any) {
    logger.error('❌ Failed to initialize:', error.message);
    process.exit(1);
  }
})();
