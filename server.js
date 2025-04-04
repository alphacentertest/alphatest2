const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis'); // Используем ioredis вместо redis
const AWS = require('aws-sdk');
const { put, get } = require('@vercel/blob');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
require('dotenv').config();

// Инициализация приложения
const app = express();

// Настройка логирования
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ],
});

// Логирование всех запросов
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} - IP: ${req.ip}`);
  next();
});

// Настройка Redis с ioredis
const redisClient = new Redis({
  host: process.env.REDIS_HOST || 'redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com',
  port: process.env.REDIS_PORT || 13808,
  password: process.env.REDIS_PASSWORD || 'BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3',
  connectTimeout: 20000,
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis: Too many reconnect attempts, giving up');
      return new Error('Too many reconnect attempts');
    }
    logger.info(`Redis reconnect attempt ${times}`);
    return Math.min(times * 500, 3000);
  },
  enableTLSForSentinelMode: false,
  tls: false, // Отключаем TLS для устранения ошибки SSL
});

redisClient.on('error', (err) => logger.error('Redis Client Error:', err));
redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('reconnecting', () => logger.info('Redis reconnecting'));

const ensureRedisConnected = async () => {
  if (!redisClient.status || redisClient.status === 'close') {
    logger.info('Redis client is closed, attempting to reconnect...');
    try {
      await redisClient.connect();
      logger.info('Redis reconnected successfully');
    } catch (err) {
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

// Функция форматирования времени
const formatDuration = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours > 0 ? hours + ' год ' : ''}${minutes > 0 ? minutes + ' хв ' : ''}${secs} с`;
};

// Загрузка пользователей из Vercel Blob Storage
const loadUsers = async () => {
  try {
    logger.info('Attempting to load users from Vercel Blob Storage...');
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
    await ensureRedisConnected();
    await redisClient.del('users'); // Очищаем старые данные

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
      await redisClient.hset('users', username, hashedPassword);
      users[username] = password; // Для локального использования
    }

    if (Object.keys(users).length === 0) {
      throw new Error('Не знайдено користувачів у файлі');
    }
    logger.info('Loaded users and stored in Redis');
    return users;
  } catch (error) {
    logger.error('Error loading users from Blob Storage:', error.message, error.stack);
    throw error;
  }
};

// Загрузка вопросов для теста
const loadQuestions = async (questionsFile) => {
  try {
    const questionsFileUrl = `${BLOB_BASE_URL}/${questionsFile}`;
    logger.info(`Loading questions from ${questionsFileUrl}`);
    const response = await get(questionsFileUrl);
    if (!response.ok) {
      throw new Error(`Не удалось загрузить файл ${questionsFileUrl}: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet = workbook.getWorksheet('Questions') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      throw new Error('Лист "Questions" або "Sheet1" не знайдено');
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
      throw new Error('Питання не знайдено');
    }

    logger.info(`Loaded ${questions.length} questions from ${questionsFile}`);
    return questions;
  } catch (error) {
    logger.error(`Error loading questions from ${questionsFile}:`, error.message, error.stack);
    throw error;
  }
};

// Получение и установка режима камеры
const getCameraMode = async () => {
  await ensureRedisConnected();
  const mode = await redisClient.get('cameraMode');
  return mode === 'true';
};

const setCameraMode = async (mode) => {
  await ensureRedisConnected();
  await redisClient.set('cameraMode', String(mode));
};

// Получение и установка данных теста пользователя
const getUserTest = async (user) => {
  await ensureRedisConnected();
  const testData = await redisClient.hget('userTests', user);
  return testData ? JSON.parse(testData) : null;
};

const setUserTest = async (user, testData) => {
  await ensureRedisConnected();
  await redisClient.hset('userTests', user, JSON.stringify(testData));
};

const deleteUserTest = async (user) => {
  await ensureRedisConnected();
  await redisClient.hdel('userTests', user);
};

// Сохранение результата теста
const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime, suspiciousBehavior, answers, questions) => {
  await ensureRedisConnected();
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
  await redisClient.rpush('test_results', JSON.stringify(result));
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
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Starting server initialization (Attempt ${attempt} of ${maxAttempts})`);
      await ensureRedisConnected();

      // Загрузка testNames из Redis
      const testNamesData = await redisClient.get('testNames');
      testNames = testNamesData ? JSON.parse(testNamesData) : {
        '1': { name: 'Тест 1', timeLimit: 3600, questionsFile: 'questions1.xlsx' },
        '2': { name: 'Тест 2', timeLimit: 3600, questionsFile: 'questions2.xlsx' },
      };
      await redisClient.set('testNames', JSON.stringify(testNames));
      logger.info('Test names loaded:', testNames);

      validPasswords = await loadUsers();
      logger.info('Server initialized successfully');
      isInitialized = true;
      initializationError = null;
      return true;
    } catch (error) {
      logger.error(`Failed to initialize server (Attempt ${attempt} of ${maxAttempts}):`, error.message, error.stack);
      if (attempt === maxAttempts) {
        initializationError = error;
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
};

// Middleware для проверки инициализации
const checkInitialization = (req, res, next) => {
  if (!isInitialized) {
    return res.status(503).send('Сервер ще ініціалізується. Спробуйте пізніше.');
  }
  if (initializationError) {
    return res.status(500).send('Помилка ініціалізації сервера: ' + initializationError.message);
  }
  next();
};

// Применяем middleware ко всем маршрутам
app.use(checkInitialization);

// Главная страница (вход)
app.get('/', async (req, res) => {
  if (!isInitialized && !initializationError) {
    isInitialized = await initializeServer();
  }

  if (!isInitialized) {
    logger.error('Server initialization failed, cannot proceed');
    return res.status(500).send('Помилка ініціалізації сервера');
  }

  const user = req.cookies.auth;
  if (user) {
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
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          form { max-width: 300px; }
          label { display: block; margin: 10px 0 5px; }
          input[type="text"], input[type="password"] { font-size: 16px; padding: 5px; width: 100%; box-sizing: border-box; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin-top: 10px; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
          .password-container { position: relative; }
          .eye-icon { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); cursor: pointer; }
        </style>
      </head>
      <body>
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors:', errors.array());
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { password, rememberMe } = req.body;
    logger.info(`Checking password for user input`);

    try {
      await ensureRedisConnected();
      const users = await redisClient.hgetall('users');

      let authenticatedUser = null;
      for (const [username, hashedPassword] of Object.entries(users)) {
        if (await bcrypt.compare(password.trim(), hashedPassword)) {
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

      logger.info(`Successful login for user: ${authenticatedUser}`);
      if (authenticatedUser === 'admin') {
        res.json({ success: true, redirect: '/admin' });
      } else {
        res.json({ success: true, redirect: '/select-test' });
      }
    } catch (error) {
      logger.error('Error during login:', error);
      res.status(500).json({ success: false, message: 'Помилка сервера' });
    }
  }
);

// Выбор теста
app.get('/select-test', checkAuth, async (req, res) => {
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
});

// Начало теста
app.get('/test/start', checkAuth, async (req, res) => {
  const { testNumber } = req.query;
  if (!testNames[testNumber]) {
    return res.status(400).send('Тест не знайдено');
  }

  const questions = await loadQuestions(testNames[testNumber].questionsFile).catch(err => {
    logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
    return res.status(500).send('Помилка завантаження питань');
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
  res.redirect('/test/question?index=0');
});

// Страница вопроса
app.get('/test/question', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber, answers, startTime } = userTest;
  const index = parseInt(req.query.index) || 0;
  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  const q = questions[index];
  const progress = questions.map((_, i) => `<span style="display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%; margin: 2px; background-color: ${i === index ? '#007bff' : answers[i] ? '#28a745' : '#ccc'}; color: white; font-size: 14px;">${i + 1}</span>`).join('');

  const timeRemaining = testNames[testNumber].timeLimit * 1000 - (Date.now() - startTime);
  if (timeRemaining <= 0) {
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
});

// Сохранение ответа
app.post('/test/save-answer', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { index, answer } = req.body;
  const idx = parseInt(index);
  const { questions, answers, testNumber, startTime } = userTest;

  if (idx < 0 || idx >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  const timeRemaining = testNames[testNumber].timeLimit * 1000 - (Date.now() - startTime);
  if (timeRemaining <= 0) {
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
    return res.redirect('/test/finish');
  } else {
    return res.redirect(`/test/question?index=${idx + 1}`);
  }
});

// Завершение теста
app.get('/test/finish', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { testNumber, questions, answers, startTime, suspiciousBehavior } = userTest;
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

  await saveResult(req.user, testNumber, score, totalPoints, startTime, endTime, suspiciousBehavior, answers, questions);
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
        <p>Тривалість: ${formatDuration(Math.round((endTime - startTime) / 1000))}</p>
        <p>Підозріла активність: ${Math.round((suspiciousBehavior / (Math.round((endTime - startTime) / 1000) || 1)) * 100)}%</p>
        <button onclick="window.location.href='/select-test'">Повернутися до вибору тесту</button>
        <button onclick="window.location.href='/logout'">Вийти</button>
      </body>
    </html>
  `);
});

// Маршрут админ-панели
app.get('/admin', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lrange('test_results', 0, -1);
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
  } catch (error) {
    logger.error('Ошибка в /admin:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  try {
    await redisClient.del('test_results');
    res.json({ success: true, message: 'Результати тестів успішно видалені' });
  } catch (error) {
    logger.error('Ошибка в /admin/delete-results:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні результатів' });
  }
});

app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
  try {
    const currentMode = await getCameraMode();
    await setCameraMode(!currentMode);
    res.json({ success: true, message: `Камера ${!currentMode ? 'увімкнена' : 'вимкнена'}` });
  } catch (error) {
    logger.error('Ошибка в /admin/toggle-camera:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при зміні стану камери' });
  }
});

// Страница создания теста
app.get('/admin/create-test', checkAdmin, (req, res) => {
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
});

// Обработка создания теста
app.post('/admin/create-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
  try {
    const { testName, timeLimit } = req.body;
    const file = req.file;

    if (!testName || !timeLimit || !file) {
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
    await redisClient.set('testNames', JSON.stringify(testNames));
    fs.unlinkSync(file.path);

    res.redirect('/admin');
  } catch (error) {
    logger.error('Ошибка при создании теста:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Страница редактирования тестов
app.get('/admin/edit-tests', checkAdmin, (req, res) => {
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
});

app.post('/admin/update-test', checkAdmin, async (req, res) => {
  try {
    const { testNum, name, timeLimit, questionsFile } = req.body;
    if (!testNames[testNum]) {
      return res.status(404).json({ success: false, message: 'Тест не знайдено' });
    }
    testNames[testNum] = { name, timeLimit: parseInt(timeLimit), questionsFile };
    await redisClient.set('testNames', JSON.stringify(testNames));
    res.json({ success: true, message: 'Тест успішно оновлено' });
  } catch (error) {
    logger.error('Ошибка в /admin/update-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при оновленні тесту' });
  }
});

app.post('/admin/delete-test', checkAdmin, async (req, res) => {
  try {
    const { testNum } = req.body;
    if (!testNames[testNum]) {
      return res.status(404).json({ success: false, message: 'Тест не знайдено' });
    }
    delete testNames[testNum];
    await redisClient.set('testNames', JSON.stringify(testNames));
    res.json({ success: true, message: 'Тест успішно видалено' });
  } catch (error) {
    logger.error('Ошибка в /admin/delete-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні тесту' });
  }
});

// Перегляд результатів тестів
app.get('/admin/view-results', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lrange('test_results', 0, -1);
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
  } catch (error) {
    logger.error('Ошибка в /admin/view-results:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Выход
app.get('/logout', (req, res) => {
  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  res.redirect('/');
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
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Обработка завершения процесса
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  try {
    await redisClient.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logger.error('Error closing Redis connection:', err.stack);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  try {
    await redisClient.quit();
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
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Экспорт приложения для Vercel
module.exports = app;