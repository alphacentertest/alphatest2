const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');
const logger = require('./logger'); // Предполагается, что у вас есть настроенный логгер
const AWS = require('aws-sdk');
const { put, get, list } = require('@vercel/blob'); // Убедимся, что используем list напрямую
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const fetch = require('node-fetch');
require('dotenv').config();

// Проверка обязательных переменных окружения
const requiredEnvVars = [
  'REDIS_URL',
  'BLOB_READ_WRITE_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'S3_BUCKET_NAME',
  'ADMIN_PASSWORD_HASH',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Инициализация приложения
const app = express();

app.get('/node-version', (req, res) => {
  res.send(`Node.js version: ${process.version}`);
});

// Настройка Redis с улучшенной обработкой TLS
let redisReady = false;
const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 20000,
  maxRetriesPerRequest: 5,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    logger.info(`Retrying Redis connection, attempt ${times}, delay ${delay}ms`);
    if (times > 10) {
      logger.warn('Failed to connect to Redis after 10 attempts. Proceeding without Redis.', {
        redisUrl: process.env.REDIS_URL,
        status: redis.status,
      });
      redisReady = false;
      return null;
    }
    return delay;
  },
  enableOfflineQueue: true,
  enableReadyCheck: true,
  tls: process.env.REDIS_URL && (process.env.REDIS_URL.includes('upstash.io') || process.env.REDIS_URL.includes('redis-cloud.com'))
    ? {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      }
    : undefined,
});

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

redis.on('ready', () => {
  redisReady = true;
  logger.info('Redis is ready to accept commands');
});

redis.on('error', (err) => {
  redisReady = false;
  logger.error('Redis Client Error:', {
    message: err.message,
    stack: err.stack,
    status: redis.status,
    redisUrl: process.env.REDIS_URL,
  });
});

redis.on('reconnecting', () => {
  redisReady = false;
  logger.warn('Redis reconnecting...');
});

redis.on('end', () => {
  redisReady = false;
  logger.warn('Redis connection closed');
});

// Настройка AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Базовый URL для Vercel Blob Storage
const BLOB_BASE_URL = process.env.BLOB_BASE_URL || 'https://qqeygegbb01p35fz.public.blob.vercel-storage.com';

// Настройка middleware
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet());

// Логирование всех запросов
app.use((req, res, next) => {
  const startTime = Date.now();
  logger.info(`${req.method} ${req.url} - IP: ${req.ip}`);
  res.on('finish', () => {
    logger.info(`${req.method} ${req.url} completed in ${Date.now() - startTime}ms with status ${res.statusCode}`);
  });
  next();
});

// Настройка ограничения скорости для маршрута логина
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много попыток входа, попробуйте снова через 15 минут',
});
app.use('/login', loginLimiter);

// Настройка multer для загрузки файлов
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Глобальные переменные
let validPasswords = {};
let users = [];
let isInitialized = false;
let testNames = {};

// Middleware для проверки инициализации
const ensureInitialized = (req, res, next) => {
  if (!isInitialized) {
    logger.warn('Server is not initialized, rejecting request');
    return res.status(503).json({
      success: false,
      message: 'Сервер не инициализирован. Пожалуйста, попробуйте снова позже.',
    });
  }
  next();
};

// Применяем middleware ко всем маршрутам, кроме /node-version, /, /favicon.ico и /favicon.png
app.use((req, res, next) => {
  if (req.path === '/node-version' || req.path === '/' || req.path === '/favicon.ico' || req.path === '/favicon.png') {
    return next();
  }
  ensureInitialized(req, res, next);
});

// Функция форматирования времени
const formatDuration = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours > 0 ? hours + ' год ' : ''}${minutes > 0 ? minutes + ' хв ' : ''}${secs} с`;
};

// Функция для получения списка файлов из Vercel Blob Storage
const listVercelBlobs = async () => {
  const startTime = Date.now();
  logger.info('Attempting to list blobs from Vercel Blob Storage');
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN is not defined');
    }
    const result = await list({
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    logger.info(`Successfully listed ${result.blobs.length} blobs from Vercel Blob Storage, took ${Date.now() - startTime}ms`);
    return result.blobs || [];
  } catch (error) {
    logger.error(`Failed to list blobs from Vercel Blob Storage, took ${Date.now() - startTime}ms:`, {
      message: error.message,
      stack: error.stack,
      token: process.env.BLOB_READ_WRITE_TOKEN ? 'Token present' : 'Token missing',
    });
    return []; // Возвращаем пустой массив вместо выброса ошибки
  }
};

// Загрузка testNames динамически
const loadTestNames = async () => {
  const startTime = Date.now();
  logger.info('Loading test names dynamically');

  try {
    const blobs = await listVercelBlobs();
    const questionFiles = blobs.filter(blob => blob.pathname.startsWith('questions') && blob.pathname.endsWith('.xlsx'));

    testNames = {};
    questionFiles.forEach((blob, index) => {
      const testNumber = String(index + 1);
      testNames[testNumber] = {
        name: `Тест ${testNumber}`,
        timeLimit: 3600,
        questionsFile: blob.pathname,
      };
    });

    if (redisReady) {
      try {
        await redis.set('testNames', JSON.stringify(testNames));
        logger.info('Cached testNames in Redis');
      } catch (redisError) {
        logger.error(`Error caching testNames in Redis: ${redisError.message}`, { stack: redisError.stack });
      }
    }

    logger.info(`Loaded ${Object.keys(testNames).length} tests dynamically, took ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.error(`Failed to load test names, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
    testNames = {};
  }
};

// Загрузка пользователей из Vercel Blob Storage
const loadUsers = async () => {
  const startTime = Date.now();
  const cacheKey = 'users';
  logger.info('Attempting to load users from Vercel Blob Storage...');

  try {
    if (redisReady) {
      try {
        const cachedUsers = await redis.get(cacheKey);
        if (cachedUsers) {
          logger.info(`Loaded users from Redis cache, took ${Date.now() - startTime}ms`);
          return JSON.parse(cachedUsers);
        }
      } catch (redisError) {
        logger.error(`Error fetching users from Redis cache: ${redisError.message}`, { stack: redisError.stack });
      }
    }

    const blobs = await listVercelBlobs();
    const userFile = blobs.find(blob => blob.pathname.startsWith('users-'));
    if (!userFile) {
      logger.warn('No user file found in Vercel Blob Storage');
      return [];
    }

    const blobUrl = userFile.url;
    logger.info(`Fetching users from URL: ${blobUrl}`);
    const response = await get(blobUrl);
    if (!response.ok) {
      logger.error(`Failed to fetch user file from ${blobUrl}: ${response.statusText}`);
      return [];
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet = workbook.getWorksheet('Users') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      logger.warn('Worksheet "Users" or "Sheet1" not found');
      return [];
    }

    const users = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const username = String(row.getCell(1).value || '').trim();
        const password = String(row.getCell(2).value || '').trim();
        if (username && password) {
          users.push({ username, password });
        }
      }
    });

    if (users.length === 0) {
      logger.warn('No users found in the file');
      return [];
    }

    if (redisReady) {
      try {
        await redis.set(cacheKey, JSON.stringify(users), 'EX', 3600);
        logger.info(`Cached users in Redis`);
      } catch (redisError) {
        logger.error(`Error caching users in Redis: ${redisError.message}`, { stack: redisError.stack });
      }
    }

    logger.info(`Loaded ${users.length} users from Vercel Blob Storage, took ${Date.now() - startTime}ms`);
    return users;
  } catch (error) {
    logger.error(`Error loading users from Blob Storage, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
    return [];
  }
};

// Загрузка вопросов для теста с кэшированием
const loadQuestions = async (questionsFile) => {
  const startTime = Date.now();
  const cacheKey = `questions:${questionsFile}`;
  logger.info(`Loading questions for ${questionsFile}`);

  try {
    if (redisReady) {
      try {
        const cachedQuestions = await redis.get(cacheKey);
        if (cachedQuestions) {
          logger.info(`Loaded ${questionsFile} from Redis cache, took ${Date.now() - startTime}ms`);
          return JSON.parse(cachedQuestions);
        }
      } catch (redisError) {
        logger.error(`Error fetching questions from Redis cache for ${questionsFile}: ${redisError.message}`, { stack: redisError.stack });
      }
    }

    const blobUrl = `${BLOB_BASE_URL}/${questionsFile}`;
    logger.info(`Fetching questions from URL: ${blobUrl}`);
    const response = await get(blobUrl);
    if (!response.ok) {
      logger.error(`Failed to fetch questions file from ${blobUrl}: ${response.statusText}`);
      return [];
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet = workbook.getWorksheet('Questions') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      logger.warn('Worksheet "Questions" or "Sheet1" not found');
      return [];
    }

    const questions = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const question = {
          text: String(row.getCell(1).value || '').trim(),
          picture: row.getCell(2).value ? String(row.getCell(2).value).trim() : null,
          type: String(row.getCell(3).value || 'single').trim().toLowerCase(),
          options: [],
          correctAnswers: [],
          points: parseInt(row.getCell(8).value) || 1,
        };

        for (let i = 4; i <= 7; i++) {
          const option = row.getCell(i).value;
          if (option) question.options.push(String(option).trim());
        }

        const correctAnswer = row.getCell(9).value;
        if (correctAnswer) {
          if (question.type === 'multiple' || question.type === 'ordering') {
            question.correctAnswers = String(correctAnswer).split(',').map(a => a.trim());
          } else {
            question.correctAnswers = [String(correctAnswer).trim()];
          }
        }

        if (question.text) questions.push(question);
      }
    });

    if (questions.length === 0) {
      logger.warn('No questions found in the file');
      return [];
    }

    if (redisReady) {
      try {
        await redis.set(cacheKey, JSON.stringify(questions), 'EX', 3600);
        logger.info(`Cached ${questionsFile} in Redis`);
      } catch (redisError) {
        logger.error(`Error caching questions in Redis for ${questionsFile}: ${redisError.message}`, { stack: redisError.stack });
      }
    }

    logger.info(`Loaded ${questions.length} questions from ${questionsFile}, took ${Date.now() - startTime}ms`);
    return questions;
  } catch (error) {
    logger.error(`Error loading questions from ${questionsFile}, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
    return [];
  }
};

// Получение и установка режима камеры
const getCameraMode = async () => {
  if (redisReady) {
    const mode = await redis.get('cameraMode');
    return mode === 'true';
  }
  return false;
};

const setCameraMode = async (mode) => {
  if (redisReady) {
    await redis.set('cameraMode', String(mode));
  }
};

// Получение и установка данных теста пользователя
const getUserTest = async (user) => {
  if (redisReady) {
    const testData = await redis.hget('userTests', user);
    return testData ? JSON.parse(testData) : null;
  }
  return null;
};

const setUserTest = async (user, testData) => {
  if (redisReady) {
    await redis.hset('userTests', user, JSON.stringify(testData));
  }
};

const deleteUserTest = async (user) => {
  if (redisReady) {
    await redis.hdel('userTests', user);
  }
};

// Сохранение результата теста
const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime, suspiciousBehavior, answers, questions) => {
  if (!redisReady) {
    logger.warn('Redis unavailable, skipping result save');
    return;
  }
  const duration = Math.round((endTime - startTime) / 1000);
  const result = {
    user,
    testNumber,
    score,
    totalPoints,
    duration,
    suspiciousBehavior,
    startTime,
    endTime,
    answers,
    scoresPerQuestion: questions.map((q, idx) => {
      const userAnswer = answers[idx];
      if (!q.options || q.options.length === 0) {
        return userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase() ? q.points : 0;
      } else if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        return correctAnswers.length === userAnswers.length &&
          correctAnswers.every(val => userAnswers.includes(val)) &&
          userAnswers.every(val => correctAnswers.includes(val)) ? q.points : 0;
      } else if (q.type === 'ordering' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        return correctAnswers.length === userAnswers.length &&
          correctAnswers.every((val, idx) => val === userAnswers[idx]) ? q.points : 0;
      } else if (q.type === 'single' && userAnswer) {
        return String(userAnswer).trim() === String(q.correctAnswers[0]).trim() ? q.points : 0;
      }
      return 0;
    }),
  };
  await redis.rpush('test_results', JSON.stringify(result));
};

// Проверка авторизации
const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  if (!user) {
    logger.warn('Unauthorized access attempt');
    return res.redirect('/');
  }
  req.user = user;
  next();
};

// Проверка админ-доступа
const checkAdmin = (req, res, next) => {
  const user = req.cookies.auth;
  if (user !== 'admin') {
    logger.warn(`Unauthorized admin access attempt by user: ${user}`);
    return res.status(403).send('Доступ заборонено. Тільки для адміністратора.');
  }
  req.user = user;
  next();
};

// Инициализация паролей
const initializePasswords = async () => {
  logger.info('Initializing passwords...');
  validPasswords = {};

  // Добавляем пароль администратора
  validPasswords['admin'] = process.env.ADMIN_PASSWORD_HASH;

  // Добавляем пароли пользователей
  users.forEach(user => {
    validPasswords[user.username] = user.password;
  });

  logger.info(`Initialized passwords for ${Object.keys(validPasswords).length} users`);
};

// Инициализация сервера с улучшенным логированием и обработкой ошибок
const initializeServer = async () => {
  const startTime = Date.now();
  logger.info('Starting server initialization...');

  try {
    // Проверяем переменные окружения
    logger.info('Step 1: Checking environment variables...');
    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }
    logger.info('Environment variables checked successfully');

    // Проверяем Redis
    logger.info('Step 2: Attempting to connect to Redis...');
    try {
      const redisTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis connection timed out after 5 seconds')), 5000);
      });

      await Promise.race([
        new Promise((resolve) => {
          if (redisReady) {
            logger.info('Redis already ready');
            resolve();
          } else {
            redis.once('ready', () => {
              logger.info('Redis is ready to accept commands');
              resolve();
            });
            redis.once('error', (error) => {
              logger.error('Redis connection error during initialization:', { message: error.message, stack: error.stack });
              reject(error);
            });
          }
        }),
        redisTimeout,
      ]);
      logger.info('Redis connection established');
    } catch (error) {
      logger.warn('Failed to connect to Redis, proceeding without Redis:', { message: error.message });
      redisReady = false;
    }

    // Загружаем пользователей
    logger.info('Step 3: Attempting to load users from Blob Storage...');
    let usersFromBlob = [];
    try {
      usersFromBlob = await loadUsers();
      logger.info(`Loaded ${usersFromBlob.length} users from Blob Storage`);
      users = usersFromBlob;
    } catch (error) {
      logger.warn('Failed to load users from Blob Storage, proceeding with empty user list:', { message: error.message, stack: error.stack });
      users = [];
    }

    // Инициализируем пароли
    logger.info('Step 4: Initializing passwords...');
    try {
      await initializePasswords();
      logger.info('Passwords initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize passwords:', { message: error.message, stack: error.stack });
      users = [];
    }

    // Загружаем тесты
    logger.info('Step 5: Attempting to load test names...');
    try {
      await loadTestNames();
      logger.info('Test names loaded');
    } catch (error) {
      logger.warn('Failed to load test names, proceeding with empty test list:', { message: error.message, stack: error.stack });
      testNames = {};
    }

    // Загружаем вопросы
    logger.info('Step 6: Attempting to load questions...');
    try {
      const questionPromises = Object.keys(testNames).map(async (key) => {
        const test = testNames[key];
        try {
          logger.info(`Loading questions for test ${key}...`);
          test.questions = await loadQuestions(test.questionsFile);
          if (test.questions.length === 0) {
            logger.warn(`No questions loaded for test ${key}, removing from testNames`);
            delete testNames[key];
          }
        } catch (error) {
          logger.error(`Failed to load questions for test ${key}: ${error.message}`, { stack: error.stack });
          delete testNames[key];
        }
      });

      await Promise.all(questionPromises);
      logger.info('All questions loaded');
    } catch (error) {
      logger.warn('Failed to load questions, proceeding with available tests:', { message: error.message, stack: error.stack });
    }

    if (Object.keys(testNames).length === 0) {
      logger.warn('No tests available after initialization. Server will start, but no tests will be available.');
    }

    isInitialized = true;
    logger.info(`Server initialized successfully, took ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.error(`Unexpected error during server initialization, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
    isInitialized = false;
    throw error; // Бросаем ошибку, чтобы увидеть её в логах Vercel
  }
};

// Главная страница (вход)
app.get('/', async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /');

  try {
    if (!isInitialized) {
      logger.warn('Server is not initialized, rejecting request');
      return res.status(503).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Сервер не готовий</title>
            <style>
              body { font-size: 16px; margin: 20px; text-align: center; }
              h1 { font-size: 24px; margin-bottom: 20px; }
              button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
              button:hover { background-color: #0056b3; }
            </style>
          </head>
          <body>
            <h1>Сервер не готовий</h1>
            <p>Сервер ще ініціалізується. Спробуйте ще раз через кілька секунд.</p>
            <button onclick="window.location.reload()">Оновити сторінку</button>
          </body>
        </html>
      `);
    }

    const user = req.cookies.auth;
    if (user) {
      logger.info(`User already authenticated, redirecting, took ${Date.now() - startTime}ms`);
      return res.redirect(user === 'admin' ? '/admin' : '/select-test');
    }

    const savedPassword = req.cookies.savedPassword || '';
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Вхід</title>
          <style>
            body {
              font-size: 16px;
              margin: 0;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              flex-direction: column;
            }
            .container {
              display: flex;
              flex-direction: column;
              align-items: center;
              width: 100%;
              max-width: 400px;
              padding: 20px;
              box-sizing: border-box;
            }
            h1 {
              font-size: 24px;
              margin-bottom: 20px;
              text-align: center;
            }
            form {
              width: 100%;
              max-width: 300px;
            }
            label {
              display: block;
              margin: 10px 0 5px;
            }
            input[type="text"], input[type="password"] {
              font-size: 16px;
              padding: 5px;
              width: 100%;
              box-sizing: border-box;
            }
            #password {
              background-color: #d3d3d3;
            }
            button {
              font-size: 16px;
              padding: 10px 20px;
              border: none;
              border-radius: 5px;
              background-color: #007bff;
              color: white;
              cursor: pointer;
              margin-top: 10px;
              display: block;
              width: 100%;
            }
            button:hover {
              background-color: #0056b3;
            }
            .error {
              color: red;
              margin-top: 10px;
              text-align: center;
            }
            .password-container {
              position: relative;
            }
            .eye-icon {
              position: absolute;
              right: 10px;
              top: 50%;
              transform: translateY(-50%);
              cursor: pointer;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Вхід</h1>
            <form action="/login" method="POST">
              <label>Пароль:</label>
              <div class="password-container">
                <input type="password" id="password" name="password" value="${savedPassword}" required>
                <span class="eye-icon" onclick="togglePassword()">👁️</span>
              </div>
              <label><input type="checkbox" name="rememberMe"> Запам'ятати пароль</label>
              <button type="submit">Увійти</button>
            </form>
            <p id="error" class="error"></p>
          </div>
          <script>
            function togglePassword() {
              const passwordInput = document.getElementById('password');
              const eyeIcon = document.querySelector('.eye-icon');
              if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                eyeIcon.textContent = '🙈';
              } else {
                passwordInput.type = 'password';
                eyeIcon.textContent = '👁️';
              }
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error(`Error in GET /, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Обработка входа
app.post(
  '/login',
  [
    body('password')
      .trim()
      .notEmpty()
      .withMessage('Пароль не может быть пустым')
      .isLength({ min: 3, max: 50 })
      .withMessage('Пароль должен быть от 3 до 50 символов'),
    body('rememberMe').isBoolean().withMessage('rememberMe должен быть булевым значением'),
  ],
  async (req, res) => {
    const startTime = Date.now();
    logger.info('Handling POST /login');

    try {
      if (!isInitialized) {
        logger.warn('Server not initialized during login attempt');
        return res.status(503).json({ success: false, message: 'Сервер не инициализирован. Спробуйте пізніше.' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Validation errors:', errors.array());
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { password, rememberMe } = req.body;
      logger.info(`Checking password for user input`);

      let authenticatedUser = null;
      for (const [username, storedPassword] of Object.entries(validPasswords)) {
        const isMatch = await bcrypt.compare(password.trim(), storedPassword);
        if (isMatch) {
          authenticatedUser = username;
          break;
        }
      }

      if (!authenticatedUser) {
        logger.warn(`Failed login attempt with password`);
        return res.status(401).json({ success: false, message: 'Невірний пароль' });
      }

      res.cookie('auth', authenticatedUser, {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });

      if (rememberMe) {
        res.cookie('savedPassword', password, {
          maxAge: 30 * 24 * 60 * 60 * 1000,
          httpOnly: false,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
        });
      } else {
        res.clearCookie('savedPassword');
      }

      logger.info(`Successful login for user: ${authenticatedUser}, took ${Date.now() - startTime}ms`);
      if (authenticatedUser === 'admin') {
        res.json({ success: true, redirect: '/admin' });
      } else {
        res.json({ success: true, redirect: '/select-test' });
      }
    } catch (error) {
      logger.error(`Error during login, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
      res.status(500).json({ success: false, message: 'Помилка сервера' });
    }
  }
);

// Выбор теста
app.get('/select-test', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /select-test');

  try {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Вибір тесту</title>
          <style>
            body {
              font-size: 32px;
              margin: 20px;
              text-align: center;
              display: flex;
              flex-direction: column;
              align-items: center;
              min-height: 100vh;
            }
            h1 {
              margin-bottom: 20px;
            }
            .tests {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 10px;
              width: 100%;
              max-width: 500px;
            }
            button {
              font-size: 32px;
              padding: 10px 20px;
              width: 100%;
              border: none;
              border-radius: 5px;
              background-color: #007bff;
              color: white;
              cursor: pointer;
            }
            button:hover {
              background-color: #0056b3;
            }
            @media (max-width: 1024px) {
              body {
                font-size: 48px;
                margin: 30px;
              }
              h1 {
                font-size: 64px;
                margin-bottom: 30px;
              }
              button {
                font-size: 48px;
                padding: 15px 30px;
              }
            }
          </style>
        </head>
        <body>
          <h1>Виберіть тест</h1>
          <div class="tests">
            ${Object.entries(testNames).map(([num, data]) => `
              <button onclick="window.location.href='/test/start?testNumber=${num}'">${data.name}</button>
            `).join('')}
            <button onclick="window.location.href='/logout'">Вийти</button>
          </div>
        </body>
      </html>
    `);
    logger.info(`GET /select-test completed, took ${Date.now() - startTime}ms`);
  } catch (err) {
    logger.error(`Error in GET /select-test, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Начало теста
app.get('/test/start', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /test/start');

  try {
    const { testNumber } = req.query;
    if (!testNumber || !testNames[testNumber]) {
      logger.warn(`Test ${testNumber} not found`);
      return res.status(400).send('Тест не знайдено');
    }

    const questions = await loadQuestions(testNames[testNumber].questionsFile).catch(err => {
      logger.error(`Ошибка загрузки вопросов для теста ${testNumber}, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
      throw err;
    });

    const userTest = {
      testNumber,
      questions,
      answers: Array(questions.length).fill(null),
      startTime: Date.now(),
      currentQuestion: 0,
      suspiciousBehavior: 0,
    };

    await setUserTest(req.user, userTest);
    logger.info(`Test ${testNumber} started for user ${req.user}, took ${Date.now() - startTime}ms`);
    res.redirect('/test/question?index=0');
  } catch (err) {
    logger.error(`Error in GET /test/start, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Страница вопроса
app.get('/test/question', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /test/question');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Test not started for user ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const { questions, testNumber, answers, startTime: testStartTime } = userTest;
    const index = parseInt(req.query.index) || 0;
    if (isNaN(index) || index < 0 || index >= questions.length) {
      logger.warn(`Invalid question index ${index} for user ${req.user}`);
      return res.status(400).send('Невірний номер питання');
    }

    const q = questions[index];
    const progress = questions.map((_, i) => `<span style="display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; margin: 2px; background-color: ${i === index ? '#007bff' : answers[i] ? '#28a745' : '#ccc'}; color: white; font-size: 14px;">${i + 1}</span>`).join('');

    const timeRemaining = testNames[testNumber].timeLimit * 1000 - (Date.now() - testStartTime);
    if (timeRemaining <= 0) {
      logger.info(`Time limit exceeded for user ${req.user}, redirecting to finish`);
      return res.redirect('/test/finish');
    }

    const minutes = Math.floor(timeRemaining / 1000 / 60);
    const seconds = Math.floor((timeRemaining / 1000) % 60);

    const cameraEnabled = await getCameraMode();

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${testNames[testNumber].name}</title>
          <style>
            body {
              font-size: 32px;
              margin: 20px;
              text-align: center;
              display: flex;
              flex-direction: column;
              align-items: center;
              min-height: 100vh;
            }
            h1 {
              margin-bottom: 10px;
            }
            .timer {
              font-size: 32px;
              margin-bottom: 20px;
            }
            .progress {
              margin-bottom: 20px;
            }
            img {
              max-width: 100%;
              height: auto;
              margin-bottom: 20px;
            }
            .question {
              margin-bottom: 20px;
            }
            .options {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 10px;
              margin-bottom: 20px;
            }
            .option {
              font-size: 32px;
              padding: 10px;
              width: 100%;
              max-width: 500px;
              border: 1px solid #ccc;
              border-radius: 5px;
              background-color: #f0f0f0;
              cursor: pointer;
              text-align: left;
            }
            .option.selected {
              background-color: #007bff;
              color: white;
            }
            .option.ordering {
              cursor: move;
            }
            input[type="text"] {
              font-size: 32px;
              padding: 10px;
              width: 100%;
              max-width: 500px;
              margin-bottom: 20px;
              box-sizing: border-box;
            }
            .buttons {
              display: flex;
              justify-content: center;
              gap: 10px;
              width: 100%;
              max-width: 500px;
            }
            button {
              font-size: 32px;
              padding: 10px 20px;
              border: none;
              border-radius: 5px;
              cursor: pointer;
              flex: 1;
            }
            #prevBtn {
              background-color: #6c757d;
              color: white;
            }
            #nextBtn {
              background-color: #007bff;
              color: white;
            }
            button:disabled {
              background-color: #cccccc;
              cursor: not-allowed;
            }
            @media (max-width: 1024px) {
              body {
                font-size: 48px;
                margin: 30px;
              }
              h1 {
                font-size: 42px;
                margin-bottom: 15px;
              }
              .timer {
                font-size: 32px;
                margin-bottom: 30px;
              }
              .progress span {
                width: 40px;
                height: 40px;
                line-height: 40px;
                font-size: 24px;
                margin: 3px;
              }
              .question {
                font-size: 32px;
                margin-bottom: 30px;
              }
              .option {
                font-size: 24px;
                padding: 15px;
                max-width: 100%;
              }
              input[type="text"] {
                font-size: 24px;
                padding: 15px;
                max-width: 100%;
              }
              button {
                font-size: 32px;
                padding: 15px 30px;
              }
            }
          </style>
        </head>
        <body>
          <h1>${testNames[testNumber].name}</h1>
          <div class="timer">Залишилося часу: ${minutes} хв ${seconds} с</div>
          <div class="progress">${progress}</div>
          ${q.picture ? `<img src="${q.picture}" alt="Question Image" onerror="this.src='/images/placeholder.png'">` : ''}
          <div class="question">${q.text}</div>
          <form id="questionForm" method="POST" action="/test/save-answer">
            <input type="hidden" name="index" value="${index}">
            <div class="options" id="options">
              ${q.options && q.options.length > 0 ? q.options.map((option, i) => {
                if (q.type === 'ordering') {
                  const userAnswer = answers[index] || q.options;
                  const idx = userAnswer.indexOf(option);
                  return `<div class="option ordering" draggable="true" data-index="${i}" style="order: ${idx}">${option}</div>`;
                } else {
                  const isSelected = answers[index] && answers[index].includes(String(option));
                  return `
                    <label class="option${isSelected ? ' selected' : ''}">
                      <input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" name="answer" value="${option}" style="display: none;" ${isSelected ? 'checked' : ''}>
                      ${option}
                    </label>
                  `;
                }
              }).join('') : `<input type="text" name="answer" value="${answers[index] || ''}" placeholder="Введіть відповідь">`}
            </div>
            <div class="buttons">
              <button type="button" id="prevBtn" onclick="window.location.href='/test/question?index=${index - 1}'" ${index === 0 ? 'disabled' : ''}>Назад</button>
              <button type="submit" id="nextBtn">${index === questions.length - 1 ? 'Завершити тест' : 'Вперед'}</button>
            </div>
          </form>
          <button onclick="window.location.href='/logout'">Вийти</button>
          <script>
            const optionsDiv = document.getElementById('options');
            const options = optionsDiv.querySelectorAll('.option:not(.ordering)');
            options.forEach(option => {
              option.addEventListener('click', () => {
                const input = option.querySelector('input');
                if (input.type === 'radio') {
                  options.forEach(opt => {
                    opt.classList.remove('selected');
                    opt.querySelector('input').checked = false;
                  });
                  input.checked = true;
                  option.classList.add('selected');
                } else if (input.type === 'checkbox') {
                  input.checked = !input.checked;
                  if (input.checked) {
                    option.classList.add('selected');
                  } else {
                    option.classList.remove('selected');
                  }
                }
              });
            });

            const orderingOptions = optionsDiv.querySelectorAll('.option.ordering');
            let draggedItem = null;
            orderingOptions.forEach(item => {
              item.addEventListener('dragstart', () => {
                draggedItem = item;
                setTimeout(() => item.style.display = 'none', 0);
              });
              item.addEventListener('dragend', () => {
                setTimeout(() => {
                  draggedItem.style.display = 'block';
                  draggedItem = null;
                }, 0);
              });
              item.addEventListener('dragover', e => e.preventDefault());
              item.addEventListener('dragenter', e => e.preventDefault());
              item.addEventListener('drop', () => {
                const allItems = Array.from(orderingOptions);
                const draggedIndex = parseInt(draggedItem.dataset.index);
                const droppedIndex = parseInt(item.dataset.index);
                const newOrder = allItems.map(opt => parseInt(opt.dataset.index));
                newOrder.splice(draggedIndex, 1);
                newOrder.splice(droppedIndex, 0, draggedIndex);
                allItems.forEach((opt, idx) => {
                  opt.style.order = newOrder.indexOf(parseInt(opt.dataset.index));
                });
              });
            });
          </script>
        </body>
      </html>
    `);
    logger.info(`GET /test/question completed, took ${Date.now() - startTime}ms`);
  } catch (err) {
    logger.error(`Error in GET /test/question, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Сохранение ответа
app.post('/test/save-answer', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /test/save-answer');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Test not started for user ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const { index, answer } = req.body;
    const idx = parseInt(index);
    const { questions, answers, testNumber, startTime: testStartTime } = userTest;

    if (isNaN(idx) || idx < 0 || idx >= questions.length) {
      logger.warn(`Invalid question index ${idx} for user ${req.user}`);
      return res.status(400).send('Невірний номер питання');
    }

    const timeRemaining = testNames[testNumber].timeLimit * 1000 - (Date.now() - testStartTime);
    if (timeRemaining <= 0) {
      logger.info(`Time limit exceeded for user ${req.user}, redirecting to finish`);
      return res.redirect('/test/finish');
    }

    const q = questions[idx];
    if (q.type === 'multiple') {
      answers[idx] = Array.isArray(answer) ? answer : [answer].filter(Boolean);
    } else if (q.type === 'ordering') {
      const orderingOptions = req.body.answer || q.options;
      answers[idx] = orderingOptions;
    } else {
      answers[idx] = answer;
    }

    userTest.answers = answers;
    await setUserTest(req.user, userTest);

    if (idx === questions.length - 1) {
      logger.info(`Last question answered by user ${req.user}, redirecting to finish, took ${Date.now() - startTime}ms`);
      return res.redirect('/test/finish');
    } else {
      logger.info(`Answer saved for question ${idx} by user ${req.user}, redirecting to next, took ${Date.now() - startTime}ms`);
      return res.redirect(`/test/question?index=${idx + 1}`);
    }
  } catch (err) {
    logger.error(`Error in POST /test/save-answer, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Завершение теста
app.get('/test/finish', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /test/finish');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Test not started for user ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const { testNumber, questions, answers, startTime: testStartTime, suspiciousBehavior } = userTest;
    const endTime = Date.now();

    let score = 0;
    let totalPoints = 0;
    questions.forEach((q, idx) => {
      const userAnswer = answers[idx];
      let questionScore = 0;
      if (!q.options || q.options.length === 0) {
        if (userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase()) {
          questionScore = q.points;
        }
      } else if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (correctAnswers.length === userAnswers.length &&
            correctAnswers.every(val => userAnswers.includes(val)) &&
            userAnswers.every(val => correctAnswers.includes(val))) {
          questionScore = q.points;
        }
      } else if (q.type === 'ordering' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (correctAnswers.length === userAnswers.length &&
            correctAnswers.every((val, idx) => val === userAnswers[idx])) {
          questionScore = q.points;
        }
      } else if (q.type === 'single' && userAnswer) {
        if (String(userAnswer).trim() === String(q.correctAnswers[0]).trim()) {
          questionScore = q.points;
        }
      }
      score += questionScore;
      totalPoints += q.points;
    });

    await saveResult(req.user, testNumber, score, totalPoints, testStartTime, endTime, suspiciousBehavior, answers, questions);
    await deleteUserTest(req.user);

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Тест завершено</title>
          <style>
            body {
              font-size: 32px;
              margin: 20px;
              text-align: center;
              display: flex;
              flex-direction: column;
              align-items: center;
              min-height: 100vh;
            }
            h1 {
              margin-bottom: 20px;
            }
            p {
              margin: 10px 0;
            }
            button {
              font-size: 32px;
              padding: 10px 20px;
              margin: 20px;
              width: 100%;
              max-width: 300px;
              border: none;
              border-radius: 5px;
              background-color: #007bff;
              color: white;
              cursor: pointer;
            }
            button:hover {
              background-color: #0056b3;
            }
            @media (max-width: 1024px) {
              body {
                font-size: 48px;
                margin: 30px;
              }
              h1 {
                font-size: 64px;
                margin-bottom: 30px;
              }
              p {
                font-size: 48px;
              }
              button {
                font-size: 48px;
                padding: 15px 30px;
                margin: 30px;
                max-width: 100%;
              }
            }
          </style>
        </head>
        <body>
          <h1>Тест завершено</h1>
          <p>Ваш результат: ${score} / ${totalPoints}</p>
          <p>Тривалість: ${formatDuration(Math.round((endTime - testStartTime) / 1000))}</p>
          <p>Підозріла активність: ${Math.round((suspiciousBehavior / (Math.round((endTime - testStartTime) / 1000) || 1)) * 100)}%</p>
          <button onclick="window.location.href='/select-test'">Повернутися до вибору тесту</button>
          <button onclick="window.location.href='/logout'">Вийти</button>
        </body>
      </html>
    `);
    logger.info(`GET /test/finish completed for user ${req.user}, took ${Date.now() - startTime}ms`);
  } catch (err) {
    logger.error(`Error in GET /test/finish, took ${Date.now() - startTime}ms: ${err.message}`, { stack: err.stack });
    res.status(500).send('Помилка сервера');
  }
});

// Маршрут админ-панели
app.get('/admin', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /admin');

  try {
    // Получаем результаты тестов из Redis
    let results = [];
    if (redisReady) {
      results = await redis.lrange('test_results', 0, -1);
      logger.info(`Retrieved ${results.length} test results from Redis`);
    } else {
      logger.warn('Redis is not available, proceeding with empty results');
    }

    // Парсим результаты
    const parsedResults = results.map(r => {
      try {
        return JSON.parse(r);
      } catch (parseError) {
        logger.error(`Failed to parse test result: ${r}`, { error: parseError.message, stack: parseError.stack });
        return null;
      }
    }).filter(result => result !== null);

    // Загружаем вопросы для каждого теста
    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber] && testNames[testNumber]) {
        try {
          questionsByTest[testNumber] = await loadQuestions(testNames[testNumber].questionsFile);
          logger.info(`Loaded questions for test ${testNumber}`);
        } catch (error) {
          logger.error(`Error loading questions for test ${testNumber}: ${error.message}`, { stack: error.stack });
          questionsByTest[testNumber] = [];
        }
      }
    }

    // Получаем состояние камеры заранее
    const cameraMode = await getCameraMode();

    // Формируем HTML-ответ
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Адмін-панель</title>
          <style>
            body { font-size: 16px; margin: 20px; }
            h1 { font-size: 24px; margin-bottom: 20px; }
            .admin-buttons { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
            .admin-buttons button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
            .admin-buttons button:hover { background-color: #0056b3; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
            th { background-color: #f0f0f0; }
            button { font-size: 16px; padding: 5px 10px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
            button:hover { background-color: #0056b3; }
            .answers { display: none; margin-top: 10px; padding: 10px; border: 1px solid #ccc; border-radius: 5px; }
          </style>
        </head>
        <body>
          <h1>Адмін-панель</h1>
          <div class="admin-buttons">
            <button onclick="window.location.href='/admin/create-test'">Створити тест</button>
            <button onclick="window.location.href='/admin/edit-tests'">Редагувати тести</button>
            <button onclick="window.location.href='/admin/view-results'">Перегляд результатів тестів</button>
            <button onclick="deleteResults()">Видалити результати тестів</button>
            <button onclick="toggleCamera()">Камера: ${cameraMode ? 'Вимкнути' : 'Увімкнути'}</button>
            <button onclick="window.location.href='/admin/upload-users'">Завантажити користувачів</button>
            <button onclick="window.location.href='/logout'">Вийти</button>
          </div>
          <h2>Результати тестів</h2>
          <table>
            <thead>
              <tr>
                <th>Користувач</th>
                <th>Тест</th>
                <th>Результат</th>
                <th>Тривалість</th>
                <th>Підозріла активність</th>
                <th>Дата</th>
                <th>Дії</th>
              </tr>
            </thead>
            <tbody>
              ${parsedResults.length === 0 ? `
                <tr>
                  <td colspan="7" style="text-align: center;">Немає результатів тестів</td>
                </tr>
              ` : parsedResults.map((result, idx) => `
                <tr>
                  <td>${result.user || 'Невідомий користувач'}</td>
                  <td>${testNames[result.testNumber]?.name || 'Невідомий тест'}</td>
                  <td>${result.score || 0} / ${result.totalPoints || 0}</td>
                  <td>${formatDuration(result.duration || 0)}</td>
                  <td>${Math.round((result.suspiciousBehavior || 0) / (result.duration || 1)) * 100}%</td>
                  <td>${result.endTime ? new Date(result.endTime).toLocaleString() : 'Невідомо'}</td>
                  <td>
                    <button onclick="toggleAnswers(${idx})">Показати відповіді</button>
                  </td>
                </tr>
                <tr>
                  <td colspan="7">
                    <div id="answers-${idx}" class="answers">
                      ${(result.answers && Array.isArray(result.answers) ? result.answers : []).map((answer, qIdx) => {
                        const question = questionsByTest[result.testNumber]?.[qIdx];
                        if (!question) {
                          return `<p>Питання ${qIdx + 1}: Відповідь: ${answer || 'Немає відповіді'} (Питання не знайдено)</p>`;
                        }
                        const isCorrect = result.scoresPerQuestion && result.scoresPerQuestion[qIdx] > 0;
                        return `
                          <p>
                            Питання ${qIdx + 1}: ${question.text || 'Невідоме питання'}<br>
                            Відповідь: ${Array.isArray(answer) ? answer.join(', ') : (answer || 'Немає відповіді')}<br>
                            Правильна відповідь: ${(question.correctAnswers && Array.isArray(question.correctAnswers) ? question.correctAnswers.join(', ') : 'Невідомо')}<br>
                            Оцінка: ${(result.scoresPerQuestion && result.scoresPerQuestion[qIdx] !== undefined ? result.scoresPerQuestion[qIdx] : 0)} / ${(question.points || 0)} (${isCorrect ? 'Правильно' : 'Неправильно'})
                          </p>
                        `;
                      }).join('')}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <script>
            async function deleteResults() {
              if (confirm('Ви впевнені, що хочете видалити всі результати тестів?')) {
                try {
                  const response = await fetch('/admin/delete-results', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                  });
                  const result = await response.json();
                  if (result.success) {
                    window.location.reload();
                  } else {
                    alert('Помилка при видаленні результатів: ' + result.message);
                  }
                } catch (error) {
                  alert('Помилка при видаленні результатів: ' + error.message);
                }
              }
            }

            async function toggleCamera() {
              try {
                const response = await fetch('/admin/toggle-camera', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                });
                const result = await response.json();
                if (result.success) {
                  window.location.reload();
                } else {
                  alert('Помилка при зміні стану камери: ' + result.message);
                }
              } catch (error) {
                alert('Помилка при зміні стану камери: ' + error.message);
              }
            }

            function toggleAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              if (answersDiv) {
                answersDiv.style.display = answersDiv.style.display === 'block' ? 'none' : 'block';
              }
            }
          </script>
        </body>
      </html>
    `);
    logger.info(`GET /admin completed, took ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.error(`Error in GET /admin: ${error.message}`, { stack: error.stack });
    res.status(500).send('Помилка сервера');
    logger.info(`GET /admin failed, took ${Date.now() - startTime}ms`);
  }
});

// Удаление результатов тестов
app.post('/admin/delete-results', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/delete-results');

try {
  if (redisReady) {
    await redis.del('test_results');
    logger.info('All test results deleted successfully');
    res.json({ success: true, message: 'Результати тестів видалено' });
  } else {
    logger.warn('Redis unavailable, cannot delete test results');
    res.status(503).json({ success: false, message: 'Redis недоступний, не вдалося видалити результати' });
  }
  logger.info(`POST /admin/delete-results completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/delete-results, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).json({ success: false, message: 'Помилка сервера' });
}
});

// Переключение режима камеры
app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/toggle-camera');

try {
  const currentMode = await getCameraMode();
  const newMode = !currentMode;
  await setCameraMode(newMode);
  logger.info(`Camera mode toggled to ${newMode}`);
  res.json({ success: true, message: `Камера ${newMode ? 'увімкнена' : 'вимкнена'}` });
  logger.info(`POST /admin/toggle-camera completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/toggle-camera, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).json({ success: false, message: 'Помилка сервера' });
}
});

// Создание нового теста
app.get('/admin/create-test', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling GET /admin/create-test');

try {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Створити тест</title>
        <style>
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          form { display: flex; flex-direction: column; gap: 10px; max-width: 500px; }
          label { margin-top: 10px; }
          input, select { font-size: 16px; padding: 5px; width: 100%; box-sizing: border-box; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin-top: 10px; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>Створити тест</h1>
        <form action="/admin/create-test" method="POST" enctype="multipart/form-data">
          <label>Назва тесту:</label>
          <input type="text" name="testName" required>
          <label>Ліміт часу (секунд):</label>
          <input type="number" name="timeLimit" value="3600" required>
          <label>Файл з питаннями (.xlsx):</label>
          <input type="file" name="questionsFile" accept=".xlsx" required>
          <button type="submit">Створити тест</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися</button>
      </body>
    </html>
  `);
  logger.info(`GET /admin/create-test completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in GET /admin/create-test, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

app.post('/admin/create-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/create-test');

try {
  const { testName, timeLimit } = req.body;
  const questionsFile = req.file;

  if (!testName || !timeLimit || !questionsFile) {
    logger.warn('Missing required fields in create-test request');
    return res.status(400).send('Усі поля обов’язкові');
  }

  const timeLimitNum = parseInt(timeLimit);
  if (isNaN(timeLimitNum) || timeLimitNum <= 0) {
    logger.warn('Invalid time limit provided');
    return res.status(400).send('Ліміт часу має бути додатним числом');
  }

  // Загружаем файл в Vercel Blob Storage
  const blobPath = `questions-${Date.now()}-${questionsFile.originalname}`;
  const blob = await put(blobPath, fs.createReadStream(questionsFile.path), {
    access: 'public',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  // Добавляем новый тест в testNames
  const newTestNumber = String(Object.keys(testNames).length + 1);
  testNames[newTestNumber] = {
    name: testName,
    timeLimit: timeLimitNum,
    questionsFile: blobPath,
  };

  // Кэшируем обновленные testNames в Redis
  if (redisReady) {
    await redis.set('testNames', JSON.stringify(testNames));
    logger.info('Updated testNames cached in Redis');
  }

  // Удаляем временный файл
  fs.unlinkSync(questionsFile.path);

  logger.info(`Test ${newTestNumber} created successfully`);
  res.redirect('/admin');
  logger.info(`POST /admin/create-test completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/create-test, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

// Редактирование тестов
app.get('/admin/edit-tests', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling GET /admin/edit-tests');

try {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Редагувати тести</title>
        <style>
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
          th { background-color: #f0f0f0; }
          button { font-size: 16px; padding: 5px 10px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
          .delete-btn { background-color: #dc3545; }
          .delete-btn:hover { background-color: #c82333; }
        </style>
      </head>
      <body>
        <h1>Редагувати тести</h1>
        <table>
          <thead>
            <tr>
              <th>Номер тесту</th>
              <th>Назва</th>
              <th>Ліміт часу</th>
              <th>Файл питань</th>
              <th>Дії</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(testNames).map(([num, test]) => `
              <tr>
                <td>${num}</td>
                <td>${test.name}</td>
                <td>${test.timeLimit} с</td>
                <td>${test.questionsFile}</td>
                <td>
                  <button onclick="editTest('${num}')">Редагувати</button>
                  <button class="delete-btn" onclick="deleteTest('${num}')">Видалити</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <button onclick="window.location.href='/admin'">Повернутися</button>
        <script>
          async function editTest(testNumber) {
            window.location.href = '/admin/edit-test?testNumber=' + testNumber;
          }

          async function deleteTest(testNumber) {
            if (confirm('Ви впевнені, що хочете видалити тест ' + testNumber + '?')) {
              const response = await fetch('/admin/delete-test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ testNumber })
              });
              const result = await response.json();
              if (result.success) {
                window.location.reload();
              } else {
                alert('Помилка при видаленні тесту: ' + result.message);
              }
            }
          }
        </script>
      </body>
    </html>
  `);
  logger.info(`GET /admin/edit-tests completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in GET /admin/edit-tests, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

app.get('/admin/edit-test', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling GET /admin/edit-test');

try {
  const { testNumber } = req.query;
  if (!testNumber || !testNames[testNumber]) {
    logger.warn(`Test ${testNumber} not found`);
    return res.status(400).send('Тест не знайдено');
  }

  const test = testNames[testNumber];
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Редагувати тест ${testNumber}</title>
        <style>
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          form { display: flex; flex-direction: column; gap: 10px; max-width: 500px; }
          label { margin-top: 10px; }
          input, select { font-size: 16px; padding: 5px; width: 100%; box-sizing: border-box; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin-top: 10px; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>Редагувати тест ${testNumber}</h1>
        <form action="/admin/edit-test" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="testNumber" value="${testNumber}">
          <label>Назва тесту:</label>
          <input type="text" name="testName" value="${test.name}" required>
          <label>Ліміт часу (секунд):</label>
          <input type="number" name="timeLimit" value="${test.timeLimit}" required>
          <label>Новий файл з питаннями (.xlsx, залиште порожнім, якщо не змінюєте):</label>
          <input type="file" name="questionsFile" accept=".xlsx">
          <button type="submit">Зберегти зміни</button>
        </form>
        <button onclick="window.location.href='/admin/edit-tests'">Повернутися</button>
      </body>
    </html>
  `);
  logger.info(`GET /admin/edit-test completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in GET /admin/edit-test, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

app.post('/admin/edit-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/edit-test');

try {
  const { testNumber, testName, timeLimit } = req.body;
  const questionsFile = req.file;

  if (!testNumber || !testName || !timeLimit || !testNames[testNumber]) {
    logger.warn('Missing required fields or test not found in edit-test request');
    return res.status(400).send('Усі поля обов’язкові або тест не знайдено');
  }

  const timeLimitNum = parseInt(timeLimit);
  if (isNaN(timeLimitNum) || timeLimitNum <= 0) {
    logger.warn('Invalid time limit provided');
    return res.status(400).send('Ліміт часу має бути додатним числом');
  }

  const test = testNames[testNumber];
  test.name = testName;
  test.timeLimit = timeLimitNum;

  if (questionsFile) {
    // Загружаем новый файл в Vercel Blob Storage
    const blobPath = `questions-${Date.now()}-${questionsFile.originalname}`;
    const blob = await put(blobPath, fs.createReadStream(questionsFile.path), {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    // Удаляем старый файл из Vercel Blob Storage (если возможно)
    // Примечание: Vercel Blob Storage не предоставляет прямого метода удаления через API,
    // поэтому это нужно делать вручную или через Vercel CLI.
    logger.info(`Old questions file ${test.questionsFile} should be deleted manually from Vercel Blob Storage`);

    test.questionsFile = blobPath;
    fs.unlinkSync(questionsFile.path);
  }

  // Кэшируем обновленные testNames в Redis
  if (redisReady) {
    await redis.set('testNames', JSON.stringify(testNames));
    logger.info('Updated testNames cached in Redis');
  }

  logger.info(`Test ${testNumber} updated successfully`);
  res.redirect('/admin/edit-tests');
  logger.info(`POST /admin/edit-test completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/edit-test, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

app.post('/admin/delete-test', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/delete-test');

try {
  const { testNumber } = req.body;
  if (!testNumber || !testNames[testNumber]) {
    logger.warn(`Test ${testNumber} not found`);
    return res.status(400).json({ success: false, message: 'Тест не знайдено' });
  }

  const test = testNames[testNumber];
  // Удаляем файл из Vercel Blob Storage (примечание: нужно удалить вручную, так как API не поддерживает удаление)
  logger.info(`Questions file ${test.questionsFile} should be deleted manually from Vercel Blob Storage`);

  // Удаляем тест из testNames
  delete testNames[testNumber];

  // Пересчитываем номера тестов
  const newTestNames = {};
  Object.keys(testNames).sort((a, b) => parseInt(a) - parseInt(b)).forEach((key, index) => {
    const newKey = String(index + 1);
    newTestNames[newKey] = testNames[key];
  });
  testNames = newTestNames;

  // Кэшируем обновленные testNames в Redis
  if (redisReady) {
    await redis.set('testNames', JSON.stringify(testNames));
    logger.info('Updated testNames cached in Redis after deletion');
  }

  logger.info(`Test ${testNumber} deleted successfully`);
  res.json({ success: true, message: 'Тест видалено' });
  logger.info(`POST /admin/delete-test completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/delete-test, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).json({ success: false, message: 'Помилка сервера' });
}
});

// Загрузка пользователей
app.get('/admin/upload-users', checkAdmin, async (req, res) => {
const startTime = Date.now();
logger.info('Handling GET /admin/upload-users');

try {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Завантажити користувачів</title>
        <style>
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          form { display: flex; flex-direction: column; gap: 10px; max-width: 500px; }
          label { margin-top: 10px; }
          input { font-size: 16px; padding: 5px; width: 100%; box-sizing: border-box; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin-top: 10px; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>Завантажити користувачів</h1>
        <form action="/admin/upload-users" method="POST" enctype="multipart/form-data">
          <label>Файл з користувачами (.xlsx):</label>
          <input type="file" name="usersFile" accept=".xlsx" required>
          <button type="submit">Завантажити</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися</button>
      </body>
    </html>
  `);
  logger.info(`GET /admin/upload-users completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in GET /admin/upload-users, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

app.post('/admin/upload-users', checkAdmin, upload.single('usersFile'), async (req, res) => {
const startTime = Date.now();
logger.info('Handling POST /admin/upload-users');

try {
  const usersFile = req.file;
  if (!usersFile) {
    logger.warn('No users file uploaded');
    return res.status(400).send('Файл з користувачами обов’язковий');
  }

  // Загружаем файл в Vercel Blob Storage
  const blobPath = `users-${Date.now()}-${usersFile.originalname}`;
  const blob = await put(blobPath, fs.createReadStream(usersFile.path), {
    access: 'public',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  // Удаляем старые файлы пользователей из Vercel Blob Storage (примечание: нужно удалить вручную)
  const blobs = await listVercelBlobs();
  const oldUserFiles = blobs.filter(blob => blob.pathname.startsWith('users-') && blob.pathname !== blobPath);
  oldUserFiles.forEach(file => {
    logger.info(`Old users file ${file.pathname} should be deleted manually from Vercel Blob Storage`);
  });

  // Обновляем список пользователей
  users = await loadUsers();
  await initializePasswords();

  // Удаляем временный файл
  fs.unlinkSync(usersFile.path);

  logger.info('Users uploaded and updated successfully');
  res.redirect('/admin');
  logger.info(`POST /admin/upload-users completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in POST /admin/upload-users, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

// Маршрут для выхода
app.get('/logout', (req, res) => {
const startTime = Date.now();
logger.info('Handling GET /logout');

try {
  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  logger.info('User logged out successfully');
  res.redirect('/');
  logger.info(`GET /logout completed, took ${Date.now() - startTime}ms`);
} catch (error) {
  logger.error(`Error in GET /logout, took ${Date.now() - startTime}ms: ${error.message}`, { stack: error.stack });
  res.status(500).send('Помилка сервера');
}
});

// Обработка favicon.ico и favicon.png
app.get('/favicon.ico', (req, res) => {
res.status(204).end();
});

app.get('/favicon.png', (req, res) => {
res.status(204).end();
});

// Обработка несуществующих маршрутов
app.use((req, res) => {
const startTime = Date.now();
logger.warn(`404 Not Found: ${req.method} ${req.url}`);
res.status(404).send(`
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>404 - Сторінка не знайдена</title>
      <style>
        body { font-size: 16px; margin: 20px; text-align: center; }
        h1 { font-size: 24px; margin-bottom: 20px; }
        button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
        button:hover { background-color: #0056b3; }
      </style>
    </head>
    <body>
      <h1>404 - Сторінка не знайдена</h1>
      <p>Сторінка, яку ви шукаєте, не існує.</p>
      <button onclick="window.location.href='/'">Повернутися на головну</button>
    </body>
  </html>
`);
logger.info(`404 handler completed, took ${Date.now() - startTime}ms`);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
const startServer = async () => {
try {
  await initializeServer();
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
  });
} catch (error) {
  logger.error('Failed to start server:', { message: error.message, stack: error.stack });
  process.exit(1);
}
};

startServer();

// Обработка непредвиденных ошибок
process.on('uncaughtException', (error) => {
logger.error('Uncaught Exception:', { message: error.message, stack: error.stack });
process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
logger.error('Unhandled Rejection at:', { promise, reason: reason instanceof Error ? reason.message : reason, stack: reason instanceof Error ? reason.stack : undefined });
process.exit(1);
});
