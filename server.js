const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { createClient } = require('redis');
const multer = require('multer');
const { put, get } = require('@vercel/blob');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const path = require('path');
require('dotenv').config();

const app = express();

// Включите trust proxy для Vercel
app.set('trust proxy', true);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Базовый URL для Vercel Blob Storage
const BLOB_BASE_URL = process.env.BLOB_BASE_URL || 'https://qqeygegbb01p35fz.public.blob.vercel-storage.com';

let validPasswords = {};
let isInitialized = false;
let initializationError = null;
let testNames = {};

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

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} - IP: ${req.ip}`);
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(helmet());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много попыток входа, попробуйте снова через 15 минут',
});
app.use('/login', loginLimiter);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalName));
  }
});

const upload = multer({ storage: storage });

// Настройка Redis-клиента
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808',
  socket: {
    connectTimeout: 20000, // Увеличенный тайм-аут
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis: Too many reconnect attempts, giving up');
        return new Error('Too many reconnect attempts');
      }
      logger.info(`Redis reconnect attempt ${retries + 1}`);
      return Math.min(retries * 500, 3000);
    },
    tls: false, // Отключаем TLS для устранения ошибки SSL
  }
});

redisClient.on('error', (err) => logger.error('Redis Client Error:', err));
redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('reconnecting', () => logger.info('Redis reconnecting'));

const ensureRedisConnected = async () => {
  if (!redisClient.isOpen) {
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

    let sheet = workbook.getWorksheet('Users');
    if (!sheet) {
      logger.warn('Worksheet "Users" not found, trying "Sheet1"');
      sheet = workbook.getWorksheet('Sheet1');
      if (!sheet) {
        throw new Error('Ни один из листов ("Users" или "Sheet1") не найден');
      }
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
      await redisClient.hSet('users', username, hashedPassword);
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
const loadQuestions = async (testNumber) => {
  try {
    if (!testNames[testNumber]) {
      throw new Error(`Тест ${testNumber} не знайдено`);
    }

    const questionsFile = testNames[testNumber].questionsFile;
    if (!questionsFile) {
      throw new Error(`Файл питань для тесту ${testNumber} не знайдено`);
    }

    const questionsFileUrl = `${BLOB_BASE_URL}/${questionsFile}`;
    logger.info(`Loading questions for test ${testNumber} from ${questionsFileUrl}`);
    const response = await get(questionsFileUrl);
    if (!response.ok) {
      throw new Error(`Не удалось загрузить файл ${questionsFileUrl}: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    let sheet = workbook.getWorksheet('Questions');
    if (!sheet) {
      sheet = workbook.getWorksheet('Sheet1');
      if (!sheet) {
        throw new Error('Лист "Questions" або "Sheet1" не знайдено');
      }
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
          points: parseInt(row.getCell(8).value) || 1
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

    logger.info(`Loaded ${questions.length} questions for test ${testNumber}`);
    return questions;
  } catch (error) {
    logger.error(`Error loading questions for test ${testNumber}:`, error.message, error.stack);
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
  const testData = await redisClient.hGet('userTests', user);
  return testData ? JSON.parse(testData) : null;
};

const setUserTest = async (user, testData) => {
  await ensureRedisConnected();
  await redisClient.hSet('userTests', user, JSON.stringify(testData));
};

const deleteUserTest = async (user) => {
  await ensureRedisConnected();
  await redisClient.hDel('userTests', user);
};

// Сохранение результата теста
const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime, suspiciousBehavior) => {
  await ensureRedisConnected();
  const duration = Math.round((endTime - startTime) / 1000);
  const userTest = await getUserTest(user);
  const result = {
    user,
    testNumber,
    score,
    totalPoints,
    duration,
    suspiciousBehavior,
    startTime,
    endTime,
    answers: userTest.answers,
    scoresPerQuestion: userTest.questions.map((q, idx) => {
      const userAnswer = userTest.answers[idx];
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
      }
      return 0;
    })
  };
  await redisClient.rPush('test_results', JSON.stringify(result));
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
    return res.status(403).send('Доступ заборонено');
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
        '2': { name: 'Тест 2', timeLimit: 3600, questionsFile: 'questions2.xlsx' }
      };
      await redisClient.set('testNames', JSON.stringify(testNames));
      logger.info('Test names loaded:', testNames);

      validPasswords = await loadUsers();
      logger.info('Server initialized successfully');
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

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Вхід</title>
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
            color: red; 
            margin-bottom: 20px; 
          }
          form { 
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            gap: 10px; 
          }
          input[type="password"] { 
            font-size: 32px; 
            padding: 10px; 
            width: 100%; 
            max-width: 300px; 
            box-sizing: border-box; 
          }
          label { 
            font-size: 24px; 
          }
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
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
          .error { 
            color: red; 
            margin-top: 10px; 
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
            input[type="password"] { 
              font-size: 48px; 
              padding: 15px; 
              max-width: 100%; 
            }
            label { 
              font-size: 36px; 
            }
            button { 
              font-size: 48px; 
              padding: 15px 30px; 
              max-width: 100%; 
            }
            .error { 
              font-size: 36px; 
            }
          }
        </style>
      </head>
      <body>
        <h1>Введіть пароль</h1>
        <form id="loginForm">
          <input type="password" name="password" id="password" value="${req.cookies.savedPassword || ''}" required>
          <label><input type="checkbox" name="rememberMe" ${req.cookies.savedPassword ? 'checked' : ''}> Запомнить меня</label>
          <button type="submit">Увійти</button>
        </form>
        <div id="error" class="error"></div>
        <script>
          document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('password').value;
            const rememberMe = document.querySelector('input[name="rememberMe"]').checked;
            const response = await fetch('/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password, rememberMe })
            });
            const result = await response.json();
            if (result.success) {
              window.location.href = result.redirect;
            } else {
              document.getElementById('error').textContent = result.message || 'Помилка входу';
            }
          });
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
      const users = await redisClient.hGetAll('users');

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
        sameSite: 'lax'
      });

      if (rememberMe) {
        res.cookie('savedPassword', password, {
          maxAge: 30 * 24 * 60 * 60 * 1000,
          httpOnly: false,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
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

  const questions = await loadQuestions(testNumber).catch(err => {
    logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
    return res.status(500).send('Помилка завантаження питань');
  });

  const userTest = {
    testNumber,
    questions,
    answers: Array(questions.length).fill(null),
    startTime: Date.now(),
    currentQuestion: 0,
    suspiciousBehavior: 0
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
        <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest"></script>
        <script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@latest"></script>
        <script>
          const optionsContainer = document.getElementById('options');
          let draggedItem = null;

          if (${q.type === 'ordering' ? 'true' : 'false'}) {
            const options = document.querySelectorAll('.ordering');
            options.forEach(option => {
              option.addEventListener('dragstart', (e) => {
                draggedItem = option;
                setTimeout(() => option.style.display = 'none', 0);
              });
              option.addEventListener('dragend', (e) => {
                setTimeout(() => {
                  draggedItem.style.display = 'block';
                  draggedItem = null;
                }, 0);
              });
              option.addEventListener('dragover', (e) => e.preventDefault());
              option.addEventListener('drop', (e) => {
                e.preventDefault();
                if (draggedItem) {
                  const allOptions = [...document.querySelectorAll('.ordering')];
                  const draggedIndex = allOptions.indexOf(draggedItem);
                  const droppedIndex = allOptions.indexOf(option);
                  if (draggedIndex < droppedIndex) {
                    option.after(draggedItem);
                  } else {
                    option.before(draggedItem);
                  }
                  const newOrder = [...document.querySelectorAll('.ordering')].map(opt => opt.textContent);
                  fetch('/test/save-answer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ index: ${index}, answer: newOrder })
                  });
                }
              });
            });
          }

          document.querySelectorAll('.option:not(.ordering)').forEach(option => {
            option.addEventListener('click', () => {
              const input = option.querySelector('input');
              if (input.type === 'radio') {
                document.querySelectorAll('.option').forEach(opt => {
                  opt.classList.remove('selected');
                  opt.querySelector('input').checked = false;
                });
                input.checked = true;
                option.classList.add('selected');
              } else {
                input.checked = !input.checked;
                if (input.checked) option.classList.add('selected');
                else option.classList.remove('selected');
              }
            });
          });

          async function submitForm(event) {
            event.preventDefault();
            const form = document.getElementById('questionForm');
            const answer = ${q.options && q.options.length > 0 ? q.type === 'ordering' ? 
              '[...document.querySelectorAll(".ordering")].map(opt => opt.textContent)' : 
              'Array.from(form.querySelectorAll("input[name=answer]:checked")).map(input => input.value)' : 
              'form.querySelector("input[name=answer]").value'};
            const response = await fetch('/test/save-answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index: ${index}, answer })
            });
            const result = await response.json();
            if (result.success) window.location.href = result.redirect;
          }
          document.getElementById('questionForm').addEventListener('submit', submitForm);

          let suspiciousBehavior = ${userTest.suspiciousBehavior || 0};
          ${cameraEnabled ? `
            async function startCamera() {
              const video = document.createElement('video');
              video.style.display = 'none';
              document.body.appendChild(video);
              const stream = await navigator.mediaDevices.getUserMedia({ video: true });
              video.srcObject = stream;
              await video.play();
              const model = await faceLandmarksDetection.load(
                faceLandmarksDetection.SupportedPackages.mediapipeFacemesh
              );
              setInterval(async () => {
                const faces = await model.estimateFaces({ input: video });
                if (faces.length > 0) {
                  const landmarks = faces[0].scaledMesh;
                  const leftEye = landmarks[33];
                  const rightEye = landmarks[263];
                  const nose = landmarks[1];
                  const eyeDirection = Math.atan2(rightEye[1] - leftEye[1], rightEye[0] - leftEye[0]);
                  const noseDirection = Math.atan2(nose[1] - (leftEye[1] + rightEye[1]) / 2, nose[0] - (leftEye[0] + rightEye[0]) / 2);
                  if (Math.abs(eyeDirection - noseDirection) > 0.5) {
                    suspiciousBehavior += 1;
                    fetch('/test/update-suspicious', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ suspiciousBehavior })
                    });
                  }
                }
              }, 1000);
            }
            startCamera();
          ` : ''}
        </script>
      </body>
    </html>
  `);
});

// Сохранение ответа на вопрос
app.post('/test/save-answer', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).json({ success: false, message: 'Тест не розпочато' });

  const { index, answer } = req.body;
  const idx = parseInt(index);
  if (idx < 0 || idx >= userTest.questions.length) {
    return res.status(400).json({ success: false, message: 'Невірний номер питання' });
  }

  userTest.answers[idx] = answer;
  userTest.currentQuestion = idx;
  await setUserTest(req.user, userTest);

  if (idx === userTest.questions.length - 1) {
    res.json({ success: true, redirect: '/test/finish' });
  } else {
    res.json({ success: true, redirect: `/test/question?index=${idx + 1}` });
  }
});

// Обновление подозрительного поведения
app.post('/test/update-suspicious', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).json({ success: false, message: 'Тест не розпочато' });

  userTest.suspiciousBehavior = req.body.suspiciousBehavior || 0;
  await setUserTest(req.user, userTest);
  res.json({ success: true });
});

// Завершение теста
app.get('/test/finish', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber, answers, startTime } = userTest;
  let score = 0;
  let totalPoints = 0;

  questions.forEach((q, index) => {
    totalPoints += q.points;
    const userAnswer = answers[index];
    if (!q.options || q.options.length === 0) {
      if (userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase()) {
        score += q.points;
      }
    } else if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
      const correctAnswers = q.correctAnswers.map(String);
      const userAnswers = userAnswer.map(String);
      if (correctAnswers.length === userAnswers.length && 
          correctAnswers.every(val => userAnswers.includes(val)) && 
          userAnswers.every(val => correctAnswers.includes(val))) {
        score += q.points;
      }
    } else if (q.type === 'ordering' && userAnswer && userAnswer.length > 0) {
      const correctAnswers = q.correctAnswers.map(String);
      const userAnswers = userAnswer.map(String);
      if (correctAnswers.length === userAnswers.length && 
          correctAnswers.every((val, idx) => val === userAnswers[idx])) {
        score += q.points;
      }
    }
  });

  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);
  await saveResult(req.user, testNumber, score, totalPoints, startTime, endTime, userTest.suspiciousBehavior);
  await deleteUserTest(req.user);

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Результати тесту</title>
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
              margin: 15px 0; 
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
        <h1>${testNames[testNumber].name}: ${formatDuration(duration)}</h1>
        <p>Тривалість: ${formatDuration(duration)}</p>
        <p>Підозріла активність: ${Math.round((userTest.suspiciousBehavior / (duration || 1)) * 100)}%</p>
        <p>Результат: ${score} / ${totalPoints}</p>
        <button onclick="window.location.href='/select-test'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Админ-панель
app.get('/admin', checkAdmin, async (req, res) => {
  try {
    await ensureRedisConnected();
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));
    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        questionsByTest[testNumber] = await loadQuestions(testNumber).catch(err => {
          logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
          return [];
        });
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
            <button onclick="deleteResults()">Видалення результатів тестів</button>
            <button onclick="toggleCamera()">Камера: ${await getCameraMode() ? 'Вимкнути' : 'Увімкнути'}</button>
            <button onclick="window.location.href='/logout'">Вийти</button>
          </div>
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
                      const question = result.scoresPerQuestion[qIdx] && questionsByTest[result.testNumber][qIdx] ? questionsByTest[result.testNumber][qIdx] : null;
                      return question ? `
                        <p>Питання ${parseInt(qIdx) + 1}: ${question.text}</p>
                        <p>Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}</p>
                        <p>Бали: ${result.scoresPerQuestion[qIdx]} / ${question.points}</p>
                      ` : '';
                    }).join('')}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <script>
            function showAnswers(index) {
              const answersDiv = document.getElementById('answers-' + index);
              answersDiv.style.display = answersDiv.style.display === 'none' || !answersDiv.style.display ? 'block' : 'none';
            }
            async function toggleCamera() {
              const response = await fetch('/admin/toggle-camera', { method: 'POST' });
              if ((await response.json()).success) window.location.reload();
            }
            async function deleteResults() {
              if (confirm('Ви впевнені, що хочете видалити всі результати тестів?')) {
                const response = await fetch('/admin/delete-results', { method: 'POST' });
                if ((await response.json()).success) window.location.reload();
              }
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

// Переключение режима камеры
app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
  try {
    const currentMode = await getCameraMode();
    await setCameraMode(!currentMode);
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка в /admin/toggle-camera:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
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
          body { font-size: 16px; margin: 20px; text-align: center; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          .test { margin-bottom: 20px; }
          input, button { font-size: 16px; padding: 10px; width: 100%; max-width: 300px; box-sizing: border-box; margin: 5px 0; }
          button { border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
        </style>
      </head>
      <body>
        <h1>Редагувати тести</h1>
        ${Object.entries(testNames).map(([num, data]) => `
          <div class="test">
            <input type="text" id="testName-${num}" value="${data.name}">
            <input type="number" id="timeLimit-${num}" value="${data.timeLimit}">
            <button onclick="saveTest(${num})">Зберегти</button>
          </div>
        `).join('')}
        <button onclick="window.location.href='/admin'">Повернутися</button>
        <script>
          async function saveTest(testNumber) {
            const testName = document.getElementById('testName-' + testNumber).value;
            const timeLimit = document.getElementById('timeLimit-' + testNumber).value;
            const response = await fetch('/admin/edit-test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ testNumber, testName, timeLimit })
            });
            if ((await response.json()).success) window.location.href = '/admin';
          }
        </script>
      </body>
    </html>
  `);
});

// Обработка редактирования теста
app.post('/admin/edit-test', checkAdmin, async (req, res) => {
  try {
    const { testNumber, testName, timeLimit } = req.body;
    if (!testNames[testNumber]) return res.status(404).json({ success: false, message: 'Тест не знайдено' });

    testNames[testNumber] = { name: testName, timeLimit: parseInt(timeLimit), questionsFile: testNames[testNumber].questionsFile };
    await redisClient.set('testNames', JSON.stringify(testNames));
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка в /admin/edit-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

// Перегляд результатов тестов
app.get('/admin/view-results', checkAdmin, async (req, res) => {
  try {
    await ensureRedisConnected();
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));
    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        questionsByTest[testNumber] = await loadQuestions(testNumber).catch(err => {
          logger.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
          return [];
        });
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
          </style>
        </head>
        <body>
          <h1>Перегляд результатів тестів</h1>
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
                      const question = result.scoresPerQuestion[qIdx] && questionsByTest[result.testNumber][qIdx] ? questionsByTest[result.testNumber][qIdx] : null;
                      return question ? `
                        <p>Питання ${parseInt(qIdx) + 1}: ${question.text}</p>
                        <p>Відповідь: ${Array.isArray(answer) ? answer.join(', ') : answer}</p>
                        <p>Бали: ${result.scoresPerQuestion[qIdx]} / ${question.points}</p>
                      ` : '';
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

// Удаление результатов тестов
app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  try {
    await ensureRedisConnected();
    await redisClient.del('test_results');
    logger.info('Все результаты тестов удалены');
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка в /admin/delete-results:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

// Выход из системы
app.get('/logout', (req, res) => {
  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  logger.info('User logged out');
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