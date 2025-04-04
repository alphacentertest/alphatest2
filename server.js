const express = require('express');
const cookieParser = require('cookie-parser');
const { body, validationResult } = require('express-validator');
const ExcelJS = require('exceljs');
const bcrypt = require('bcrypt');
const { createClient } = require('redis');
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const multer = require('multer');

const app = express();

let testNames = {};
let isInitialized = false;
let initializationError = null;

// Настройка логирования
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// Настройка Multer для загрузки файлов
const upload = multer({ dest: '/tmp/uploads' });

// Настройка Redis
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808',
  socket: {
    connectTimeout: 10000,
    reconnectStrategy: (retries) => Math.min(retries * 500, 3000)
  }
});

redisClient.on('error', (err) => logger.error('Redis Client Error:', err));
redisClient.on('connect', () => logger.info('Redis connected'));
redisClient.on('reconnecting', () => logger.info('Redis reconnecting'));

const ensureRedisConnected = async () => {
  if (!redisClient.isOpen) {
    logger.info('Redis not connected, attempting to connect...');
    await redisClient.connect();
    logger.info('Redis connected successfully');
  }
};

// Загрузка пользователей
const loadUsers = async () => {
  try {
    logger.info('Attempting to load users from local file users.xlsx...');
    const filePath = path.join(__dirname, 'users.xlsx');
    logger.info(`Checking if file exists at path: ${filePath}`);

    // Используем синхронную проверку
    if (!require('fs').existsSync(filePath)) {
      logger.error(`File users.xlsx not found at path: ${filePath}`);
      throw new Error(`Файл ${filePath} не найден. Убедитесь, что файл users.xlsx находится в корне проекта.`);
    }
    logger.info('File users.xlsx exists');

    const workbook = new ExcelJS.Workbook();
    logger.info('Reading users.xlsx file...');
    await workbook.xlsx.readFile(filePath);
    logger.info('File read successfully');

    let sheet = workbook.getWorksheet('Users');
    if (!sheet) {
      logger.warn('Worksheet "Users" not found, trying "Sheet1"');
      sheet = workbook.getWorksheet('Sheet1');
      if (!sheet) {
        logger.error('No "Users" or "Sheet1" worksheet found');
        throw new Error('Ни один из листов ("Users" или "Sheet1") не найден');
      }
    }
    logger.info('Worksheet found:', sheet.name);

    const rowCount = sheet.rowCount;
    logger.info(`Total rows in worksheet: ${rowCount}`);

    const users = {};
    await ensureRedisConnected();
    await redisClient.del('users');

    const userRows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const username = String(row.getCell(1).value || '').trim();
        const password = String(row.getCell(2).value || '').trim();
        if (username && password) {
          userRows.push({ username, password });
        } else {
          logger.warn(`Invalid data in row ${rowNumber}: username=${username}, password=${password}`);
        }
      }
    });

    if (userRows.length === 0) {
      logger.error('No valid users found in users.xlsx');
      throw new Error('Не знайдено користувачів у файлі');
    }

    logger.info('Users loaded from Excel:', userRows);

    const saltRounds = 10;
    for (const { username, password } of userRows) {
      logger.info(`Hashing password for user ${username}: ${password}`);
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      logger.info(`Hashed password for user ${username}: ${hashedPassword}`);
      await redisClient.hSet('users', username, hashedPassword);
      users[username] = password; // Сохраняем для отладки
    }

    logger.info('Loaded users and stored in Redis');
    return users;
  } catch (error) {
    logger.error('Error loading users from local file:', error.message, error.stack);
    throw error;
  }
};

// Загрузка вопросов
const loadQuestions = async (questionsFile) => {
  try {
    const filePath = path.join(__dirname, questionsFile);
    logger.info(`Attempting to load questions from file: ${filePath}`);

    // Проверяем наличие файла
    if (!require('fs').existsSync(filePath)) {
      logger.error(`File ${questionsFile} not found at path: ${filePath}`);
      throw new Error(`Файл ${questionsFile} не знайдено. Переконайтеся, що файл присутній у корені проекту.`);
    }
    logger.info(`File ${questionsFile} exists at path: ${filePath}`);

    const workbook = new ExcelJS.Workbook();
    logger.info(`Reading ${questionsFile} file...`);
    await workbook.xlsx.readFile(filePath);
    logger.info(`File ${questionsFile} read successfully`);

    const sheet = workbook.getWorksheet('Questions');
    if (!sheet) {
      logger.error(`Worksheet "Questions" not found in ${questionsFile}`);
      throw new Error(`Лист "Questions" не знайдено в ${questionsFile}`);
    }
    logger.info(`Worksheet "Questions" found in ${questionsFile}`);

    const jsonData = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        const picture = String(rowValues[0] || '').trim();
        const questionText = String(rowValues[1] || '').trim();
        if (!questionText) {
          logger.warn(`Empty question text in row ${rowNumber} of ${questionsFile}`);
          return;
        }
        jsonData.push({
          picture: picture.match(/^Picture (\d+)/i) ? `/images/Picture ${picture.match(/^Picture (\d+)/i)[1]}.png` : null,
          text: questionText,
          options: rowValues.slice(2, 8).filter(Boolean),
          correctAnswers: rowValues.slice(8, 11).filter(Boolean),
          type: rowValues[11] || 'multiple',
          points: Number(rowValues[12]) || 0
        });
      }
    });

    if (jsonData.length === 0) {
      logger.error(`No valid questions found in ${questionsFile}`);
      throw new Error(`Не знайдено питань у файлі ${questionsFile}`);
    }

    logger.info(`Loaded ${jsonData.length} questions from ${questionsFile}`);
    return jsonData;
  } catch (error) {
    logger.error(`Error in loadQuestions (${questionsFile}): ${error.message}`, error.stack);
    throw error;
  }
};

// Загрузка названий тестов
const loadTestNames = async () => {
  try {
    await ensureRedisConnected();
    const storedTestNames = await redisClient.get('testNames');
    if (storedTestNames) {
      testNames = JSON.parse(storedTestNames);
      logger.info('Test names loaded from Redis:', testNames);
    } else {
      // Вручную задаём тесты, если они не найдены в Redis
      testNames = {
        '1': { name: 'Тест 1', timeLimit: 300, questionsFile: 'questions1.xlsx' },
        '2': { name: 'Тест 2', timeLimit: 600, questionsFile: 'questions2.xlsx' }
      };
      await redisClient.set('testNames', JSON.stringify(testNames));
      logger.info('Initialized test names:', testNames);
    }
  } catch (error) {
    logger.error('Error loading test names:', error.stack);
  }
};

// Инициализация сервера
const initializeServer = async () => {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      logger.info(`Starting server initialization (Attempt ${attempt} of ${maxAttempts})...`);
      const users = await loadUsers();
      logger.info('Users loaded successfully:', users);
      await ensureRedisConnected();
      logger.info('Connected to Redis and loaded users');
      await loadTestNames();
      logger.info('Test names loaded successfully');
      isInitialized = true;
      initializationError = null;
      break;
    } catch (err) {
      logger.error(`Failed to initialize server (Attempt ${attempt}):`, err.message, err.stack);
      initializationError = err;
      if (attempt < maxAttempts) {
        logger.info(`Retrying initialization in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        logger.error('Maximum initialization attempts reached. Server remains uninitialized.');
      }
      attempt++;
    }
  }
};

// Middleware для проверки инициализации
const ensureInitialized = (req, res, next) => {
  if (!isInitialized) {
    if (initializationError) {
      return res.status(500).json({ success: false, message: `Server initialization failed: ${initializationError.message}` });
    }
    return res.status(503).json({ success: false, message: 'Server is initializing, please try again later' });
  }
  next();
};

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());
app.use(ensureInitialized);

// Главная страница
app.get('/', async (req, res) => {
  const user = req.cookies.auth;
  const savedPassword = req.cookies.savedPassword || '';
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
        <link rel="icon" href="/favicon.ico" type="image/x-icon">
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
          form { 
            display: flex; 
            flex-direction: column; 
            gap: 10px; 
            width: 100%; 
            max-width: 500px; 
          }
          .password-container {
            position: relative;
            width: 100%;
            max-width: 500px;
          }
          input[type="password"], input[type="text"] { 
            font-size: 24px; 
            padding: 10px; 
            width: 100%; 
            box-sizing: border-box;
          }
          .eye-icon {
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-50%);
            cursor: pointer;
            font-size: 24px;
          }
          label { 
            font-size: 24px; 
            display: flex; 
            align-items: center; 
            gap: 10px; 
          }
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
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
            font-size: 24px; 
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
            form { 
              gap: 15px; 
            }
            input[type="password"], input[type="text"] { 
              font-size: 32px; 
              padding: 15px; 
            }
            .eye-icon {
              font-size: 32px;
              right: 15px;
            }
            label { 
              font-size: 32px; 
            }
            button { 
              font-size: 48px; 
              padding: 15px 30px; 
            }
            .error { 
              font-size: 32px; 
            }
          }
        </style>
      </head>
      <body>
        <h1>Вхід</h1>
        <form id="loginForm" method="POST" action="/login">
          <div class="password-container">
            <input type="password" id="passwordInput" name="password" placeholder="Введіть пароль" value="${savedPassword}" required>
            <span class="eye-icon" id="eyeIcon">👁️</span>
          </div>
          <label>
            <input type="checkbox" name="rememberMe" ${savedPassword ? 'checked' : ''}>
            Запам'ятати пароль
          </label>
          <button type="submit">Увійти</button>
        </form>
        <div id="error" class="error"></div>
        <script>
          document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const response = await fetch('/login', {
              method: 'POST',
              body: JSON.stringify({
                password: formData.get('password'),
                rememberMe: formData.get('rememberMe') === 'on'
              }),
              headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();
            if (result.success) {
              window.location.href = result.redirect;
            } else {
              document.getElementById('error').textContent = result.message;
            }
          });

          // Добавляем функциональность для "глаза"
          const passwordInput = document.getElementById('passwordInput');
          const eyeIcon = document.getElementById('eyeIcon');
          eyeIcon.addEventListener('click', () => {
            if (passwordInput.type === 'password') {
              passwordInput.type = 'text';
              eyeIcon.textContent = '👁️';
            } else {
              passwordInput.type = 'password';
              eyeIcon.textContent = '👁️';
            }
          });
        </script>
      </body>
    </html>
  `);
});

// Маршрут логина
app.post('/login', [
  body('password').notEmpty().withMessage('Пароль не вказано')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { password, rememberMe } = req.body;
    logger.info('Checking password for user input, input password:', password);

    await ensureRedisConnected();
    const storedUsers = await redisClient.hGetAll('users');
    logger.info('Stored users in Redis:', storedUsers);

    let matchedUser = null;
    for (const [username, hashedPassword] of Object.entries(storedUsers)) {
      logger.info(`Comparing password for user ${username}, input: ${password}, hashed: ${hashedPassword}`);
      const match = await bcrypt.compare(password, hashedPassword);
      if (match) {
        logger.info(`Password match for user: ${username}`);
        matchedUser = username;
        break;
      }
    }

    if (!matchedUser) {
      logger.warn('Failed login attempt with password:', password);
      return res.status(401).json({ success: false, message: 'Невірний пароль' });
    }

    logger.info(`Successful login for user: ${matchedUser}`);
    res.cookie('auth', matchedUser, {
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

    if (matchedUser === 'admin') {
      res.json({ success: true, redirect: '/admin' });
    } else {
      res.json({ success: true, redirect: '/select-test' });
    }
  } catch (error) {
    logger.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера' });
  }
});

// Проверка авторизации
const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  logger.info('checkAuth: user from cookies:', user);
  if (!user) {
    logger.info('checkAuth: No auth cookie, redirecting to /');
    return res.redirect('/');
  }
  req.user = user;
  next();
};

// Проверка администратора
const checkAdmin = (req, res, next) => {
  const user = req.cookies.auth;
  logger.info('checkAdmin: user from cookies:', user);
  if (user !== 'admin') {
    logger.info('checkAdmin: Not admin, returning 403');
    return res.status(403).send('Доступно тільки для адміністратора (403 Forbidden)');
  }
  next();
};

// Выбор теста
app.get('/select-test', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Вибір тесту</title>
        <style>
          body { font-size: 32px; margin: 20px; text-align: center; }
          button { font-size: 32px; padding: 10px 20px; margin: 10px; }
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

const userTests = new Map();

// Сохранение результатов
const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime) => {
  try {
    await ensureRedisConnected();
    const keyType = await redisClient.type('test_results');
    logger.info('Type of test_results before save:', keyType);
    if (keyType !== 'list' && keyType !== 'none') {
      logger.info('Incorrect type detected, clearing test_results');
      await redisClient.del('test_results');
      logger.info('test_results cleared, new type:', await redisClient.type('test_results'));
    }

    const userTest = userTests.get(user);
    const answers = userTest ? userTest.answers : {};
    const questions = userTest ? userTest.questions : [];
    const scoresPerQuestion = questions.map((q, index) => {
      const userAnswer = answers[index];
      let questionScore = 0;
      if (!q.options || q.options.length === 0) {
        if (userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase()) {
          questionScore = q.points;
        }
      } else {
        if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
          const correctAnswers = q.correctAnswers.map(String);
          const userAnswers = userAnswer.map(String);
          if (correctAnswers.length === userAnswers.length && 
              correctAnswers.every(val => userAnswers.includes(val)) && 
              userAnswers.every(val => correctAnswers.includes(val))) {
            questionScore = q.points;
          }
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
      scoresPerQuestion
    };
    logger.info('Saving result to Redis:', result);
    await redisClient.lPush('test_results', JSON.stringify(result));
    logger.info(`Successfully saved result for ${user} in Redis`);
    logger.info('Type of test_results after save:', await redisClient.type('test_results'));
  } catch (error) {
    logger.error('Ошибка сохранения в Redis:', error.stack);
  }
};

// Начало теста
app.get('/test', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const testNumber = req.query.test;
  if (!testNames[testNumber]) {
    logger.warn(`Test number ${testNumber} not found in testNames`);
    return res.status(404).send('Тест не знайдено');
  }

  try {
    logger.info(`Loading questions for test ${testNumber} from file ${testNames[testNumber].questionsFile}`);
    const questions = await loadQuestions(testNames[testNumber].questionsFile);
    userTests.set(req.user, {
      testNumber,
      questions,
      answers: {},
      currentQuestion: 0,
      startTime: Date.now(),
      timeLimit: testNames[testNumber].timeLimit * 1000
    });
    logger.info(`Test ${testNumber} started for user ${req.user}`);
    res.redirect(`/test/question?index=0`);
  } catch (error) {
    logger.error(`Error in /test for test ${testNumber}: ${error.message}`, error.stack);
    res.status(500).send(`Помилка при завантаженні тесту: ${error.message}`);
  }
});

// Отображение вопроса
app.get('/test/question', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber, answers, currentQuestion, startTime, timeLimit } = userTest;
  const index = parseInt(req.query.index) || 0;

  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  userTest.currentQuestion = index;
  const q = questions[index];
  logger.info('Rendering question:', { index, picture: q.picture, text: q.text, options: q.options });

  const progress = Array.from({ length: questions.length }, (_, i) => ({
    number: i + 1,
    answered: !!answers[i]
  }));

  const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
  const remainingTime = Math.max(0, Math.floor(timeLimit / 1000) - elapsedTime);
  const minutes = Math.floor(remainingTime / 60).toString().padStart(2, '0');
  const seconds = (remainingTime % 60).toString().padStart(2, '0');

  let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>${testNames[testNumber].name}</title>
        <style>
          body { font-size: 32px; margin: 0; padding: 20px; padding-bottom: 80px; }
          img { max-width: 300px; }
          .option-box { border: 2px solid #ccc; padding: 10px; margin: 5px 0; border-radius: 5px; }
          .progress-bar { display: flex; align-items: center; margin-bottom: 20px; }
          .progress-line { flex-grow: 1; height: 2px; background-color: #ccc; }
          .progress-circle { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 5px; }
          .progress-circle.unanswered { background-color: red; color: white; }
          .progress-circle.answered { background-color: green; color: white; }
          .progress-line.answered { background-color: green; }
          .option-box.selected { background-color: #90ee90; }
          .button-container { position: fixed; bottom: 20px; left: 20px; right: 20px; display: flex; justify-content: space-between; }
          button { font-size: 32px; padding: 10px 20px; border: none; cursor: pointer; }
          .back-btn { background-color: red; color: white; }
          .next-btn { background-color: blue; color: white; }
          .finish-btn { background-color: green; color: white; }
          button:disabled { background-color: grey; cursor: not-allowed; }
          #timer { font-size: 24px; margin-bottom: 20px; }
          #confirm-modal { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 20px; border: 2px solid black; z-index: 1000; }
          #confirm-modal button { margin: 0 10px; }
        </style>
      </head>
      <body>
        <h1>${testNames[testNumber].name}</h1>
        <div id="timer">Залишилося часу: ${minutes} мм ${seconds} с</div>
        <div class="progress-bar">
          ${progress.map((p, i) => `
            <div class="progress-circle ${p.answered ? 'answered' : 'unanswered'}">${p.number}</div>
            ${i < progress.length - 1 ? '<div class="progress-line ' + (p.answered ? 'answered' : '') + '"></div>' : ''}
          `).join('')}
        </div>
        <div>
  `;
  if (q.picture) {
    html += `<img src="${q.picture}" alt="Picture" onerror="this.src='/images/placeholder.png'; console.log('Image failed to load: ${q.picture}')"><br>`;
  }
  html += `
          <p>${index + 1}. ${q.text}</p>
  `;
  if (!q.options || q.options.length === 0) {
    const userAnswer = answers[index] || '';
    html += `
      <input type="text" name="q${index}" id="q${index}_input" value="${userAnswer}" placeholder="Введіть відповідь"><br>
    `;
  } else {
    q.options.forEach((option, optIndex) => {
      const checked = answers[index]?.includes(option) ? 'checked' : '';
      html += `
        <div class="option-box ${checked ? 'selected' : ''}">
          <input type="checkbox" name="q${index}" value="${option}" id="q${index}_${optIndex}" ${checked}>
          <label for="q${index}_${optIndex}">${option}</label>
        </div>
      `;
    });
  }
  html += `
        </div>
        <div class="button-container">
          <button class="back-btn" ${index === 0 ? 'disabled' : ''} onclick="window.location.href='/test/question?index=${index - 1}'">Назад</button>
          <button class="next-btn" ${index === questions.length - 1 ? 'disabled' : ''} onclick="saveAndNext(${index})">Вперед</button>
          <button class="finish-btn" onclick="showConfirm(${index})">Завершити тест</button>
        </div>
        <div id="confirm-modal">
          <h2>Ви дійсно бажаєте завершити тест?</h2>
          <button onclick="finishTest(${index})">Так</button>
          <button onclick="hideConfirm()">Ні</button>
        </div>
        <script>
          let startTime = ${startTime};
          let timeLimit = ${timeLimit};
          const timerElement = document.getElementById('timer');
          function updateTimer() {
            const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
            const remainingTime = Math.max(0, Math.floor(timeLimit / 1000) - elapsedTime);
            const minutes = Math.floor(remainingTime / 60).toString().padStart(2, '0');
            const seconds = (remainingTime % 60).toString().padStart(2, '0');
            timerElement.textContent = 'Залишилося часу: ' + minutes + ' мм ' + seconds + ' с';
            if (remainingTime <= 0) {
              window.location.href = '/result';
            }
          }
          updateTimer();
          setInterval(updateTimer, 1000);

          async function saveAndNext(index) {
            let answers;
            if (document.querySelector('input[type="text"][name="q' + index + '"]')) {
              answers = document.getElementById('q' + index + '_input').value;
            } else {
              const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
              answers = Array.from(checked).map(input => input.value);
            }
            await fetch('/answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index, answer: answers })
            });
            window.location.href = '/test/question?index=' + (index + 1);
          }

          function showConfirm(index) {
            document.getElementById('confirm-modal').style.display = 'block';
          }

          function hideConfirm() {
            document.getElementById('confirm-modal').style.display = 'none';
          }

          async function finishTest(index) {
            let answers;
            if (document.querySelector('input[type="text"][name="q' + index + '"]')) {
              answers = document.getElementById('q' + index + '_input').value;
            } else {
              const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
              answers = Array.from(checked).map(input => input.value);
            }
            await fetch('/answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index, answer: answers })
            });
            hideConfirm();
            window.location.href = '/result';
          }
        </script>
      </body>
    </html>
  `;
  res.send(html);
});

// Сохранение ответа
app.post('/answer', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  try {
    const { index, answer } = req.body;
    const userTest = userTests.get(req.user);
    if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });
    userTest.answers[index] = answer;
    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Результат теста
app.get('/result', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });

  const { questions, answers, testNumber, startTime } = userTest;
  let score = 0;
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

  questions.forEach((q, index) => {
    const userAnswer = answers[index];
    if (!q.options || q.options.length === 0) {
      if (userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase()) {
        score += q.points;
      }
    } else {
      if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
        const correctAnswers = q.correctAnswers.map(String);
        const userAnswers = userAnswer.map(String);
        if (correctAnswers.length === userAnswers.length && 
            correctAnswers.every(val => userAnswers.includes(val)) && 
            userAnswers.every(val => correctAnswers.includes(val))) {
          score += q.points;
        }
      }
    }
  });

  const endTime = Date.now();
  await saveResult(req.user, testNumber, score, totalPoints, startTime, endTime);

  const resultHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати ${testNames[testNumber].name}</title>
        <style>
          body { font-size: 32px; margin: 20px; text-align: center; }
          button { font-size: 32px; padding: 10px 20px; margin: 10px; }
        </style>
      </head>
      <body>
        <h1>Результати ${testNames[testNumber].name}</h1>
        <p>Ваш результат: ${score} з ${totalPoints}</p>
        <button onclick="window.location.href='/results'">Переглянути результати</button>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(resultHtml);
});

// Просмотр результатов
app.get('/results', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const userTest = userTests.get(req.user);
  let resultsHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати</title>
        <style>
          body { font-size: 32px; margin: 20px; text-align: center; }
          button { font-size: 32px; padding: 10px 20px; margin: 10px; }
        </style>
      </head>
      <body>
        <h1>Результати</h1>
  `;
  
  if (userTest) {
    const { questions, answers, testNumber, startTime } = userTest;
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

    questions.forEach((q, index) => {
      const userAnswer = answers[index];
      if (!q.options || q.options.length === 0) {
        if (userAnswer && String(userAnswer).trim().toLowerCase() === String(q.correctAnswers[0]).trim().toLowerCase()) {
          score += q.points;
        }
      } else {
        if (q.type === 'multiple' && userAnswer && userAnswer.length > 0) {
          const correctAnswers = q.correctAnswers.map(String);
          const userAnswers = userAnswer.map(String);
          if (correctAnswers.length === userAnswers.length && 
              correctAnswers.every(val => userAnswers.includes(val)) && 
              userAnswers.every(val => correctAnswers.includes(val))) {
            score += q.points;
          }
        }
      }
    });
    const duration = Math.round((Date.now() - startTime) / 1000);
    resultsHtml += `
      <p>${testNames[testNumber].name}: ${score} з ${totalPoints}, тривалість: ${duration} сек</p>
    `;
    userTests.delete(req.user);
  } else {
    resultsHtml += '<p>Немає завершених тестів</p>';
  }

  resultsHtml += `
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(resultsHtml);
});

// Админ-панель
app.get('/admin', checkAuth, checkAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Адмін-панель</title>
        <style>
          body { font-size: 24px; margin: 20px; text-align: center; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Адмін-панель</h1>
        <button onclick="window.location.href='/admin/results'">Переглянути результати</button>
        <button onclick="window.location.href='/admin/delete-results'">Видалити результати</button>
        <button onclick="window.location.href='/admin/edit-tests'">Редагувати назви тестів</button>
        <button onclick="window.location.href='/admin/create-test'">Створити новий тест</button>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `);
});

// Просмотр результатов (админ)
app.get('/admin/results', checkAuth, checkAdmin, async (req, res) => {
  let results = [];
  let errorMessage = '';
  try {
    await ensureRedisConnected();
    const keyType = await redisClient.type('test_results');
    logger.info('Type of test_results:', keyType);
    if (keyType !== 'list' && keyType !== 'none') {
      errorMessage = `Неверный тип данных для test_results: ${keyType}. Ожидается list.`;
      logger.error(errorMessage);
    } else {
      results = await redisClient.lRange('test_results', 0, -1);
      logger.info('Fetched results from Redis:', results);
    }
  } catch (fetchError) {
    logger.error('Ошибка при получении данных из Redis:', fetchError);
    errorMessage = `Ошибка Redis: ${fetchError.message}`;
  }

  let adminHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати всіх користувачів</title>
        <style>
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid black; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .error { color: red; }
          .answers { white-space: pre-wrap; max-width: 300px; overflow-wrap: break-word; line-height: 1.8; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Результати всіх користувачів</h1>
  `;
  if (errorMessage) {
    adminHtml += `<p class="error">${errorMessage}</p>`;
  }
  adminHtml += `
        <table>
          <tr>
            <th>Користувач</th>
            <th>Тест</th>
            <th>Очки</th>
            <th>Максимум</th>
            <th>Початок</th>
            <th>Кінець</th>
            <th>Тривалість (сек)</th>
            <th>Відповіді та бали</th>
          </tr>
  `;
  if (!results || results.length === 0) {
    adminHtml += '<tr><td colspan="8">Немає результатів</td></tr>';
    logger.info('No results found in test_results');
  } else {
    results.forEach((result, index) => {
      try {
        const r = JSON.parse(result);
        logger.info(`Parsed result ${index}:`, r);
        const answersDisplay = r.answers 
          ? Object.entries(r.answers).map(([q, a], i) => 
              `Питання ${parseInt(q) + 1}: ${Array.isArray(a) ? a.join(', ') : a} (${r.scoresPerQuestion[i] || 0} балів)`
            ).join('\n')
          : 'Немає відповідей';
        const formatDateTime = (isoString) => {
          if (!isoString) return 'N/A';
          const date = new Date(isoString);
          return `${date.toLocaleTimeString('uk-UA', { hour12: false })} ${date.toLocaleDateString('uk-UA')}`;
        };
        adminHtml += `
          <tr>
            <td>${r.user || 'N/A'}</td>
            <td>${testNames[r.testNumber]?.name || 'N/A'}</td>
            <td>${r.score || '0'}</td>
            <td>${r.totalPoints || '0'}</td>
            <td>${formatDateTime(r.startTime)}</td>
            <td>${formatDateTime(r.endTime)}</td>
            <td>${r.duration || 'N/A'}</td>
            <td class="answers">${answersDisplay}</td>
          </tr>
        `;
      } catch (parseError) {
        logger.error(`Ошибка парсинга результата ${index}:`, parseError, 'Raw data:', result);
      }
    });
  }
  adminHtml += `
        </table>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `;
  res.send(adminHtml);
});

// Удаление результатов (админ)
app.get('/admin/delete-results', checkAuth, checkAdmin, async (req, res) => {
  try {
    await ensureRedisConnected();
    await redisClient.del('test_results');
    logger.info('Test results deleted from Redis');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Видалено результати</title>
          <style>
            body { font-size: 32px; margin: 20px; text-align: center; }
            button { font-size: 32px; padding: 10px 20px; margin: 10px; }
          </style>
        </head>
        <body>
          <h1>Результати успішно видалено</h1>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('Ошибка при удалении результатов:', error.stack);
    res.status(500).send('Помилка при видаленні результатів');
  }
});

// Редактирование тестов (админ)
app.get('/admin/edit-tests', checkAuth, checkAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Редагувати назви тестів</title>
        <style>
          body { font-size: 24px; margin: 20px; text-align: center; }
          input { font-size: 24px; padding: 5px; margin: 5px; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Редагувати назви та час тестів</h1>
        <form method="POST" action="/admin/edit-tests">
          ${Object.entries(testNames).map(([num, data]) => `
            <div>
              <label for="test${num}">Назва Тесту ${num}:</label>
              <input type="text" id="test${num}" name="test${num}" value="${data.name}" required>
              <label for="time${num}">Час (сек):</label>
              <input type="number" id="time${num}" name="time${num}" value="${data.timeLimit}" required min="1">
            </div>
          `).join('')}
          <button type="submit">Зберегти</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `);
});

app.post('/admin/edit-tests', checkAuth, checkAdmin, async (req, res) => {
  try {
    Object.keys(testNames).forEach((num) => {
      const testName = req.body[`test${num}`];
      const timeLimit = parseInt(req.body[`time${num}`]);
      if (testName && timeLimit) {
        testNames[num] = {
          ...testNames[num],
          name: testName,
          timeLimit: timeLimit
        };
      }
    });
    await redisClient.set('testNames', JSON.stringify(testNames));
    logger.info('Updated test names and time limits:', testNames);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Назви оновлено</title>
          <style>
            body { font-size: 32px; margin: 20px; text-align: center; }
            button { font-size: 32px; padding: 10px 20px; margin: 10px; }
          </style>
        </head>
        <body>
          <h1>Назви та час тестів успішно оновлено</h1>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('Ошибка при редактировании названий тестов:', error.stack);
    res.status(500).send('Помилка при оновленні назв тестів');
  }
});

// Создание нового теста (админ)
app.get('/admin/create-test', checkAuth, checkAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Створити новий тест</title>
        <style>
          body { font-size: 24px; margin: 20px; text-align: center; }
          input { font-size: 24px; padding: 5px; margin: 5px; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Створити новий тест</h1>
        <form method="POST" action="/admin/create-test" enctype="multipart/form-data">
          <div>
            <label for="testName">Назва нового тесту:</label>
            <input type="text" id="testName" name="testName" required>
          </div>
          <div>
            <label for="timeLimit">Час (сек):</label>
            <input type="number" id="timeLimit" name="timeLimit" value="3600" required min="1">
          </div>
          <div>
            <label for="questionsFile">Файл з питаннями (Excel):</label>
            <input type="file" id="questionsFile" name="questionsFile" accept=".xlsx" required>
          </div>
          <button type="submit">Створити</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `);
});

app.post('/admin/create-test', checkAuth, checkAdmin, upload.single('questionsFile'), async (req, res) => {
  try {
    const { testName, timeLimit } = req.body;
    const file = req.file;

    if (!testName || !timeLimit || !file) {
      return res.status(400).send('Усі поля обов’язкові');
    }

    const newTestNumber = String(Object.keys(testNames).length + 1);
    const questionsFileName = `questions${newTestNumber}.xlsx`;

    // В Vercel нельзя сохранять файлы в корень проекта, поэтому временно используем /tmp
    const tempPath = path.join('/tmp', questionsFileName);
    await fs.rename(file.path, tempPath);
    logger.info(`Temporarily saved questions file as ${tempPath}`);

    testNames[newTestNumber] = { name: testName, timeLimit: parseInt(timeLimit), questionsFile: questionsFileName };
    await redisClient.set('testNames', JSON.stringify(testNames));

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Тест створено</title>
          <style>
            body { font-size: 32px; margin: 20px; text-align: center; }
            button { font-size: 32px; padding: 10px 20px; margin: 10px; }
          </style>
        </head>
        <body>
          <h1>Новий тест "${testName}" створено</h1>
          <p>Внимание: В Vercel файлы не сохраняются в корень проекта. Добавьте файл ${questionsFileName} вручную в проект.</p>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('Ошибка при создании теста:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

// Временный маршрут для проверки файлов в корне проекта
app.get('/list-files', (req, res) => {
  const fs = require('fs');
  const dirPath = __dirname;
  logger.info(`Listing files in directory: ${dirPath}`);
  fs.readdir(dirPath, (err, files) => {
    if (err) {
      logger.error(`Error reading directory: ${err.message}`, err.stack);
      return res.status(500).send(`Error reading directory: ${err.message}`);
    }
    logger.info(`Files in directory: ${files}`);
    res.send(`
      <h1>Files in project root:</h1>
      <ul>
        ${files.map(file => `<li>${file}</li>`).join('')}
      </ul>
    `);
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
(async () => {
  await initializeServer();
  if (!isInitialized) {
    logger.error('Server failed to initialize after all attempts. Exiting...');
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });
})();