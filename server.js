const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('redis');
const fs = require('fs');
const multer = require('multer');
const { put, get } = require('@vercel/blob');

const app = express();

let validPasswords = {};
let isInitialized = false;
let initializationError = null;
let testNames = { 
  '1': { name: 'Тест 1', timeLimit: 3600 },
  '2': { name: 'Тест 2', timeLimit: 3600 }
};

// Настройка multer для использования /tmp
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

/** Завантаження користувачів із файлу users.xlsx */
const loadUsers = async () => {
  try {
    const filePath = path.join(__dirname, 'users.xlsx');
    console.log('Attempting to load users from:', filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File users.xlsx not found at path: ${filePath}`);
    }
    console.log('File users.xlsx exists at:', filePath);

    const workbook = new ExcelJS.Workbook();
    console.log('Reading users.xlsx file...');
    await workbook.xlsx.readFile(filePath);
    console.log('File read successfully');

    let sheet = workbook.getWorksheet('Users');
    if (!sheet) {
      console.warn('Worksheet "Users" not found, trying "Sheet1"');
      sheet = workbook.getWorksheet('Sheet1');
      if (!sheet) {
        throw new Error('Ни один из листов ("Users" или "Sheet1") не найден');
      }
    }
    console.log('Worksheet found:', sheet.name);

    const users = {};
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const username = String(row.getCell(1).value || '').trim();
        const password = String(row.getCell(2).value || '').trim();
        if (username && password) {
          users[username] = password;
        }
      }
    });
    if (Object.keys(users).length === 0) {
      throw new Error('Не знайдено користувачів у файлі');
    }
    console.log('Loaded users from Excel:', users);
    return users;
  } catch (error) {
    console.error('Error loading users from users.xlsx:', error.message, error.stack);
    throw error;
  }
};

/** Завантаження питань для тесту */
const loadQuestions = async (testNumber) => {
  try {
    const questionsFileUrl = testNames[testNumber].questionsFileUrl;
    if (!questionsFileUrl) {
      throw new Error(`Questions file URL for test ${testNumber} not found`);
    }

    // Загружаем файл из Vercel Blob
    const response = await get(questionsFileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const jsonData = [];
    const sheet = workbook.getWorksheet('Questions');

    if (!sheet) throw new Error(`Лист "Questions" не знайдено в questions${testNumber}.xlsx`);

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        const picture = String(rowValues[0] || '').trim();
        const questionText = String(rowValues[1] || '').trim();
        jsonData.push({
          picture: picture.match(/^Picture (\d+)/i) ? `/images/Picture ${picture.match(/^Picture (\d+)/i)[1]}.png` : null,
          text: questionText,
          options: rowValues.slice(2, 14).filter(Boolean),
          correctAnswers: rowValues.slice(14, 26).filter(Boolean),
          type: rowValues[26] || 'multiple',
          points: Number(rowValues[27]) || 0
        });
      }
    });
    return jsonData;
  } catch (error) {
    console.error(`Ошибка в loadQuestions (test ${testNumber}):`, error.stack);
    throw error;
  }
};

/** Перевірка ініціалізації сервера */
const ensureInitialized = (req, res, next) => {
  if (!isInitialized) {
    if (initializationError) {
      return res.status(500).json({ success: false, message: `Server initialization failed: ${initializationError.message}` });
    }
    return res.status(503).json({ success: false, message: 'Server is initializing, please try again later' });
  }
  next();
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

/** Налаштування Redis-клієнта */
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808',
  socket: {
    connectTimeout: 10000,
    reconnectStrategy: (retries) => Math.min(retries * 500, 3000)
  }
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('reconnecting', () => console.log('Redis reconnecting'));

/** Ініціалізація сервера */
const initializeServer = async () => {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      console.log(`Starting server initialization (Attempt ${attempt} of ${maxAttempts})...`);
      validPasswords = await loadUsers();
      console.log('Users loaded successfully:', validPasswords);
      await redisClient.connect();
      console.log('Connected to Redis and loaded users');
      isInitialized = true;
      initializationError = null;
      break;
    } catch (err) {
      console.error(`Failed to initialize server (Attempt ${attempt}):`, err.message, err.stack);
      initializationError = err;
      if (attempt < maxAttempts) {
        console.log(`Retrying initialization in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        console.error('Maximum initialization attempts reached. Server remains uninitialized.');
      }
      attempt++;
    }
  }
};

(async () => {
  await initializeServer();
  app.use(ensureInitialized);
})();

const CAMERA_MODE_KEY = 'camera_mode';
const getCameraMode = async () => {
  const mode = await redisClient.get(CAMERA_MODE_KEY);
  return mode === 'enabled';
};

const setCameraMode = async (enabled) => {
  await redisClient.set(CAMERA_MODE_KEY, enabled ? 'enabled' : 'disabled');
};

(async () => {
  const currentMode = await redisClient.get(CAMERA_MODE_KEY);
  if (!currentMode) {
    await setCameraMode(false);
  }
})();

app.get('/favicon.*', (req, res) => {
  res.status(404).send('Favicon not found');
});

/** Головна сторінка з формою входу */
app.get('/', (req, res) => {
  const savedPassword = req.cookies.savedPassword || '';
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
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
            margin: 0; 
            padding: 20px; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            box-sizing: border-box; 
          }
          .login-container { 
            text-align: center; 
            width: 100%; 
            max-width: 500px; 
          }
          h1 { 
            margin-bottom: 20px; 
          }
          input[type="password"], input[type="text"] { 
            font-size: 32px; 
            padding: 10px; 
            margin: 10px 0; 
            width: 100%; 
            box-sizing: border-box; 
          }
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
            margin: 10px 0; 
            width: 100%; 
            box-sizing: border-box; 
            border: none; 
            background-color: #007bff; 
            color: white; 
            border-radius: 5px; 
            cursor: pointer; 
          }
          button:hover { 
            background-color: #0056b3; 
          }
          .error { 
            color: red; 
            margin-top: 10px; 
          }
          .password-container { 
            position: relative; 
            width: 100%; 
          }
          .eye-icon { 
            display: block;
            position: absolute; 
            right: 10px; 
            top: 50%; 
            transform: translateY(-50%); 
            cursor: pointer; 
            font-size: 24px; 
          }
          .checkbox-container { 
            font-size: 24px; 
            margin: 10px 0; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            gap: 10px; 
          }
          input[type="checkbox"] { 
            width: 20px; 
            height: 20px; 
          }
          @media (max-width: 1024px) {
            body { 
              font-size: 48px; 
              padding: 30px; 
            }
            .login-container { 
              max-width: 100%; 
            }
            h1 { 
              font-size: 64px; 
              margin-bottom: 30px; 
            }
            input[type="password"], input[type="text"] { 
              font-size: 48px; 
              padding: 15px; 
              margin: 15px 0; 
            }
            button { 
              font-size: 48px; 
              padding: 15px 30px; 
              margin: 15px 0; 
            }
            .eye-icon { 
              font-size: 36px; 
              right: 15px; 
            }
            .checkbox-container { 
              font-size: 36px; 
              gap: 15px; 
            }
            input[type="checkbox"] { 
              width: 30px; 
              height: 30px; 
            }
            .error { 
              font-size: 36px; 
              margin-top: 15px; 
            }
          }
        </style>
      </head>
      <body>
        <div class="login-container">
          <h1>Введіть пароль</h1>
          <form id="loginForm" method="POST" action="/login">
            <div class="password-container">
              <input type="password" id="password" name="password" value="${savedPassword}" required>
              <span class="eye-icon" onclick="togglePassword()">👁️</span>
            </div>
            <div class="checkbox-container">
              <input type="checkbox" id="rememberMe" name="rememberMe">
              <label for="rememberMe">Запомнить меня</label>
            </div>
            <button type="submit">Увійти</button>
          </form>
          <p id="error" class="error"></p>
        </div>
        <script>
          async function login(event) {
            event.preventDefault();
            const password = document.getElementById('password').value;
            const rememberMe = document.getElementById('rememberMe').checked;
            const response = await fetch('/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password, rememberMe })
            });
            const result = await response.json();
            if (result.success) {
              window.location.href = result.redirect;
            } else {
              document.getElementById('error').textContent = result.message;
            }
          }
          document.getElementById('loginForm').addEventListener('submit', login);

          function togglePassword() {
            const passwordInput = document.getElementById('password');
            const eyeIcon = document.querySelector('.eye-icon');
            if (passwordInput.type === 'password') {
              passwordInput.type = 'text';
              eyeIcon.textContent = '👁️‍🗨️';
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

/** Обробка входу користувача */
app.post('/login', async (req, res) => {
  try {
    const { password, rememberMe } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    console.log('Checking password:', password, 'against validPasswords:', validPasswords);
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password.trim());
    if (!user) return res.status(401).json({ success: false, message: 'Невірний пароль' });

    res.cookie('auth', user, {
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

    if (user === 'admin') {
      res.json({ success: true, redirect: '/admin' });
    } else {
      res.json({ success: true, redirect: '/select-test' });
    }
  } catch (error) {
    console.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

/** Перевірка автентифікації */
const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  console.log('checkAuth: user from cookies:', user);
  if (!user || !validPasswords[user]) {
    console.log('checkAuth: No valid auth cookie, redirecting to /');
    return res.redirect('/');
  }
  console.log('checkAuth: User authenticated, proceeding...');
  req.user = user;
  next();
};

/** Перевірка прав адміністратора */
const checkAdmin = (req, res, next) => {
  const user = req.cookies.auth;
  console.log('checkAdmin: user from cookies:', user);
  if (user !== 'admin') {
    console.log('checkAdmin: Not admin, returning 403');
    return res.status(403).send('Доступно тільки для адміністратора (403 Forbidden)');
  }
  console.log('checkAdmin: Admin access granted, proceeding...');
  next();
};

/** Сторінка вибору тесту */
app.get('/select-test', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
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
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
            margin: 10px; 
            width: 100%; 
            max-width: 300px; 
            border: none; 
            border-radius: 5px; 
            background-color: #f0f0f0; 
            cursor: pointer; 
            transition: background-color 0.3s ease; 
          }
          button:hover { 
            background-color: #d0d0d0; 
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
              margin: 15px; 
              max-width: 100%; 
            }
          }
        </style>
      </head>
      <body>
        <h1>Виберіть тест</h1>
        ${Object.entries(testNames).map(([num, data]) => `
          <button onclick="window.location.href='/test?test=${num}'">${data.name}</button>
        `).join('')}
      </body>
    </html>
  `);
});

/** Отримання даних тесту користувача */
const getUserTest = async (user) => {
  const userTestData = await redisClient.get(`user_test:${user}`);
  if (!userTestData) return null;
  return JSON.parse(userTestData);
};

/** Збереження даних тесту користувача */
const setUserTest = async (user, userTest) => {
  await redisClient.set(`user_test:${user}`, JSON.stringify(userTest));
};

/** Видалення даних тесту користувача */
const deleteUserTest = async (user) => {
  await redisClient.del(`user_test:${user}`);
};

/** Форматування тривалості */
const formatDuration = (duration) => {
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  return `${minutes} хв ${seconds} с`;
};

/** Збереження результатів тесту */
const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime, suspiciousBehavior) => {
  try {
    if (!redisClient.isOpen) {
      console.log('Redis not connected in saveResult, attempting to reconnect...');
      await redisClient.connect();
      console.log('Reconnected to Redis in saveResult');
    }
    const keyType = await redisClient.type('test_results');
    console.log('Type of test_results before save:', keyType);
    if (keyType !== 'list' && keyType !== 'none') {
      console.log('Incorrect type detected, clearing test_results');
      await redisClient.del('test_results');
      console.log('test_results cleared, new type:', await redisClient.type('test_results'));
    }

    const userTest = await getUserTest(user);
    const answers = userTest ? userTest.answers : {};
    const questions = userTest ? userTest.questions : [];
    const scoresPerQuestion = questions.map((q, index) => {
      const userAnswer = answers[index];
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
      }
      return questionScore;
    });

    const duration = Math.round((endTime - startTime) / 1000);
    const result = {
      user,
      testNumber,
      score,
      totalPoints,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration,
      answers,
      scoresPerQuestion,
      suspiciousBehavior: suspiciousBehavior || 0
    };
    console.log('Saving result to Redis:', result);
    await redisClient.lPush('test_results', JSON.stringify(result));
    console.log(`Successfully saved result for ${user} in Redis`);
  } catch (error) {
    console.error('Ошибка сохранения в Redis:', error.stack);
    throw error;
  }
};

/** Початок тесту */
app.get('/test', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const testNumber = req.query.test;
  if (!testNames[testNumber]) return res.status(404).send('Тест не знайдено');
  try {
    const questions = await loadQuestions(testNumber);
    const userTest = {
      testNumber,
      questions,
      answers: {},
      currentQuestion: 0,
      startTime: Date.now(),
      timeLimit: testNames[testNumber].timeLimit * 1000,
      suspiciousBehavior: 0
    };
    await setUserTest(req.user, userTest);
    res.redirect(`/test/question?index=0`);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

/** Відображення питання тесту */
app.get('/test/question', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber, answers, currentQuestion, startTime, timeLimit } = userTest;
  const index = parseInt(req.query.index) || 0;

  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  userTest.currentQuestion = index;
  await setUserTest(req.user, userTest);
  const q = questions[index];
  console.log('Rendering question:', { index, picture: q.picture, text: q.text, options: q.options });

  const progress = Array.from({ length: questions.length }, (_, i) => {
    const answer = answers[i];
    let isAnswered = false;
    if (answer) {
      if (Array.isArray(answer)) {
        isAnswered = answer.length > 0;
      } else {
        isAnswered = String(answer).trim() !== '';
      }
    }
    return `<span style="display: inline-block; width: 30px; height: 30px; line-height: 30px; text-align: center; border-radius: 50%; background-color: ${i === index ? '#ff0000' : (isAnswered ? '#00ff00' : '#ff0000')}; color: white; margin: 2px;">${i + 1}</span>`;
  }).join('');

  const timeRemaining = Math.max(0, timeLimit - (Date.now() - startTime));
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

/** Збереження відповіді на питання */
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

/** Оновлення підозрілої поведінки */
app.post('/test/update-suspicious', checkAuth, async (req, res) => {
  const userTest = await getUserTest(req.user);
  if (!userTest) return res.status(400).json({ success: false, message: 'Тест не розпочато' });

  userTest.suspiciousBehavior = req.body.suspiciousBehavior || 0;
  await setUserTest(req.user, userTest);
  res.json({ success: true });
});

/** Завершення тесту */
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

/** Адмін-панель */
app.get('/admin', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));
    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        questionsByTest[testNumber] = await loadQuestions(testNumber).catch(err => {
          console.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
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
    console.error('Ошибка в /admin:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

/** Перемикання режиму камери */
app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
  try {
    const currentMode = await getCameraMode();
    await setCameraMode(!currentMode);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /admin/toggle-camera:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

/** Сторінка створення тесту */
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

/** Обробка створення тесту */
app.post('/admin/create-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
  try {
    const { testName, timeLimit } = req.body;
    const file = req.file;

    if (!testName || !timeLimit || !file) {
      return res.status(400).send('Усі поля обов’язкові');
    }

    const newTestNumber = String(Object.keys(testNames).length + 1);
    testNames[newTestNumber] = { name: testName, timeLimit: parseInt(timeLimit) };

    // Загружаем файл в Vercel Blob с обработкой ошибок
    let blob;
    try {
      blob = await put(`questions${newTestNumber}.xlsx`, fs.readFileSync(file.path), { access: 'public' });
    } catch (blobError) {
      console.error('Ошибка при загрузке в Vercel Blob:', blobError);
      throw new Error('Не удалось загрузить файл в хранилище');
    }

    // Сохраняем URL файла
    testNames[newTestNumber].questionsFileUrl = blob.url;

    // Удаляем временный файл из /tmp
    fs.unlinkSync(file.path);

    res.redirect('/admin');
  } catch (error) {
    console.error('Ошибка при создании теста:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

/** Сторінка редагування тестів */
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

/** Обробка редагування тесту */
app.post('/admin/edit-test', checkAdmin, async (req, res) => {
  try {
    const { testNumber, testName, timeLimit } = req.body;
    if (!testNames[testNumber]) return res.status(404).json({ success: false, message: 'Тест не знайдено' });

    testNames[testNumber] = { name: testName, timeLimit: parseInt(timeLimit) };
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /admin/edit-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

/** Перегляд результатів тестів */
app.get('/admin/view-results', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));
    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        questionsByTest[testNumber] = await loadQuestions(testNumber).catch(err => {
          console.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, err.stack);
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
          <button onclick="window.location.href='/admin'">Повернутися</button>
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
    console.error('Ошибка в /admin/view-results:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

/** Видалення результатів тестів */
app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  try {
    await redisClient.del('test_results');
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /admin/delete-results:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

/** Глобальний обробник помилок */
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).send('Помилка сервера');
});

/** Запуск сервера */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});