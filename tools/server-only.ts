import { DatabaseManager } from '../src/database';
import { ServerManager } from '../src/server-manager';

// Initialize database and server manager
const db = new DatabaseManager();  // Use default config.db
const serverManager = new ServerManager(db);

console.log('🚀 Starting SLightSFTP Server...\n');

// Initialize database asynchronously
(async () => {
  try {
    await db.init();
    console.log('📊 Database initialized');
    console.log('🔑 Default users available for testing');
    console.log('👥 Check test-client.ts for credentials\n');
    
    // Get all listeners and start them
    const listeners = db.getAllListeners();
    console.log(`📡 Found ${listeners.length} listener(s) configured\n`);
  
  if (listeners.length === 0) {
    console.log('⚠️  No listeners configured in database');
    console.log('💡 The test database should auto-create listeners on first run\n');
  }
  
  listeners.forEach(listener => {
    console.log(`🌐 Starting ${listener.protocol} server:`);
    console.log(`   - Name: ${listener.name}`);
    console.log(`   - Host: ${listener.bindingIp}:${listener.port}`);
    console.log(`   - Active: ${listener.enabled}\n`);
    
    if (listener.enabled) {
      serverManager.startListener(listener.id!)
        .then(() => {
          console.log(`✅ ${listener.protocol} server started successfully on ${listener.bindingIp}:${listener.port}\n`);
        })
        .catch(err => {
          console.error(`❌ Failed to start ${listener.protocol} server:`, err.message, '\n');
        });
    }
  });
  
  console.log('🎯 Server is ready for connections!');
  console.log('📝 Run "npm run test:client" in another terminal to test\n');
  console.log('⏹️  Press Ctrl+C to stop the server\n');
  
  } catch (error: any) {
    console.error('❌ Failed to initialize:', error.message);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down servers...');
  
  const listeners = db.getAllListeners();
  for (const listener of listeners) {
    if (listener.enabled) {
      try {
        await serverManager.stopListener(listener.id!);
        console.log(`✅ Stopped ${listener.protocol} server on port ${listener.port}`);
      } catch (err: any) {
        console.error(`❌ Error stopping ${listener.protocol} server:`, err.message);
      }
    }
  }
  
  console.log('👋 Goodbye!\n');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\n🛑 Received SIGTERM, shutting down...');
  process.exit(0);
});
