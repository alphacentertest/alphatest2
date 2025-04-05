// logger.js
const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Используем /tmp для хранения логов
const logDir = '/tmp/logs';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
    new winston.transports.Console(),
  ],
});

// Создаём директорию /tmp/logs, если она не существует
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

module.exports = logger;