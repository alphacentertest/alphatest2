// Імпорт необхідних модулів
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs').promises; // Асинхронні методи fs
const fsSync = require('fs'); // Синхронні методи fs
const Redis = require('ioredis');
const logger = require(path.join(__dirname, 'logger'));
const AWS = require('aws-sdk');
const { put, list } = require('@vercel/blob');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const xss = require('xss');
const csrf = require('csurf');
const session = require('express-session');
const RedisStore = require('connect-redis').default; // Новий синтаксис для connect-redis@7.x
require('dotenv').config();

// Перевірка необхідних змінних середовища
const requiredEnvVars = [
  'REDIS_URL',
  'BLOB_READ_WRITE_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'S3_BUCKET_NAME',
  'ADMIN_PASSWORD_HASH',
  'SESSION_SECRET',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Відсутня необхідна змінна середовища: ${envVar}`);
    process.exit(1);
  }
}

// Ініціалізація Express додатку
const app = express();

// Ендпоінт для перевірки версії Node.js
app.get('/node-version', (req, res) => {
  res.send(`Версія Node.js: ${process.version}`);
});

// Налаштування Redis з покращеною обробкою помилок
let redisReady = false;
const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 20000,
  maxRetriesPerRequest: 5,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    logger.info(`Спроба підключення до Redis, спроба ${times}, затримка ${delay}мс`);
    if (times > 10) {
      logger.warn('Не вдалося підключитися до Redis після 10 спроб. Продовжуємо без Redis.', {
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
  keepAlive: 30000,
  tls: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined,
  },
});

// Функція для очікування підключення до Redis
const waitForRedis = () => {
  return new Promise((resolve, reject) => {
    if (redisReady) {
      resolve();
      return;
    }

    redis.on('ready', () => {
      redisReady = true;
      logger.info('Redis готовий приймати команди');
      resolve();
    });

    redis.on('error', (err) => {
      redisReady = false;
      logger.error('Помилка Redis:', {
        message: err.message,
        stack: err.stack,
        status: redis.status,
        redisUrl: process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:[^@]+@/, ':<password>@') : 'Не встановлено',
        tlsConfig: redis.options.tls || 'Не встановлено',
      });
      reject(err);
    });

    redis.on('connect', () => {
      logger.info('Redis успішно підключений');
    });

    redis.on('reconnecting', () => {
      redisReady = false;
      logger.warn('Redis пере підключенням...');
    });

    redis.on('end', () => {
      redisReady = false;
      logger.warn('З’єднання з Redis закрито');
    });
  });
};

// Обробники подій Redis
redis.on('connect', () => {
  logger.info('Redis успішно підключений');
});

redis.on('ready', () => {
  redisReady = true;
  logger.info('Redis готовий приймати команди');
});

redis.on('error', err => {
  redisReady = false;
  logger.error('Помилка Redis:', {
    message: err.message,
    stack: err.stack,
    status: redis.status,
    redisUrl: process.env.REDIS_URL
      ? process.env.REDIS_URL.replace(/:[^@]+@/, ':<password>@')
      : 'Не встановлено',
    tlsConfig: redis.options.tls || 'Не встановлено',
  });
});

redis.on('reconnecting', () => {
  redisReady = false;
  logger.warn('Redis пере підключенням...');
});

redis.on('end', () => {
  redisReady = false;
  logger.warn('З’єднання з Redis закрито');
});

// Налаштування AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Базовий URL для Vercel Blob Storage
const BLOB_BASE_URL =
  process.env.BLOB_BASE_URL ||
  'https://qqeygegbb01p35fz.public.blob.vercel-storage.com';

// Динамічний імпорт для node-fetch
const getFetch = async () => {
  const { default: fetch } = await import('node-fetch');
  return fetch;
};

// Налаштування middleware
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet());

// Налаштування сесій
const sessionOptions = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 години
    sameSite: 'lax',
  },
};

// Очікуємо підключення до Redis перед налаштуванням сесій
(async () => {
  try {
    await waitForRedis();
    app.use(session({
      ...sessionOptions,
      store: new RedisStore({ client: redis }),
    }));
  } catch (error) {
    logger.warn('Redis недоступний, використовуємо пам’ять для зберігання сесій');
    app.use(session(sessionOptions));
  }
})();

// Якщо Redis доступний, використовуємо RedisStore, інакше пам’ять
if (redisReady) {
  app.use(
    session({
      ...sessionOptions,
      store: new RedisStore({ client: redis }),
    })
  );
} else {
  logger.warn('Redis недоступний, використовуємо пам’ять для зберігання сесій');
  app.use(session(sessionOptions));
}

// Налаштування CSRF-захисту
const csrfProtection = csrf({ cookie: false });
app.use(csrfProtection);

// Логування запитів та фільтрація XSS
app.use((req, res, next) => {
  const startTime = Date.now();
  logger.info(`${req.method} ${req.url} - IP: ${req.ip}`);

  // Фільтрація XSS для параметрів запиту
  for (const key in req.query) {
    if (typeof req.query[key] === 'string') {
      req.query[key] = xss(req.query[key]);
    }
  }

  // Фільтрація XSS для тіла запиту
  for (const key in req.body) {
    if (typeof req.body[key] === 'string') {
      req.body[key] = xss(req.body[key]);
    }
  }

  res.on('finish', () => {
    logger.info(
      `${req.method} ${req.url} завершено за ${Date.now() - startTime}мс зі статусом ${res.statusCode}`
    );
  });
  next();
});

// Обмеження кількості запитів для маршруту входу
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Занадто багато спроб входу, спробуйте знову через 15 хвилин',
});
app.use('/login', loginLimiter);

// Налаштування Multer для завантаження файлів
const uploadDir = '/tmp/uploads';
if (!fsSync.existsSync(uploadDir)) {
  fsSync.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname)
    );
  },
});
const upload = multer({ storage });

// Глобальні змінні
let validPasswords = {};
let users = [];
let isInitialized = false;
let testNames = {};
let questionsByTestCache = {};

// Middleware для перевірки ініціалізації сервера
const ensureInitialized = (req, res, next) => {
  if (!isInitialized) {
    logger.warn('Сервер не ініціалізований, відхиляємо запит');
    return res.status(503).json({
      success: false,
      message: 'Сервер не ініціалізований. Спробуйте знову пізніше.',
    });
  }
  next();
};

// Застосовуємо middleware ініціалізації до всіх маршрутів, крім винятків
app.use((req, res, next) => {
  if (
    req.path === '/node-version' ||
    req.path === '/' ||
    req.path === '/favicon.ico' ||
    req.path === '/favicon.png'
  ) {
    return next();
  }
  ensureInitialized(req, res, next);
});

// Функція для форматування тривалості
const formatDuration = seconds => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours > 0 ? hours + ' год ' : ''}${minutes > 0 ? minutes + ' хв ' : ''}${secs} с`;
};

// Список файлів з Vercel Blob Storage
const listVercelBlobs = async () => {
  try {
    logger.info('Спроба отримати список файлів з Vercel Blob Storage');
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('BLOB_READ_WRITE_TOKEN не визначений');
    }
    const result = await list({
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    logger.info(
      `Успішно отримано ${result.blobs.length} файлів з Vercel Blob Storage`
    );
    return result.blobs || [];
  } catch (error) {
    logger.error('Не вдалося отримати список файлів з Vercel Blob Storage:', {
      message: error.message,
      stack: error.stack,
      token: process.env.BLOB_READ_WRITE_TOKEN
        ? 'Токен присутній'
        : 'Токен відсутній',
    });
    throw error;
  }
};

// Завантаження назв тестів динамічно
const loadTestNames = async () => {
  const startTime = Date.now();
  logger.info('Завантаження назв тестів динамічно');

  try {
    const blobs = await listVercelBlobs();
    const questionFiles = blobs.filter(
      blob =>
        blob.pathname.startsWith('questions') && blob.pathname.endsWith('.xlsx')
    );

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
        logger.info('Назви тестів збережено в Redis');
      } catch (redisError) {
        logger.error(
          `Помилка збереження назв тестів у Redis: ${redisError.message}`,
          { stack: redisError.stack }
        );
      }
    }

    logger.info(
      `Завантажено ${Object.keys(testNames).length} тестів динамічно, тривалість ${Date.now() - startTime}мс`
    );
  } catch (error) {
    logger.error(
      `Не вдалося завантажити назви тестів, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    testNames = {};
  }
};

// Завантаження користувачів з Vercel Blob Storage
const loadUsers = async () => {
  const startTime = Date.now();
  const cacheKey = 'users';
  logger.info('Спроба завантаження користувачів з Vercel Blob Storage...');

  try {
    if (redisReady) {
      try {
        const cachedUsers = await redis.get(cacheKey);
        if (cachedUsers) {
          logger.info(
            `Користувачі завантажені з кешу Redis, тривалість ${Date.now() - startTime}мс`
          );
          return JSON.parse(cachedUsers);
        }
      } catch (redisError) {
        logger.error(
          `Помилка отримання користувачів з кешу Redis: ${redisError.message}`,
          { stack: redisError.stack }
        );
      }
    } else {
      logger.warn('Redis недоступний, пропускаємо перевірку кешу');
    }

    const blobs = await listVercelBlobs();
    const userFile = blobs.find(blob => blob.pathname.startsWith('users-'));
    if (!userFile) {
      logger.warn('Файл користувачів не знайдено у Vercel Blob Storage');
      return [];
    }

    const blobUrl = userFile.url;
    logger.info(`Завантаження користувачів з URL: ${blobUrl}`);
    const fetch = await getFetch();
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(
        `Не вдалося завантажити файл ${blobUrl}: ${response.statusText}`
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet =
      workbook.getWorksheet('Users') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      logger.warn('Аркуш "Users" або "Sheet1" не знайдено');
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
      logger.warn('Користувачів у файлі не знайдено');
      return [];
    }

    if (redisReady) {
      try {
        await redis.set(cacheKey, JSON.stringify(users), 'EX', 3600);
        logger.info(`Користувачі збережені в кеш Redis`);
      } catch (redisError) {
        logger.error(
          `Помилка збереження користувачів у Redis: ${redisError.message}`,
          { stack: redisError.stack }
        );
      }
    } else {
      logger.warn('Redis недоступний, пропускаємо збереження в кеш');
    }

    logger.info(
      `Завантажено ${users.length} користувачів з Vercel Blob Storage, тривалість ${Date.now() - startTime}мс`
    );
    return users;
  } catch (error) {
    logger.error(
      `Помилка завантаження користувачів з Blob Storage, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    return [];
  }
};

// Завантаження питань для тесту з кешуванням
const loadQuestions = async questionsFile => {
  const startTime = Date.now();
  const cacheKey = `questions:${questionsFile}`;
  logger.info(`Завантаження питань для ${questionsFile}`);

  if (questionsByTestCache[questionsFile]) {
    logger.info(
      `Питання для ${questionsFile} завантажені з кешу програми, тривалість ${Date.now() - startTime}мс`
    );
    return questionsByTestCache[questionsFile];
  }

  try {
    if (redisReady) {
      try {
        const cachedQuestions = await redis.get(cacheKey);
        if (cachedQuestions) {
          logger.info(
            `Питання для ${questionsFile} завантажені з кешу Redis, тривалість ${Date.now() - startTime}мс`
          );
          const questions = JSON.parse(cachedQuestions);
          questionsByTestCache[questionsFile] = questions;
          return questions;
        }
      } catch (redisError) {
        logger.error(
          `Помилка отримання питань з кешу Redis для ${questionsFile}: ${redisError.message}`,
          { stack: redisError.stack }
        );
      }
    }

    const blobUrl = `${BLOB_BASE_URL}/${questionsFile}`;
    logger.info(`Завантаження питань з URL: ${blobUrl}`);
    const fetch = await getFetch();
    const response = await fetch(blobUrl);
    if (!response.ok) {
      throw new Error(
        `Не вдалося завантажити файл ${blobUrl}: ${response.statusText}`
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet =
      workbook.getWorksheet('Questions') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      logger.warn('Аркуш "Questions" або "Sheet1" не знайдено');
      return [];
    }

    const questions = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const question = {
          text: String(row.getCell(1).value || '').trim(),
          picture: row.getCell(2).value
            ? String(row.getCell(2).value).trim()
            : null,
          type: String(row.getCell(3).value || 'single')
            .trim()
            .toLowerCase(),
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
            question.correctAnswers = String(correctAnswer)
              .split(',')
              .map(a => a.trim());
          } else {
            question.correctAnswers = [String(correctAnswer).trim()];
          }
        }

        if (question.text) questions.push(question);
      }
    });

    if (questions.length === 0) {
      logger.warn('Питань у файлі не знайдено');
      return [];
    }

    if (redisReady) {
      try {
        await redis.set(cacheKey, JSON.stringify(questions), 'EX', 3600);
        logger.info(`Питання для ${questionsFile} збережені в кеш Redis`);
      } catch (redisError) {
        logger.error(
          `Помилка збереження питань у Redis для ${questionsFile}: ${redisError.message}`,
          { stack: redisError.stack }
        );
      }
    }

    questionsByTestCache[questionsFile] = questions;
    logger.info(
      `Завантажено ${questions.length} питань з ${questionsFile}, тривалість ${Date.now() - startTime}мс`
    );
    return questions;
  } catch (error) {
    logger.error(
      `Помилка завантаження питань з ${questionsFile}, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    return [];
  }
};

// Управління даними тесту користувача з Redis
const getUserTest = async user => {
  if (!redisReady) {
    logger.warn('Redis недоступний, не можемо отримати тест користувача');
    return null;
  }
  try {
    const testData = await redis.hget('userTests', user);
    return testData ? JSON.parse(testData) : null;
  } catch (error) {
    logger.error(
      `Помилка отримання тесту користувача з Redis: ${error.message}`,
      { stack: error.stack }
    );
    return null;
  }
};

const setUserTest = async (user, testData) => {
  if (!redisReady) {
    logger.warn('Redis недоступний, не можемо зберегти тест користувача');
    return;
  }
  try {
    await redis.hset('userTests', user, JSON.stringify(testData));
  } catch (error) {
    logger.error(
      `Помилка збереження тесту користувача в Redis: ${error.message}`,
      { stack: error.stack }
    );
  }
};

const deleteUserTest = async user => {
  if (!redisReady) {
    logger.warn('Redis недоступний, не можемо видалити тест користувача');
    return;
  }
  try {
    await redis.hdel('userTests', user);
  } catch (error) {
    logger.error(
      `Помилка видалення тесту користувача з Redis: ${error.message}`,
      { stack: error.stack }
    );
  }
};

// Збереження результату тесту з Redis
const saveResult = async (
  user,
  testNumber,
  score,
  totalPoints,
  startTime,
  endTime,
  suspiciousBehavior,
  answers,
  questions
) => {
  if (!redisReady) {
    logger.warn('Redis недоступний, пропускаємо збереження результату');
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
        return userAnswer &&
          String(userAnswer).trim().toLowerCase() ===
            String(q.correctAnswers[0]).trim().toLowerCase()
          ? q.points
          : 0;
      } else if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        return correctAnswers.length === userAnswers.length &&
          correctAnswers.every(val => userAnswers.includes(val)) &&
          userAnswers.every(val => correctAnswers.includes(val))
          ? q.points
          : 0;
      } else if (q.type === 'ordering' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        return correctAnswers.length === userAnswers.length &&
          correctAnswers.every((val, idx) => val === userAnswers[idx])
          ? q.points
          : 0;
      } else if (q.type === 'single' && userAnswer) {
        return String(userAnswer).trim() === String(q.correctAnswers[0]).trim()
          ? q.points
          : 0;
      }
      return 0;
    }),
  };
  try {
    await redis.rpush('test_results', JSON.stringify(result));
  } catch (error) {
    logger.error(
      `Помилка збереження результату тесту в Redis: ${error.message}`,
      { stack: error.stack }
    );
  }
};

// Middleware для перевірки авторизації через сесію
const checkAuth = (req, res, next) => {
  if (!req.session.user) {
    logger.warn('Спроба несанкціонованого доступу');
    return res.redirect('/');
  }
  req.user = req.session.user;
  next();
};

// Middleware для перевірки адмін-доступу через сесію
const checkAdmin = (req, res, next) => {
  if (!req.session.user || req.session.user !== 'admin') {
    logger.warn(
      `Спроба несанкціонованого доступу до адмін-панелі користувачем: ${req.session.user || 'невідомий'}`
    );
    return res
      .status(403)
      .send('Доступ заборонено. Тільки для адміністратора.');
  }
  req.user = req.session.user;
  next();
};

// Ініціалізація паролів
const initializePasswords = async () => {
  logger.info('Ініціалізація паролів...');
  validPasswords = {};

  validPasswords['admin'] = process.env.ADMIN_PASSWORD_HASH;

  users.forEach(user => {
    validPasswords[user.username] = user.password;
  });

  logger.info(
    `Ініціалізовано паролі для ${Object.keys(validPasswords).length} користувачів`
  );
};

// Ініціалізація сервера
const initializeServer = async () => {
  logger.info('Початок ініціалізації сервера...');
  logger.info('Перевірка змінних середовища...');
  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      logger.error(`Відсутня необхідна змінна середовища: ${envVar}`);
      process.exit(1);
    }
  }

  logger.info('Спроба підключення до Redis...');
  try {
    await redis.ping();
    logger.info('Підключення до Redis успішне');
  } catch (error) {
    logger.error('Не вдалося підключитися до Redis:', { message: error.message, stack: error.stack });
    redisReady = false;
  }

  logger.info('Завантаження назв тестів...');
  try {
    if (redisReady) {
      const testNamesData = await redis.get('testNames');
      if (testNamesData) {
        testNames = JSON.parse(testNamesData);
        logger.info('Назви тестів завантажені з Redis');
      } else {
        await loadTestNames();
      }
    } else {
      await loadTestNames();
    }
  } catch (error) {
    logger.error('Не вдалося завантажити назви тестів:', { message: error.message, stack: error.stack });
    testNames = {}; // Продовжуємо роботу, навіть якщо тесты не загрузились
  }

  logger.info('Завантаження користувачів...');
  try {
    users = await loadUsers();
    await initializePasswords();
  } catch (error) {
    logger.error('Не вдалося завантажити користувачів:', { message: error.message, stack: error.stack });
    users = []; // Продовжуємо роботу, навіть якщо користувачі не загрузились
  }

  logger.info('Ініціалізація сервера завершена');
  isInitialized = true;
};

// Головна сторінка (вхід)
app.get('/', async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /');

  try {
    if (!isInitialized) {
      logger.warn('Сервер не ініціалізований, відхиляємо запит');
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

    if (req.session.user) {
      logger.info(
        `Користувач уже авторизований, перенаправляємо, тривалість ${Date.now() - startTime}мс`
      );
      return res.redirect(
        req.session.user === 'admin' ? '/admin' : '/select-test'
      );
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
              font-size: 14px;
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
              <input type="hidden" name="_csrf" value="${req.csrfToken()}">
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

            // Відображення повідомлення про помилку, якщо перенаправлено назад з помилкою
            const urlParams = new URLSearchParams(window.location.search);
            const error = urlParams.get('error');
            if (error) {
              document.getElementById('error').textContent = decodeURIComponent(error);
            }
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    logger.error(
      `Помилка в GET /, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Обробка входу
app.post(
  '/login',
  [
    body('password')
      .trim()
      .notEmpty()
      .withMessage('Пароль не може бути порожнім')
      .isLength({ min: 3, max: 50 })
      .withMessage('Пароль має бути від 3 до 50 символів'),
    body('rememberMe')
      .isBoolean()
      .withMessage('rememberMe має бути булевим значенням'),
  ],
  async (req, res) => {
    const startTime = Date.now();
    logger.info('Обробка POST /login');

    try {
      if (!isInitialized) {
        logger.warn('Сервер не ініціалізований під час спроби входу');
        return res.redirect(
          '/?error=' +
            encodeURIComponent('Сервер не ініціалізований. Спробуйте пізніше.')
        );
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Помилки валідації:', errors.array());
        return res.redirect(
          '/?error=' + encodeURIComponent(errors.array()[0].msg)
        );
      }

      const { password, rememberMe } = req.body;
      logger.info(`Перевірка пароля для введених даних`);

      let authenticatedUser = null;
      for (const [username, storedPassword] of Object.entries(validPasswords)) {
        const isMatch = await bcrypt.compare(password.trim(), storedPassword);
        if (isMatch) {
          authenticatedUser = username;
          break;
        }
      }

      if (!authenticatedUser) {
        logger.warn(`Невдала спроба входу з паролем`);
        return res.redirect('/?error=' + encodeURIComponent('Невірний пароль'));
      }

      req.session.user = authenticatedUser;

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

      logger.info(
        `Успішний вхід для користувача: ${authenticatedUser}, тривалість ${Date.now() - startTime}мс`
      );
      res.redirect(authenticatedUser === 'admin' ? '/admin' : '/select-test');
    } catch (error) {
      logger.error(
        `Помилка під час входу, тривалість ${Date.now() - startTime}мс: ${error.message}`,
        { stack: error.stack }
      );
      res.redirect('/?error=' + encodeURIComponent('Помилка сервера'));
    }
  }
);

// Ендпоінт для перевірки стану сервера
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /health');

  try {
    const redisStatus = redisReady ? 'Підключений' : 'Відключений';
    let redisPing = 'Не перевірено';
    if (redisReady) {
      redisPing = await redis.ping();
    }

    res.status(200).json({
      status: 'OK',
      redis: {
        status: redisStatus,
        ping: redisPing,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    logger.info(
      `GET /health завершено, тривалість ${Date.now() - startTime}мс`
    );
  } catch (error) {
    logger.error(
      `Помилка в GET /health, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res.status(500).json({
      status: 'Помилка',
      message: 'Перевірка стану не вдалася',
      error: error.message,
    });
  }
});

// Сторінка вибору тесту
app.get('/select-test', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /select-test');

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
            ${Object.entries(testNames)
              .map(
                ([num, data]) => `
              <button onclick="window.location.href='/test/start?testNumber=${num}'">${data.name}</button>
            `
              )
              .join('')}
            <button onclick="window.location.href='/logout'">Вийти</button>
          </div>
        </body>
      </html>
    `);
    logger.info(
      `GET /select-test завершено, тривалість ${Date.now() - startTime}мс`
    );
  } catch (err) {
    logger.error(
      `Помилка в GET /select-test, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Тестовий маршрут для перевірки Redis
app.get('/test-redis', async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /test-redis');

  try {
    if (!redisReady) {
      throw new Error('Redis недоступний');
    }
    await redis.set('test-key', 'test-value');
    const value = await redis.get('test-key');
    res.status(200).json({
      status: 'OK',
      redisStatus: 'Підключений',
      testValue: value,
      timestamp: new Date().toISOString(),
    });
    logger.info(`GET /test-redis завершено, тривалість ${Date.now() - startTime}мс`);
  } catch (error) {
    logger.error(`Помилка в GET /test-redis: ${error.message}`, { stack: error.stack });
    res.status(500).json({
      status: 'Помилка',
      message: 'Не вдалося підключитися до Redis',
      error: error.message,
    });
  }
});

// Початок тесту
app.get('/test/start', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /test/start');

  try {
    const { testNumber } = req.query;
    if (!testNumber || !testNames[testNumber]) {
      logger.warn(`Тест ${testNumber} не знайдено`);
      return res.status(400).send('Тест не знайдено');
    }

    const questions = await loadQuestions(
      testNames[testNumber].questionsFile
    ).catch(err => {
      logger.error(
        `Помилка завантаження питань для тесту ${testNumber}, тривалість ${Date.now() - startTime}мс: ${err.message}`,
        { stack: err.stack }
      );
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
    logger.info(
      `Тест ${testNumber} розпочато для користувача ${req.user}, тривалість ${Date.now() - startTime}мс`
    );
    res.redirect('/test/question?index=0');
  } catch (err) {
    logger.error(
      `Помилка в GET /test/start, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Сторінка з питанням та відстеженням підозрілої активності
app.get('/test/question', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /test/question');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Тест не розпочато для користувача ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const {
      questions,
      testNumber,
      answers,
      startTime: testStartTime,
    } = userTest;
    const index = parseInt(req.query.index) || 0;
    if (isNaN(index) || index < 0 || index >= questions.length) {
      logger.warn(
        `Невірний індекс питання ${index} для користувача ${req.user}`
      );
      return res.status(400).send('Невірний номер питання');
    }

    const q = questions[index];
    const progress = questions
      .map(
        (_, i) =>
          `<span style="display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; margin: 2px; background-color: ${i === index ? '#007bff' : answers[i] ? '#28a745' : '#ccc'}; color: white; font-size: 14px;">${i + 1}</span>`
      )
      .join('');

    const timeRemaining =
      testNames[testNumber].timeLimit * 1000 - (Date.now() - testStartTime);
    if (timeRemaining <= 0) {
      logger.info(
        `Часовий ліміт вичерпано для користувача ${req.user}, перенаправляємо на завершення`
      );
      return res.redirect('/test/finish');
    }

    const minutes = Math.floor(timeRemaining / 1000 / 60);
    const seconds = Math.floor((timeRemaining / 1000) % 60);

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
          ${q.picture ? `<img src="${q.picture}" alt="Зображення питання" onerror="this.src='/images/placeholder.png'">` : ''}
          <div class="question">${q.text}</div>
          <form id="questionForm" method="POST" action="/test/save-answer">
            <input type="hidden" name="_csrf" value="${req.csrfToken()}">
            <input type="hidden" name="index" value="${index}">
            <div class="options" id="options">
              ${
                q.options && q.options.length > 0
                  ? q.options
                      .map((option, i) => {
                        if (q.type === 'ordering') {
                          const userAnswer = answers[index] || q.options;
                          const idx = userAnswer.indexOf(option);
                          return `<div class="option ordering" draggable="true" data-index="${i}" style="order: ${idx}">${option}</div>`;
                        } else {
                          const isSelected =
                            answers[index] &&
                            answers[index].includes(String(option));
                          return `
                    <label class="option${isSelected ? ' selected' : ''}">
                      <input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" name="answer" value="${option}" style="display: none;" ${isSelected ? 'checked' : ''}>
                      ${option}
                    </label>
                  `;
                        }
                      })
                      .join('')
                  : `<input type="text" name="answer" value="${answers[index] || ''}" placeholder="Введіть відповідь">`
              }
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

            // Відстеження підозрілої активності (перемикання вкладок або згортання вікна)
            let hasReported = false; // Запобігаємо множинним звітам поспіль
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'hidden' && !hasReported) {
                hasReported = true;
                fetch('/report-suspicious', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.csrfToken()}'
                  },
                })
                .then(response => response.json())
                .then(data => {
                  if (!data.success) {
                    console.error('Не вдалося повідомити про підозрілу активність:', data.message);
                  }
                })
                .catch(error => {
                  console.error('Помилка при повідомленні про підозрілу активність:', error);
                })
                .finally(() => {
                  setTimeout(() => { hasReported = false; }, 5000); // Дозволяємо повторне повідомлення через 5 секунд
                });
              }
            });
          </script>
        </body>
      </html>
    `);
    logger.info(
      `GET /test/question завершено, тривалість ${Date.now() - startTime}мс`
    );
  } catch (err) {
    logger.error(
      `Помилка в GET /test/question, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Збереження відповіді
app.post('/test/save-answer', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка POST /test/save-answer');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Тест не розпочато для користувача ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const { index, answer } = req.body;
    const idx = parseInt(index);
    const {
      questions,
      answers,
      testNumber,
      startTime: testStartTime,
    } = userTest;

    if (isNaN(idx) || idx < 0 || idx >= questions.length) {
      logger.warn(`Невірний індекс питання ${idx} для користувача ${req.user}`);
      return res.status(400).send('Невірний номер питання');
    }

    const timeRemaining =
      testNames[testNumber].timeLimit * 1000 - (Date.now() - testStartTime);
    if (timeRemaining <= 0) {
      logger.info(
        `Часовий ліміт вичерпано для користувача ${req.user}, перенаправляємо на завершення`
      );
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
      logger.info(
        `Останнє питання відповіло користувачем ${req.user}, перенаправляємо на завершення, тривалість ${Date.now() - startTime}мс`
      );
      return res.redirect('/test/finish');
    } else {
      logger.info(
        `Відповідь збережена для питання ${idx} користувачем ${req.user}, перенаправляємо на наступне, тривалість ${Date.now() - startTime}мс`
      );
      return res.redirect(`/test/question?index=${idx + 1}`);
    }
  } catch (err) {
    logger.error(
      `Помилка в POST /test/save-answer, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Завершення тесту
app.get('/test/finish', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /test/finish');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Тест не розпочато для користувача ${req.user}`);
      return res.status(400).send('Тест не розпочато');
    }

    const {
      testNumber,
      questions,
      answers,
      startTime: testStartTime,
      suspiciousBehavior,
    } = userTest;
    const endTime = Date.now();

    let score = 0;
    let totalPoints = 0;
    questions.forEach((q, idx) => {
      const userAnswer = answers[idx];
      let questionScore = 0;
      if (!q.options || q.options.length === 0) {
        if (
          userAnswer &&
          String(userAnswer).trim().toLowerCase() ===
            String(q.correctAnswers[0]).trim().toLowerCase()
        ) {
          questionScore = q.points;
        }
      } else if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (
          correctAnswers.length === userAnswers.length &&
          correctAnswers.every(val => userAnswers.includes(val)) &&
          userAnswers.every(val => correctAnswers.includes(val))
        ) {
          questionScore = q.points;
        }
      } else if (q.type === 'ordering' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (
          correctAnswers.length === userAnswers.length &&
          correctAnswers.every((val, idx) => val === userAnswers[idx])
        ) {
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

    await saveResult(
      req.user,
      testNumber,
      score,
      totalPoints,
      testStartTime,
      endTime,
      suspiciousBehavior,
      answers,
      questions
    );
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
    logger.info(
      `GET /test/finish завершено для користувача ${req.user}, тривалість ${Date.now() - startTime}мс`
    );
  } catch (err) {
    logger.error(
      `Помилка в GET /test/finish, тривалість ${Date.now() - startTime}мс: ${err.message}`,
      { stack: err.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Адмін-панель
app.get('/admin', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /admin');

  try {
    let results = [];
    if (redisReady) {
      results = await redis.lrange('test_results', 0, -1);
    }
    const parsedResults = results.map(r => JSON.parse(r));

    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        try {
          questionsByTest[testNumber] = await loadQuestions(
            testNames[testNumber].questionsFile
          );
        } catch (error) {
          logger.error(
            `Помилка завантаження питань для тесту ${testNumber}: ${error.message}`,
            { stack: error.stack }
          );
          questionsByTest[testNumber] = [];
        }
      }
    }

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
              ${parsedResults
                .map(
                  (result, idx) => `
                <tr>
                  <td>${result.user}</td>
                  <td>${testNames[result.testNumber]?.name || 'Невідомий тест'}</td>
                  <td>${result.score} / ${result.totalPoints}</td>
                  <td>${formatDuration(result.duration)}</td>
                  <td>${Math.round((result.suspiciousBehavior / (result.duration || 1)) * 100)}%</td>
                  <td>${new Date(result.endTime).toLocaleString()}</td>
                  <td>
                    <button onclick="toggleAnswers(${idx})">Показати відповіді</button>
                  </td>
                </tr>
                <tr>
                  <td colspan="7">
                    <div id="answers-${idx}" class="answers">
                      ${Object.entries(result.answers)
                        .map(([qIdx, answer]) => {
                          const question =
                            questionsByTest[result.testNumber]?.[qIdx];
                          if (!question)
                            return `<p>Питання ${parseInt(qIdx) + 1}: Відповідь: ${answer} (Питання не знайдено)</p>`;
                          const isCorrect = result.scoresPerQuestion[qIdx] > 0;
                          return `
                          <p>
                            Питання ${parseInt(qIdx) + 1}: ${question.text}<br>
                            Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}<br>
                            Правильна відповідь: ${question.correctAnswers.join(', ')}<br>
                            Оцінка: ${result.scoresPerQuestion[qIdx]} / ${question.points} (${isCorrect ? 'Правильно' : 'Неправильно'})
                          </p>
                        `;
                        })
                        .join('')}
                    </div>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
          <script>
            async function deleteResults() {
              if (confirm('Ви впевнені, що хочете видалити всі результати тестів?')) {
                const response = await fetch('/admin/delete-results', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': '${req.csrfToken()}' }
                });
                const result = await response.json();
                if (result.success) {
                  window.location.reload();
                } else {
                  alert('Помилка при видаленні результатів: ' + result.message);
                }
              }
            }

            function toggleAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              answersDiv.style.display = answersDiv.style.display === 'block' ? 'none' : 'block';
            }
          </script>
        </body>
      </html>
    `);
    logger.info(`GET /admin завершено, тривалість ${Date.now() - startTime}мс`);
  } catch (error) {
    logger.error(
      `Помилка в GET /admin, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка POST /admin/delete-results');

  try {
    if (redisReady) {
      await redis.del('test_results');
    }
    logger.info(
      `Результати тестів видалені, тривалість ${Date.now() - startTime}мс`
    );
    res.json({ success: true, message: 'Результати тестів успішно видалені' });
  } catch (error) {
    logger.error(
      `Помилка в POST /admin/delete-results, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res
      .status(500)
      .json({ success: false, message: 'Помилка при видаленні результатів' });
  }
});

// Сторінка створення тесту
app.get('/admin/create-test', checkAdmin, (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /admin/create-test');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Створити тест</title>
        <style>
          body { font-size: 16px; margin: 20px; text-align: center; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          form { display: flex; flex-direction: column; align-items: center; gap: 10px; }
          input, button { font-size: 16px; padding: 10px; width: 100%; max-width: 300px; box-sizing: border-box; }
          button { border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>Створити тест</h1>
        <form id="createTestForm" enctype="multipart/form-data" method="POST" action="/admin/create-test">
          <input type="hidden" name="_csrf" value="${req.csrfToken()}">
          <input type="text" name="testName" placeholder="Назва тесту" required>
          <input type="number" name="timeLimit" placeholder="Ліміт часу (сек)" required>
          <input type="file" name="questionsFile" accept=".xlsx" required>
          <button type="submit">Створити</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        <p id="error" class="error"></p>
      </body>
    </html>
  `);
  logger.info(
    `GET /admin/create-test завершено, тривалість ${Date.now() - startTime}мс`
  );
});

// Обробка створення тесту
app.post(
  '/admin/create-test',
  checkAdmin,
  upload.single('questionsFile'),
  async (req, res) => {
    const startTime = Date.now();
    logger.info('Обробка POST /admin/create-test');

    try {
      const { testName, timeLimit } = req.body;
      const file = req.file;

      if (!testName || !timeLimit || !file) {
        logger.warn('Відсутні обов’язкові поля для створення тесту');
        return res.status(400).send('Усі поля обов’язкові');
      }

      const newTestNumber = String(Object.keys(testNames).length + 1);
      const questionsFileName = `questions${newTestNumber}.xlsx`;

      let blob;
      try {
        const fileBuffer = await fs.readFile(file.path);
        blob = await put(questionsFileName, fileBuffer, {
          access: 'public',
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
      } catch (blobError) {
        logger.error('Помилка при завантаженні в Vercel Blob:', blobError);
        throw new Error('Не вдалося завантажити файл у сховище');
      } finally {
        try {
          await fs.unlink(file.path);
        } catch (unlinkError) {
          logger.error(
            `Помилка видалення завантаженого файлу: ${unlinkError.message}`,
            { stack: unlinkError.stack }
          );
        }
      }

      testNames[newTestNumber] = {
        name: testName,
        timeLimit: parseInt(timeLimit),
        questionsFile: questionsFileName,
      };
      if (redisReady) {
        await redis.set('testNames', JSON.stringify(testNames));
      }

      logger.info(
        `Тест ${newTestNumber} створений, тривалість ${Date.now() - startTime}мс`
      );
      res.redirect('/admin');
    } catch (error) {
      logger.error(
        `Помилка в POST /admin/create-test, тривалість ${Date.now() - startTime}мс: ${error.message}`,
        { stack: error.stack }
      );
      res.status(500).send('Помилка сервера');
    }
  }
);

// Сторінка редагування тестів
app.get('/admin/edit-tests', checkAdmin, (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /admin/edit-tests');

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
          .test { margin-bottom: 20px; padding: 10px; border: 1px solid #ccc; border-radius: 5px; }
          input[type="text"], input[type="number"] { font-size: 16px; padding: 5px; margin: 5px 0; width: 100%; max-width: 300px; box-sizing: border-box; }
          button { font-size: 16px; padding: 5px 10px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin: 5px 0; }
          button:hover { background-color: #0056b3; }
          .delete-btn { background-color: #dc3545; }
          .delete-btn:hover { background-color: #c82333; }
        </style>
      </head>
      <body>
        <h1>Редагувати тести</h1>
        <div id="tests">
          ${Object.entries(testNames)
            .map(
              ([num, data]) => `
            <div class="test" data-test-num="${num}">
              <label>Назва тесту ${num}:</label>
              <input type="text" value="${data.name}" data-field="name">
              <label>Часовий ліміт (секунд):</label>
              <input type="number" value="${data.timeLimit}" data-field="timeLimit">
              <label>Файл з питаннями:</label>
              <input type="text" value="${data.questionsFile}" data-field="questionsFile" readonly>
              <button onclick="saveTest('${num}')">Зберегти</button>
              <button class="delete-btn" onclick="deleteTest('${num}')">Видалити</button>
            </div>
          `
            )
            .join('')}
        </div>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        <script>
          async function saveTest(testNum) {
            const testDiv = document.querySelector(\`.test[data-test-num="\${testNum}"]\`);
            const name = testDiv.querySelector('input[data-field="name"]').value;
            const timeLimit = testDiv.querySelector('input[data-field="timeLimit"]').value;
            const questionsFile = testDiv.querySelector('input[data-field="questionsFile"]').value;

            const response = await fetch('/admin/update-test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': '${req.csrfToken()}' },
              body: JSON.stringify({ testNum, name, timeLimit: parseInt(timeLimit), questionsFile })
            });
            const result = await response.json();
            if (result.success) {
              alert('Тест успішно оновлено');
            } else {
              alert('Помилка при оновленні тесту: ' + result.message);
            }
          }

          async function deleteTest(testNum) {
            if (confirm('Ви впевнені, що хочете видалити тест ' + testNum + '?')) {
              const response = await fetch('/admin/delete-test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': '${req.csrfToken()}' },
                body: JSON.stringify({ testNum })
              });
              const result = await response.json();
              if (result.success) {
                document.querySelector(\`.test[data-test-num="\${testNum}"]\`).remove();
              } else {
                alert('Помилка при видаленні тесту: ' + result.message);
              }
            }
          }
        </script>
      </body>
    </html>
  `);
  logger.info(
    `GET /admin/edit-tests завершено, тривалість ${Date.now() - startTime}мс`
  );
});

app.post('/admin/update-test', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка POST /admin/update-test');

  try {
    const { testNum, name, timeLimit, questionsFile } = req.body;
    if (!testNum || !name || !timeLimit || !questionsFile) {
      logger.warn('Відсутні обов’язкові поля для оновлення тесту');
      return res
        .status(400)
        .json({ success: false, message: 'Усі поля обов’язкові' });
    }
    if (!testNames[testNum]) {
      logger.warn(`Тест ${testNum} не знайдено`);
      return res
        .status(404)
        .json({ success: false, message: 'Тест не знайдено' });
    }
    testNames[testNum] = {
      name,
      timeLimit: parseInt(timeLimit),
      questionsFile,
    };
    if (redisReady) {
      await redis.set('testNames', JSON.stringify(testNames));
    }
    logger.info(
      `Тест ${testNum} оновлено, тривалість ${Date.now() - startTime}мс`
    );
    res.json({ success: true, message: 'Тест успішно оновлено' });
  } catch (error) {
    logger.error(
      `Помилка в POST /admin/update-test, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res
      .status(500)
      .json({ success: false, message: 'Помилка при оновленні тесту' });
  }
});

app.post('/admin/delete-test', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка POST /admin/delete-test');

  try {
    const { testNum } = req.body;
    if (!testNum) {
      logger.warn('Відсутній testNum для видалення');
      return res
        .status(400)
        .json({ success: false, message: 'Номер тесту є обов’язковим' });
    }

    if (!testNames[testNum]) {
      logger.warn(`Тест ${testNum} не знайдено для видалення`);
      return res
        .status(404)
        .json({ success: false, message: 'Тест не знайдено' });
    }

    const questionsFile = testNames[testNum].questionsFile;
    delete testNames[testNum];

    if (redisReady) {
      await redis.set('testNames', JSON.stringify(testNames));
    }

    try {
      const blobs = await listVercelBlobs();
      const blobToDelete = blobs.find(blob => blob.pathname === questionsFile);
      if (blobToDelete) {
        await fetch(blobToDelete.url, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
          },
        });
        logger.info(
          `Файл питань ${questionsFile} видалений з Vercel Blob Storage`
        );
      }
    } catch (blobError) {
      logger.error(
        `Не вдалося видалити файл питань ${questionsFile} з Vercel Blob Storage: ${blobError.message}`,
        { stack: blobError.stack }
      );
    }

    delete questionsByTestCache[questionsFile];

    logger.info(
      `Тест ${testNum} видалений, тривалість ${Date.now() - startTime}мс`
    );
    res.json({ success: true, message: 'Тест успішно видалено' });
  } catch (error) {
    logger.error(
      `Помилка в POST /admin/delete-test, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res
      .status(500)
      .json({ success: false, message: 'Помилка при видаленні тесту' });
  }
});

// Перегляд результатів тестів
app.get('/admin/view-results', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /admin/view-results');

  try {
    let results = [];
    if (redisReady) {
      try {
        results = await redis.lrange('test_results', 0, -1);
      } catch (redisError) {
        logger.error(
          `Помилка отримання результатів тестів з Redis: ${redisError.message}`,
          { stack: redisError.stack }
        );
        return res.status(500).send('Помилка при отриманні результатів тестів');
      }
    } else {
      logger.warn('Redis недоступний, не можемо отримати результати тестів');
    }

    const parsedResults = results.map(r => JSON.parse(r));

    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        try {
          questionsByTest[testNumber] = await loadQuestions(
            testNames[testNumber].questionsFile
          );
        } catch (error) {
          logger.error(
            `Помилка завантаження питань для тесту ${testNumber}: ${error.message}`,
            { stack: error.stack }
          );
          questionsByTest[testNumber] = [];
        }
      }
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Перегляд результатів тестів</title>
          <style>
            body { font-size: 16px; margin: 20px; }
            h1 { font-size: 24px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
            th { background-color: #f0f0f0; }
            button { font-size: 16px; padding: 5px 10px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
            button:hover { background-color: #0056b3; }
            .answers { display: none; margin-top: 10px; padding: 10px; border: 1px solid #ccc; border-radius: 5px; }
            .back-btn { margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>Перегляд результатів тестів</h1>
          <button class="back-btn" onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
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
              ${parsedResults
                .map(
                  (result, idx) => `
                <tr>
                  <td>${result.user}</td>
                  <td>${testNames[result.testNumber]?.name || 'Невідомий тест'}</td>
                  <td>${result.score} / ${result.totalPoints}</td>
                  <td>${formatDuration(result.duration)}</td>
                  <td>${Math.round((result.suspiciousBehavior / (result.duration || 1)) * 100)}%</td>
                  <td>${new Date(result.endTime).toLocaleString()}</td>
                  <td>
                    <button onclick="toggleAnswers(${idx})">Показати відповіді</button>
                  </td>
                </tr>
                <tr>
                  <td colspan="7">
                    <div id="answers-${idx}" class="answers">
                      ${Object.entries(result.answers)
                        .map(([qIdx, answer]) => {
                          const question =
                            questionsByTest[result.testNumber]?.[qIdx];
                          if (!question)
                            return `<p>Питання ${parseInt(qIdx) + 1}: Відповідь: ${answer} (Питання не знайдено)</p>`;
                          const isCorrect = result.scoresPerQuestion[qIdx] > 0;
                          return `
                          <p>
                            Питання ${parseInt(qIdx) + 1}: ${question.text}<br>
                            Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}<br>
                            Правильна відповідь: ${question.correctAnswers.join(', ')}<br>
                            Оцінка: ${result.scoresPerQuestion[qIdx]} / ${question.points} (${isCorrect ? 'Правильно' : 'Неправильно'})
                          </p>
                        `;
                        })
                        .join('')}
                    </div>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
          <script>
            function toggleAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              answersDiv.style.display = answersDiv.style.display === 'block' ? 'none' : 'block';
            }
          </script>
        </body>
      </html>
    `);
    logger.info(
      `GET /admin/view-results завершено, тривалість ${Date.now() - startTime}мс`
    );
  } catch (error) {
    logger.error(
      `Помилка в GET /admin/view-results, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Маршрут для виходу
app.get('/logout', (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка GET /logout');

  try {
    req.session.destroy(err => {
      if (err) {
        logger.error(`Помилка знищення сесії під час виходу: ${err.message}`, {
          stack: err.stack,
        });
        return res.status(500).send('Помилка при виході');
      }
      res.clearCookie('savedPassword');
      logger.info(
        `Користувач успішно вийшов, тривалість ${Date.now() - startTime}мс`
      );
      res.redirect('/');
    });
  } catch (error) {
    logger.error(
      `Помилка в GET /logout, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res.status(500).send('Помилка сервера');
  }
});

// Обробка підозрілої активності
app.post('/report-suspicious', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Обробка POST /report-suspicious');

  try {
    const userTest = await getUserTest(req.user);
    if (!userTest) {
      logger.warn(`Тест не розпочато для користувача ${req.user}`);
      return res
        .status(400)
        .json({ success: false, message: 'Тест не розпочато' });
    }

    userTest.suspiciousBehavior = (userTest.suspiciousBehavior || 0) + 1;
    await setUserTest(req.user, userTest);

    logger.info(
      `Підозріла активність зареєстрована для користувача ${req.user}, тривалість ${Date.now() - startTime}мс`
    );
    res.json({ success: true });
  } catch (error) {
    logger.error(
      `Помилка в POST /report-suspicious, тривалість ${Date.now() - startTime}мс: ${error.message}`,
      { stack: error.stack }
    );
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

// Middleware для обробки помилок
app.use((err, req, res, next) => {
  logger.error(`Непередбачена помилка: ${err.message}`, {
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  res.status(500).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Помилка сервера</title>
        <style>
          body { font-size: 16px; margin: 20px; text-align: center; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          p { margin-bottom: 20px; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
        </style>
      </head>
      <body>
        <h1>Помилка сервера</h1>
        <p>Виникла помилка на сервері: ${xss(err.message)}</p>
        <p>Спробуйте ще раз пізніше або зверніться до адміністратора.</p>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`Сервер запущений на порту ${PORT}`);
  try {
    await initializeServer();
  } catch (error) {
    logger.error(`Не вдалося ініціалізувати сервер: ${error.message}`, {
      stack: error.stack,
    });
    process.exit(1);
  }
});

// Граціозне завершення роботи
const shutdown = async () => {
  logger.info('Отримано сигнал завершення, закриваємо сервер...');
  try {
    if (redisReady) {
      await redis.quit();
      logger.info('З’єднання з Redis закрито');
    }
  } catch (error) {
    logger.error(`Помилка закриття з’єднання з Redis: ${error.message}`, {
      stack: error.stack,
    });
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
