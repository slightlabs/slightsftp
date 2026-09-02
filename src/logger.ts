import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

// Get logs directory based on environment
function getLogsDirectory(): string {
  // Try to use Electron's app if available, otherwise fall back to Node.js
  try {
    const { app } = require('electron');
    const isPackaged = app.isPackaged;
    
    if (isPackaged) {
      // Production: Use installation directory
      const installPath = path.dirname(app.getPath('exe'));
      return path.join(installPath, 'logs');
    } else {
      // Development: Use current working directory
      return path.join(process.cwd(), 'logs');
    }
  } catch (error) {
    // Not running in Electron, use current working directory
    return path.join(process.cwd(), 'logs');
  }
}

// Ensure logs directory exists
const logsDir = getLogsDirectory();
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (stack) {
      msg += `\n${stack}`;
    }
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    // Console output
    new winston.transports.Console({
      format: consoleFormat
    }),
    
    // Combined log file (all levels)
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Error log file (errors only)
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Application log file (daily rotation)
    new winston.transports.File({
      filename: path.join(logsDir, `app-${new Date().toISOString().split('T')[0]}.log`),
      format: fileFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 7 // Keep last 7 days
    })
  ],
  
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      format: fileFormat
    })
  ],
  
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
      format: fileFormat
    })
  ]
});

// Add stream for Morgan HTTP logging
logger.stream = {
  write: (message: string) => {
    logger.info(message.trim());
  }
} as any;

export default logger;
