const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('redis');
const fs = require('fs');

const app = express();

let validPasswords = {};
let isInitialized = false;
let initializationError = null;
let testNames = { 
  '1': { name: 'Тест 1', timeLimit: 3600 },
  '2': { name: 'Тест 2', timeLimit: 3600 }
};

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
        console.error('Worksheet "Sheet1" not found in users.xlsx');
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
      console.error('No valid users found in users.xlsx');
      throw new Error('Не знайдено користувачів у файлі');
    }
    console.log('Loaded users from Excel:', users);
    return users;
  } catch (error) {
    console.error('Error loading users from users.xlsx:', error.message, error.stack);
    throw error;
  }
};

const loadQuestions = async (testNumber) => {
  try {
    const filePath = path.join(__dirname, `questions${testNumber}.xlsx`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File questions${testNumber}.xlsx not found at path: ${filePath}`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
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

app.post('/login', async (req, res) => {
  try {
    const { password, rememberMe } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    console.log('Checking password:', password, 'against validPasswords:', validPasswords);
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
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

const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  console.log('checkAuth: user from cookies:', user);
  if (!user || !validPasswords[user]) {
    console.log('checkAuth: No valid auth cookie, redirecting to /');
    return res.redirect('/');
  }
  req.user = user;
  next();
};

const checkAdmin = (req, res, next) => {
  const user = req.cookies.auth;
  console.log('checkAdmin: user from cookies:', user);
  if (user !== 'admin') {
    console.log('checkAdmin: Not admin, returning 403');
    return res.status(403).send('Доступно тільки для адміністратора (403 Forbidden)');
  }
  next();
};

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

const userTests = new Map();

const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime) => {
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
      scoresPerQuestion
    };
    console.log('Saving result to Redis:', result);
    await redisClient.lPush('test_results', JSON.stringify(result));
    console.log(`Successfully saved result for ${user} in Redis`);
    console.log('Type of test_results after save:', await redisClient.type('test_results'));
  } catch (error) {
    console.error('Ошибка сохранения в Redis:', error.stack);
  }
};

app.get('/test', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const testNumber = req.query.test;
  if (!testNames[testNumber]) return res.status(404).send('Тест не знайдено');
  try {
    const questions = await loadQuestions(testNumber);
    userTests.set(req.user, {
      testNumber,
      questions,
      answers: {},
      currentQuestion: 0,
      startTime: Date.now(),
      timeLimit: testNames[testNumber].timeLimit * 1000
    });
    res.redirect(`/test/question?index=0`);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

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
    return {
      number: i + 1,
      answered: isAnswered
    };
  });

  const elapsedTime = Math.floor((Date.now() - startTime) / 1000);
  const remainingTime = Math.max(0, Math.floor(timeLimit / 1000) - elapsedTime);
  const minutes = Math.floor(remainingTime / 60).toString().padStart(2, '0');
  const seconds = (remainingTime % 60).toString().padStart(2, '0');

  let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${testNames[testNumber].name}</title>
        <style>
          body { 
            font-size: 32px; 
            margin: 0; 
            padding: 20px; 
            padding-bottom: 100px; 
            overflow-y: auto; 
          }
          img { 
            max-width: 300px; 
          }
          .question-container { 
            margin-bottom: 20px; 
          }
          .instruction { 
            font-style: italic; 
            font-size: 24px; 
            color: #555; 
            margin-top: 10px; 
          }
          .option-box { 
            border: 2px solid #ccc; 
            padding: 10px; 
            margin: 10px 0; 
            border-radius: 5px; 
            width: 100%; 
            box-sizing: border-box; 
            text-align: center; 
          }
          .progress-bar { 
            display: flex; 
            flex-wrap: wrap; 
            gap: 5px; 
            margin-bottom: 20px; 
          }
          .progress-circle { 
            width: 30px; 
            height: 30px; 
            border-radius: 50%; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            font-size: 20px; 
          }
          .progress-circle.unanswered { 
            background-color: red; 
            color: white; 
          }
          .progress-circle.answered { 
            background-color: green; 
            color: white; 
          }
          .option-box.selected { 
            background-color: #90ee90; 
          }
          .button-container { 
            position: fixed; 
            bottom: 20px; 
            left: 20px; 
            right: 20px; 
            display: flex; 
            justify-content: space-between; 
          }
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
            border: none; 
            cursor: pointer; 
            width: 30%; 
            border-radius: 5px; 
          }
          .back-btn { 
            background-color: red; 
            color: white; 
          }
          .next-btn { 
            background-color: blue; 
            color: white; 
          }
          .finish-btn { 
            background-color: green; 
            color: white; 
          }
          button:disabled { 
            background-color: grey; 
            cursor: not-allowed; 
          }
          #timer { 
            font-size: 24px; 
            margin-bottom: 20px; 
          }
          #confirm-modal { 
            display: none; 
            position: fixed; 
            top: 50%; 
            left: 50%; 
            transform: translate(-50%, -50%); 
            background: white; 
            padding: 20px; 
            border: 2px solid black; 
            z-index: 1000; 
          }
          #confirm-modal button { 
            margin: 0 10px; 
          }
          .sortable { 
            cursor: move; 
            touch-action: none; 
          }
          .sortable.dragging { 
            opacity: 0.5; 
          }
          input[type="checkbox"] { 
            width: 20px; 
            height: 20px; 
            margin-right: 10px; 
          }
          label { 
            font-size: 32px; 
          }
          p { 
            white-space: normal; 
            word-wrap: break-word; 
          }
          @media (max-width: 1024px) {
            body { 
              font-size: 48px; 
              padding-bottom: 150px; 
            }
            img { 
              max-width: 100%; 
            }
            .question-container { 
              margin-bottom: 30px; 
            }
            .instruction { 
              font-size: 36px; 
              margin-top: 15px; 
            }
            .option-box { 
              padding: 15px; 
              margin: 15px 0; 
            }
            .progress-circle { 
              width: 50px; 
              height: 50px; 
              font-size: 30px; 
            }
            button { 
              font-size: 48px; 
              padding: 15px 30px; 
              width: 100%; 
              margin: 5px 0; 
            }
            .button-container { 
              flex-direction: column; 
              align-items: center; 
              gap: 15px; 
            }
            #timer { 
              font-size: 36px; 
            }
            #confirm-modal { 
              padding: 30px; 
              width: 80%; 
              max-width: 400px; 
            }
            #confirm-modal h2 { 
              font-size: 48px; 
            }
            #confirm-modal button { 
              font-size: 48px; 
              padding: 15px 30px; 
            }
            input[type="text"] { 
              font-size: 48px; 
              padding: 15px; 
              width: 100%; 
              box-sizing: border-box; 
            }
            input[type="checkbox"] { 
              width: 30px; 
              height: 30px; 
              margin-right: 15px; 
            }
            label { 
              font-size: 48px; 
            }
            .sortable { 
              padding: 20px; 
              margin: 20px 0; 
            }
          }
        </style>
      </head>
      <body>
        <h1>${testNames[testNumber].name}</h1>
        <div id="timer">Залишилося часу: ${minutes} мм ${seconds} с</div>
        <div class="progress-bar">
          ${progress.map((p, i) => `
            <div class="progress-circle ${p.answered ? 'answered' : 'unanswered'}">${p.number}</div>
            ${(i + 1) % 10 === 0 && i < progress.length - 1 ? '<br>' : ''}
          `).join('')}
        </div>
        <div class="question-container">
  `;
  if (q.picture) {
    html += `<img src="${q.picture}" alt="Picture" onerror="this.src='/images/placeholder.png'; console.log('Image failed to load: ${q.picture}')"><br>`;
  }
  html += `
          <p>${index + 1}. ${q.text}</p>
  `;
  if (q.type === 'multiple') {
    html += `<p class="instruction">Виберіть всі правильні відповіді</p>`;
  } else if (q.type === 'ordering') {
    html += `<p class="instruction">Розмістіть відповіді у правильній послідовності</p>`;
  }
  if (!q.options || q.options.length === 0) {
    const userAnswer = answers[index] || '';
    html += `
      <input type="text" id="answer" value="${userAnswer}" style="width: 100%; box-sizing: border-box;">
    `;
  } else if (q.type === 'multiple') {
    html += q.options.map((option, i) => `
      <div class="option-box" onclick="toggleOption(${i})" id="option-${i}">
        <input type="checkbox" id="checkbox-${i}" ${answers[index] && answers[index].includes(String(option)) ? 'checked' : ''} style="display: none;">
        <label for="checkbox-${i}">${option}</label>
      </div>
    `).join('');
  } else if (q.type === 'ordering') {
    const orderedOptions = answers[index] ? answers[index] : q.options;
    html += `
      <div id="sortable">
        ${orderedOptions.map((option, i) => `
          <div class="option-box sortable" data-index="${i}">${option}</div>
        `).join('')}
      </div>
    `;
  }
  html += `
        </div>
        <div class="button-container">
          <button class="back-btn" onclick="navigate(${index - 1})" ${index === 0 ? 'disabled' : ''}>Назад</button>
          <button class="next-btn" onclick="navigate(${index + 1})" ${index === questions.length - 1 ? 'disabled' : ''}>Вперед</button>
          <button class="finish-btn" onclick="showConfirmModal()">Завершити тест</button>
        </div>
        <div id="confirm-modal">
          <h2>Ви впевнені, що хочете завершити тест?</h2>
          <button onclick="finishTest()">Так</button>
          <button onclick="hideConfirmModal()">Ні</button>
        </div>
        <script>
          let answers = ${JSON.stringify(answers[index] || (q.type === 'multiple' ? [] : q.options))};
          function toggleOption(index) {
            const option = document.getElementById('option-' + index);
            const checkbox = document.getElementById('checkbox-' + index);
            const value = ${JSON.stringify(q.options)}[index];
            if (checkbox.checked) {
              answers = answers.filter(v => v !== value);
              checkbox.checked = false;
              option.classList.remove('selected');
            } else {
              answers.push(value);
              checkbox.checked = true;
              option.classList.add('selected');
            }
            saveAnswer();
          }
          function navigate(index) {
            saveAnswer();
            window.location.href = '/test/question?index=' + index;
          }
          function saveAnswer() {
            const answerInput = document.getElementById('answer');
            if (answerInput) {
              answers = answerInput.value;
            }
            fetch('/test/save-answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index: ${index}, answer: answers })
            });
          }
          function showConfirmModal() {
            saveAnswer();
            document.getElementById('confirm-modal').style.display = 'block';
          }
          function hideConfirmModal() {
            document.getElementById('confirm-modal').style.display = 'none';
          }
          function finishTest() {
            window.location.href = '/test/finish';
          }
          let timer = ${remainingTime};
          setInterval(() => {
            timer--;
            if (timer <= 0) {
              finishTest();
            }
            const minutes = Math.floor(timer / 60).toString().padStart(2, '0');
            const seconds = (timer % 60).toString().padStart(2, '0');
            document.getElementById('timer').textContent = 'Залишилося часу: ' + minutes + ' мм ' + seconds + ' с';
          }, 1000);
          const sortable = document.getElementById('sortable');
          if (sortable) {
            let dragged;
            sortable.addEventListener('dragstart', (e) => {
              dragged = e.target;
              e.target.classList.add('dragging');
            });
            sortable.addEventListener('dragend', (e) => {
              e.target.classList.remove('dragging');
            });
            sortable.addEventListener('dragover', (e) => {
              e.preventDefault();
            });
            sortable.addEventListener('drop', (e) => {
              e.preventDefault();
              const target = e.target.closest('.sortable');
              if (target && target !== dragged) {
                const allItems = [...sortable.querySelectorAll('.sortable')];
                const draggedIndex = allItems.indexOf(dragged);
                const targetIndex = allItems.indexOf(target);
                if (draggedIndex < targetIndex) {
                  target.after(dragged);
                } else {
                  target.before(dragged);
                }
                answers = [...sortable.querySelectorAll('.sortable')].map(item => item.textContent);
                saveAnswer();
              }
            });
            let touchStartY = 0;
            let touchElement = null;
            sortable.addEventListener('touchstart', (e) => {
              touchElement = e.target.closest('.sortable');
              if (touchElement) {
                touchStartY = e.touches[0].clientY;
                touchElement.classList.add('dragging');
              }
            });
            sortable.addEventListener('touchmove', (e) => {
              e.preventDefault();
              if (touchElement) {
                const touchY = e.touches[0].clientY;
                const allItems = [...sortable.querySelectorAll('.sortable')];
                const touchElementRect = touchElement.getBoundingClientRect();
                const touchElementCenter = touchElementRect.top + touchElementRect.height / 2;
                const target = allItems.find(item => {
                  const rect = item.getBoundingClientRect();
                  const itemCenter = rect.top + rect.height / 2;
                  return Math.abs(touchY - itemCenter) < rect.height / 2 && item !== touchElement;
                });
                if (target) {
                  const draggedIndex = allItems.indexOf(touchElement);
                  const targetIndex = allItems.indexOf(target);
                  if (draggedIndex < targetIndex) {
                    target.after(touchElement);
                  } else {
                    target.before(touchElement);
                  }
                }
              }
            });
            sortable.addEventListener('touchend', (e) => {
              if (touchElement) {
                touchElement.classList.remove('dragging');
                answers = [...sortable.querySelectorAll('.sortable')].map(item => item.textContent);
                saveAnswer();
                touchElement = null;
              }
            });
          }
        </script>
      </body>
    </html>
  `;
  res.send(html);
});

app.post('/test/save-answer', checkAuth, (req, res) => {
  const { index, answer } = req.body;
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).json({ success: false, message: 'Тест не розпочато' });
  userTest.answers[index] = answer;
  res.json({ success: true });
});

app.get('/test/finish', checkAuth, async (req, res) => {
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber, answers, startTime } = userTest;
  let score = 0;
  let totalPoints = 0;

  questions.forEach((q, index) => {
    totalPoints += q.points;
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
    score += questionScore;
  });

  const endTime = Date.now();
  await saveResult(req.user, testNumber, score, totalPoints, startTime, endTime);
  userTests.delete(req.user);

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Результати</title>
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
            white-space: normal; 
            word-wrap: break-word; 
            margin: 10px 0; 
          }
          button { 
            font-size: 32px; 
            padding: 10px 20px; 
            margin: 20px 0; 
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
              max-width: 100%; 
            }
          }
        </style>
      </head>
      <body>
        <h1>Результати</h1>
        <p>Тест ${testNumber}: ${score} з ${totalPoints}, тривалість: ${Math.round((endTime - startTime) / 1000)} сек</p>
        <button onclick="window.location.href='/select-test'">Повторить на голову</button>
      </body>
    </html>
  `);
});

app.get('/admin', checkAuth, checkAdmin, async (req, res) => {
  try {
    if (!redisClient.isOpen) {
      console.log('Redis not connected in /admin, attempting to reconnect...');
      await redisClient.connect();
      console.log('Reconnected to Redis in /admin');
    }
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Адмін панель</title>
          <style>
            body { font-size: 16px; margin: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid black; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            button { font-size: 16px; padding: 5px 10px; margin: 5px; }
            @media (max-width: 1024px) {
              body { font-size: 24px; }
              table { font-size: 24px; }
              th, td { padding: 12px; }
              button { font-size: 24px; padding: 10px 20px; }
            }
          </style>
        </head>
        <body>
          <h1>Адмін панель</h1>
          <button onclick="window.location.href='/logout'">Вийти</button>
          <h2>Результати тестів</h2>
          <table>
            <tr>
              <th>Користувач</th>
              <th>Тест</th>
              <th>Бали</th>
              <th>Максимум</th>
              <th>Тривалість (сек)</th>
              <th>Початок</th>
              <th>Кінець</th>
              <th>Відповіді</th>
            </tr>
            ${parsedResults.map(result => `
              <tr>
                <td>${result.user}</td>
                <td>${result.testNumber}</td>
                <td>${result.score}</td>
                <td>${result.totalPoints}</td>
                <td>${result.duration}</td>
                <td>${result.startTime}</td>
                <td>${result.endTime}</td>
                <td>
                  <button onclick="showAnswers('${encodeURIComponent(JSON.stringify(result.answers))}')">Показати відповіді</button>
                </td>
              </tr>
            `).join('')}
          </table>
          <script>
            function showAnswers(encodedAnswers) {
              const answers = JSON.parse(decodeURIComponent(encodedAnswers));
              let output = 'Відповіді:\\n';
              for (const [question, answer] of Object.entries(answers)) {
                output += \`Питання \${parseInt(question) + 1}: \${JSON.stringify(answer)}\\n\`;
              }
              alert(output);
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

app.get('/logout', (req, res) => {
  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  res.redirect('/');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});