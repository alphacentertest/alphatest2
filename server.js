const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');
const logger = require('./logger');
const AWS = require('aws-sdk');
const { put, get } = require('@vercel/blob');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

// Инициализация приложения
const app = express();

// Настройка Redis
let redisReady = false; // Глобальная переменная для отслеживания готовности Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  connectTimeout: 20000,
  maxRetriesPerRequest: 5,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);
    logger.info(`Retrying Redis connection, attempt ${times}, delay ${delay}ms`);
    return delay;
  },
  enableOfflineQueue: true,
  enableReadyCheck: true,
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

// Функция проверки подключения к Redis
const ensureRedisConnected = async () => {
  if (redis.status === 'close' || redis.status === 'end') {
    logger.info('Redis client is closed, attempting to reconnect...');
    try {
      await redis.connect();
      redisReady = true;
      logger.info('Redis reconnected successfully');
    } catch (err) {
      redisReady = false;
      logger.error('Failed to reconnect to Redis:', err.message, err.stack);
      throw err;
    }
  }
};

// Настройка AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Базовый URL для Vercel Blob Storage
const BLOB_BASE_URL = process.env.BLOB_BASE_URL || 'https://qqeygegbb01p35fz.public.blob.vercel-storage.com';

// Настройка middleware
app.set('trust proxy', 1); // Для Vercel
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
    logger.info(`${req.method} ${req.url} completed in ${Date.now() - startTime}ms`);
  });
  next();
});

// Настройка ограничения скорости для маршрута логина
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
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
let isInitialized = false;
let initializationError = null;
let testNames = {
  '1': { name: 'Тест 1', timeLimit: 3600, questionsFile: 'questions1.xlsx' },
  '2': { name: 'Тест 2', timeLimit: 3600, questionsFile: 'questions2.xlsx' },
};

// Middleware для проверки инициализации
const ensureInitialized = (req, res, next) => {
  if (!isInitialized) {
    if (initializationError) {
      logger.error(`Server initialization failed: ${initializationError.message}`);
      return res.status(500).json({ success: false, message: `Server initialization failed: ${initializationError.message}` });
    }
    logger.warn('Server is initializing, please try again later');
    return res.status(503).json({ success: false, message: 'Server is initializing, please try again later' });
  }
  next();
};

// Применяем middleware ко всем маршрутам
app.use(ensureInitialized);

// Функция форматирования времени
const formatDuration = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours > 0 ? hours + ' год ' : ''}${minutes > 0 ? minutes + ' хв ' : ''}${secs} с`;
};

// Загрузка пользователей из Vercel Blob Storage
const loadUsers = async () => {
  const startTime = Date.now();
  logger.info('Attempting to load users from Vercel Blob Storage...');

  try {
    const blobUrl = `${BLOB_BASE_URL}/users-C2sivyAPoIF7lPXTbhfNjFMVyLNN5h.xlsx`;
    logger.info(`Fetching users from URL: ${blobUrl}`);
    const response = await get(blobUrl);
    if (!response.ok) {
      throw new Error(`Не удалось загрузить файл ${blobUrl}: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    logger.info('Reading users.xlsx from Blob Storage...');
    await workbook.xlsx.load(buffer);
    logger.info('File read successfully');

    let sheet = workbook.getWorksheet('Users') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      throw new Error('Ни один из листов ("Users" или "Sheet1") не найден');
    }
    logger.info('Worksheet found:', sheet.name);

    const users = {};
    if (redisReady) {
      await redis.del('users'); // Очищаем старые данные
    }

    const userRows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const username = String(row.getCell(1).value || '').trim();
        const password = String(row.getCell(2).value || '').trim();
        if (username && password) {
          userRows.push({ username, password });
        }
      }
    });

    logger.info('Users loaded from Excel:', userRows);

    const saltRounds = 10;
    for (const { username, password } of userRows) {
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      if (redisReady) {
        await redis.hset('users', username, hashedPassword);
      }
      users[username] = hashedPassword; // Храним хэшированный пароль
    }

    if (Object.keys(users).length === 0) {
      throw new Error('Не знайдено користувачів у файлі');
    }
    logger.info(`Loaded users and stored in Redis, took ${Date.now() - startTime}ms`);
    return users;
  } catch (error) {
    logger.error(`Error loading users from Blob Storage, took ${Date.now() - startTime}ms:`, error.message, error.stack);
    throw error;
  }
};

// Загрузка вопросов для теста с кэшированием
const loadQuestions = async (questionsFile) => {
  const startTime = Date.now();
  const cacheKey = `questions:${questionsFile}`;
  logger.info(`Loading questions for ${questionsFile}`);

  try {
    if (redisReady) {
      const cachedQuestions = await redis.get(cacheKey);
      if (cachedQuestions) {
        logger.info(`Loaded ${questionsFile} from Redis cache, took ${Date.now() - startTime}ms`);
        return JSON.parse(cachedQuestions);
      }
    }

    // Загружаем файл из Vercel Blob Storage
    const blobUrl = `${BLOB_BASE_URL}/${questionsFile}`;
    logger.info(`Fetching questions from URL: ${blobUrl}`);
    const response = await get(blobUrl);
    if (!response.ok) {
      throw new Error(`Не удалось загрузить файл ${blobUrl}: ${response.statusText}`);
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
      await redis.set(cacheKey, JSON.stringify(questions), 'EX', 3600);
      logger.info(`Cached ${questionsFile} in Redis`);
    }

    logger.info(`Loaded ${questions.length} questions from ${questionsFile}, took ${Date.now() - startTime}ms`);
    return questions;
  } catch (error) {
    logger.error(`Error loading questions from ${questionsFile}, took ${Date.now() - startTime}ms:`, error.message, error.stack);
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

// Инициализация сервера
const initializeServer = async () => {
  const startTime = Date.now();
  logger.info('Starting server initialization');

  try {
    // Проверяем статус Redis перед попыткой подключения
    if (redis.status === 'ready') {
      logger.info('Redis is already connected');
      redisReady = true;
    } else if (redis.status !== 'connecting' && redis.status !== 'connect') {
      logger.info('Connecting to Redis...');
      await redis.connect();
      redisReady = true;
      logger.info('Redis connected');
    } else {
      logger.info('Redis is already connecting, waiting for connection...');
      await new Promise((resolve) => {
        redis.once('ready', () => {
          redisReady = true;
          logger.info('Redis connected');
          resolve();
        });
      });
    }

    await loadUsers();
    logger.info('Users loaded successfully');

    isInitialized = true;
    logger.info(`Server initialized successfully, took ${Date.now() - startTime}ms`);
  } catch (error) {
    initializationError = error;
    logger.error(`Failed to initialize server, took ${Date.now() - startTime}ms:`, error.stack);
    throw error;
  }
};

// Обработка favicon.ico и favicon.png
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/favicon.png', (req, res) => {
  res.status(204).end();
});

// Главная страница (вход)
app.get('/', async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /');

  try {
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
    logger.error(`Error in GET /, took ${Date.now() - startTime}ms:`, err);
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
      // Проверяем готовность Redis
      if (!redisReady) {
        logger.warn('Redis not ready during login attempt');
        return res.status(503).json({ success: false, message: 'Сервер ще ініціалізується. Спробуйте пізніше.' });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Validation errors:', errors.array());
        return res.status(400).json({ success: false, message: errors.array()[0].msg });
      }

      const { password, rememberMe } = req.body;
      logger.info(`Checking password for user input`);

      let users = validPasswords;
      if (redisReady) {
        const redisUsers = await redis.hgetall('users');
        users = { ...users, ...redisUsers };
      }

      let authenticatedUser = null;
      for (const [username, storedPassword] of Object.entries(users)) {
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
      logger.error(`Error during login, took ${Date.now() - startTime}ms:`, error);
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
    logger.error(`Error in GET /select-test, took ${Date.now() - startTime}ms:`, err);
    res.status(500).send('Помилка сервера');
  }
});

// Начало теста
app.get('/test/start', checkAuth, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /test/start');

  try {
    const { testNumber } = req.query;
    if (!testNames[testNumber]) {
      logger.warn(`Test ${testNumber} not found`);
      return res.status(400).send('Тест не знайдено');
    }

    const questions = await loadQuestions(testNames[testNumber].questionsFile).catch(err => {
      logger.error(`Ошибка загрузки вопросов для теста ${testNumber}, took ${Date.now() - startTime}ms:`, err.stack);
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
    logger.error(`Error in GET /test/start, took ${Date.now() - startTime}ms:`, err);
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
    if (index < 0 || index >= questions.length) {
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
    logger.error(`Error in GET /test/question, took ${Date.now() - startTime}ms:`, err);
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

    if (idx < 0 || idx >= questions.length) {
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
    logger.error(`Error in POST /test/save-answer, took ${Date.now() - startTime}ms:`, err);
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
    logger.error(`Error in GET /test/finish, took ${Date.now() - startTime}ms:`, err);
    res.status(500).send('Помилка сервера');
  }
});

// Маршрут админ-панели
app.get('/admin', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /admin');

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
          questionsByTest[testNumber] = await loadQuestions(testNames[testNumber].questionsFile);
        } catch (error) {
          logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, error.stack);
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
            <button onclick="toggleCamera()">Камера: ${await getCameraMode() ? 'Вимкнути' : 'Увімкнути'}</button>
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
              ${parsedResults.map((result, idx) => `
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
                      ${Object.entries(result.answers).map(([qIdx, answer]) => {
                        const question = questionsByTest[result.testNumber]?.[qIdx];
                        if (!question) return `<p>Питання ${parseInt(qIdx) + 1}: Відповідь: ${answer} (Питання не знайдено)</p>`;
                        const isCorrect = result.scoresPerQuestion[qIdx] > 0;
                        return `
                          <p>
                            Питання ${parseInt(qIdx) + 1}: ${question.text}<br>
                            Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}<br>
                            Правильна відповідь: ${question.correctAnswers.join(', ')}<br>
                            Оцінка: ${result.scoresPerQuestion[qIdx]} / ${question.points} (${isCorrect ? 'Правильно' : 'Неправильно'})
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
              }
            }

            async function toggleCamera() {
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
            }

            function toggleAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              answersDiv.style.display = answersDiv.style.display === 'block' ? 'none' : 'block';
            }
          </script>
        </body>
      </html>
    `);
    logger.info(`GET /admin completed, took ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.error(`Error in GET /admin, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).send('Помилка сервера');
  }
});

app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /admin/delete-results');

  try {
    if (redisReady) {
      await redis.del('test_results');
    }
    logger.info(`Test results deleted, took ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Результати тестів успішно видалені' });
  } catch (error) {
    logger.error(`Error in POST /admin/delete-results, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні результатів' });
  }
});

app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /admin/toggle-camera');

  try {
    const currentMode = await getCameraMode();
    await setCameraMode(!currentMode);
    logger.info(`Camera mode toggled to ${!currentMode}, took ${Date.now() - startTime}ms`);
    res.json({ success: true, message: `Камера ${!currentMode ? 'увімкнена' : 'вимкнена'}` });
  } catch (error) {
    logger.error(`Error in POST /admin/toggle-camera, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).json({ success: false, message: 'Помилка при зміні стану камери' });
  }
});

// Страница создания теста
app.get('/admin/create-test', checkAdmin, (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /admin/create-test');

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
  logger.info(`GET /admin/create-test completed, took ${Date.now() - startTime}ms`);
});

// Обработка создания теста
app.post('/admin/create-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /admin/create-test');

  try {
    const { testName, timeLimit } = req.body;
    const file = req.file;

    if (!testName || !timeLimit || !file) {
      logger.warn('Missing required fields for test creation');
      return res.status(400).send('Усі поля обов’язкові');
    }

    const newTestNumber = String(Object.keys(testNames).length + 1);
    const questionsFileName = `questions${newTestNumber}.xlsx`;

    let blob;
    try {
      blob = await put(questionsFileName, fs.readFileSync(file.path), { access: 'public' });
    } catch (blobError) {
      logger.error('Ошибка при загрузке в Vercel Blob:', blobError);
      throw new Error('Не удалось загрузить файл в хранилище');
    }

    testNames[newTestNumber] = { name: testName, timeLimit: parseInt(timeLimit), questionsFile: questionsFileName };
    if (redisReady) {
      await redis.set('testNames', JSON.stringify(testNames));
    }
    fs.unlinkSync(file.path);

    logger.info(`Test ${newTestNumber} created, took ${Date.now() - startTime}ms`);
    res.redirect('/admin');
  } catch (error) {
    logger.error(`Error in POST /admin/create-test, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Страница редактирования тестов
app.get('/admin/edit-tests', checkAdmin, (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /admin/edit-tests');

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
          ${Object.entries(testNames).map(([num, data]) => `
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
          `).join('')}
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
              headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json' },
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
  logger.info(`GET /admin/edit-tests completed, took ${Date.now() - startTime}ms`);
});

app.post('/admin/update-test', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /admin/update-test');

  try {
    const { testNum, name, timeLimit, questionsFile } = req.body;
    if (!testNames[testNum]) {
      logger.warn(`Test ${testNum} not found`);
      return res.status(404).json({ success: false, message: 'Тест не знайдено' });
    }
    testNames[testNum] = { name, timeLimit: parseInt(timeLimit), questionsFile };
    if (redisReady) {
      await redis.set('testNames', JSON.stringify(testNames));
    }
    logger.info(`Test ${testNum} updated, took ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Тест успішно оновлено' });
  } catch (error) {
    logger.error(`Error in POST /admin/update-test, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).json({ success: false, message: 'Помилка при оновленні тесту' });
  }
});

app.post('/admin/delete-test', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling POST /admin/delete-test');

  try {
    const { testNum } = req.body;
    if (!testNames[testNum]) {
      logger.warn(`Test ${testNum} not found`);
      return res.status(404).json({ success: false, message: 'Тест не знайдено' });
    }
    delete testNames[testNum];
    if (redisReady) {
      await redis.set('testNames', JSON.stringify(testNames));
    }
    logger.info(`Test ${testNum} deleted, took ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Тест успішно видалено' });
  } catch (error) {
    logger.error(`Error in POST /admin/delete-test, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні тесту' });
  }
});

// Перегляд результатів тестів
app.get('/admin/view-results', checkAdmin, async (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /admin/view-results');

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
          questionsByTest[testNumber] = await loadQuestions(testNames[testNumber].questionsFile);
        } catch (error) {
          logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, error.stack);
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
          <title>Перегляд результатів</title>
          <style>
            body { font-size: 16px; margin: 20px; }
            h1 { font-size: 24px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
            th { background-color: #f0f0f0; }
            button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin: 10px 0; }
            button:hover { background-color: #0056b3; }
            .answers { display: none; margin-top: 10px; padding: 10px; border: 1px solid #ccc; border-radius: 5px; }
          </style>
        </head>
        <body>
          <h1>Перегляд результатів</h1>
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
              ${parsedResults.map((result, idx) => `
                <tr>
                  <td>${result.user}</td>
                  <td>${testNames[result.testNumber]?.name || 'Невідомий тест'}</td>
                  <td>${result.score} / ${result.totalPoints}</td>
                  <td>${formatDuration(result.duration)}</td>
                  <td>${Math.round((result.suspiciousBehavior / (result.duration || 1)) * 100)}%</td>
                  <td>${new Date(result.endTime).toLocaleString()}</td>
                  <td><button onclick="showAnswers(${idx})">Показати відповіді</button></td>
                </tr>
                <tr id="answers-${idx}" class="answers">
                  <td colspan="7">
                    ${Object.entries(result.answers).map(([qIdx, answer]) => {
                      const question = questionsByTest[result.testNumber]?.[qIdx];
                      if (!question) return `<p>Питання ${parseInt(qIdx) + 1}: Відповідь: ${answer} (Питання не знайдено)</p>`;
                      const isCorrect = result.scoresPerQuestion[qIdx] > 0;
                      return `
                        <p>
                          Питання ${parseInt(qIdx) + 1}: ${question.text}<br>
                          Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}<br>
                          Правильна відповідь: ${question.correctAnswers.join(', ')}<br>
                          Оцінка: ${result.scoresPerQuestion[qIdx]} / ${question.points} (${isCorrect ? 'Правильно' : 'Неправильно'})
                        </p>
                      `;
                    }).join('')}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <button onclick="window.location.href='/admin'" style="margin-top: 20px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer;">Повернутися</button>
          <script>
            function showAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              answersDiv.style.display = answersDiv.style.display === 'none' || !answersDiv.style.display ? 'block' : 'none';
            }
          </script>
        </body>
      </html>
    `);
    logger.info(`GET /admin/view-results completed, took ${Date.now() - startTime}ms`);
  } catch (error) {
    logger.error(`Error in GET /admin/view-results, took ${Date.now() - startTime}ms:`, error.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Выход
app.get('/logout', (req, res) => {
  const startTime = Date.now();
  logger.info('Handling GET /logout');

  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  res.redirect('/');
  logger.info(`GET /logout completed, took ${Date.now() - startTime}ms`);
});

// Обработка ошибок 404
app.use((req, res) => {
  logger.warn(`404 Not Found: ${req.method} ${req.url}`);
  res.status(404).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>404 - Сторінка не знайдена</title>
        <style>
          body { font-size: 32px; margin: 20px; text-align: center; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
          h1 { margin-bottom: 20px; }
          button { font-size: 32px; padding: 10px 20px; margin: 20px; width: 100%; max-width: 300px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
          @media (max-width: 1024px) {
            body { font-size: 48px; margin: 30px; }
            h1 { font-size: 64px; margin-bottom: 30px; }
            button { font-size: 48px; padding: 15px 30px; margin: 30px; max-width: 100%; }
          }
        </style>
      </head>
      <body>
        <h1>404 - Сторінка не знайдена</h1>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err.stack);
  res.status(500).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>500 - Помилка сервера</title>
        <style>
          body { font-size: 32px; margin: 20px; text-align: center; display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
          h1 { margin-bottom: 20px; }
          button { font-size: 32px; padding: 10px 20px; margin: 20px; width: 100%; max-width: 300px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
          @media (max-width: 1024px) {
            body { font-size: 48px; margin: 30px; }
            h1 { font-size: 64px; margin-bottom: 30px; }
            button { font-size: 48px; padding: 15px 30px; margin: 30px; max-width: 100%; }
          }
        </style>
      </head>
      <body>
        <h1>500 - Помилка сервера</h1>
        <p>Виникла помилка на сервері. Будь ласка, спробуйте пізніше.</p>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Запуск сервера
const startServer = async () => {
  const startTime = Date.now();
  logger.info('Starting server...');

  try {
    await initializeServer();

    if (!isInitialized) {
      logger.error('Server failed to initialize, cannot start');
      process.exit(1);
    }

    logger.info(`Server is ready, initialization took ${Date.now() - startTime} ms`);

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });

    // Обработка завершения работы сервера
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      try {
        await redis.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.error('Error closing Redis connection:', err.stack);
      }
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      try {
        await redis.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.error('Error closing Redis connection:', err.stack);
      }
      process.exit(0);
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught Exception:', err.stack);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason.stack || reason);
      process.exit(1);
    });

  } catch (error) {
    logger.error('Failed to start server:', error.stack);
    process.exit(1);
  }
};

// Обработка завершения работы сервера
process.on('SIGTERM', async () => {
logger.info('Received SIGTERM, shutting down gracefully...');
try {
await redis.quit(); // Закрываем соединение с Redis
logger.info('Redis connection closed');
} catch (err) {
logger.error('Error closing Redis connection:', err.stack);
}
process.exit(0);
});

process.on('SIGINT', async () => {
logger.info('Received SIGINT, shutting down gracefully...');
try {
await redis.quit(); // Закрываем соединение с Redis
logger.info('Redis connection closed');
} catch (err) {
logger.error('Error closing Redis connection:', err.stack);
}
process.exit(0);
});

// Обработка непредвиденных ошибок
process.on('uncaughtException', (err) => {
logger.error('Uncaught Exception:', err.stack);
process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
logger.error('Unhandled Rejection at:', promise, 'reason:', reason.stack || reason);
process.exit(1);
});

} catch (error) {
logger.error('Failed to start server:', error.stack);
process.exit(1);
}
};

// Запуск сервера
startServer();

module.exports = app; // Экспорт приложения для возможного использования в тестах или других модулях
