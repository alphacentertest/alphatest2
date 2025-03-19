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
          options: rowValues.slice(2, 14).filter(Boolean), // Option 1–12 (столбцы 3–14)
          correctAnswers: rowValues.slice(14, 26).filter(Boolean), // Correct Answer 1–12 (столбцы 15–26)
          type: rowValues[26] || 'multiple', // Тип вопроса (столбец 27)
          points: Number(rowValues[27]) || 0 // Баллы (столбец 28)
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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
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
        <title>Вибір тесту</title>
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
          .sortable { cursor: move; }
          .sortable.dragging { opacity: 0.5; }
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
  } else if (q.type === 'ordering') {
    const orderedOptions = answers[index] || q.options;
    html += `
      <div id="sortable-${index}" class="sortable-list">
        ${orderedOptions.map((option, optIndex) => `
          <div class="option-box sortable" draggable="true" data-index="${optIndex}" data-value="${option}">
            ${option}
          </div>
        `).join('')}
      </div>
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

          const sortableList = document.getElementById('sortable-${index}');
          if (sortableList) {
            const items = sortableList.querySelectorAll('.sortable');
            items.forEach(item => {
              item.addEventListener('dragstart', () => {
                item.classList.add('dragging');
              });
              item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
              });
            });
            sortableList.addEventListener('dragover', (e) => {
              e.preventDefault();
              const dragging = sortableList.querySelector('.dragging');
              const afterElement = getDragAfterElement(sortableList, e.clientY);
              if (afterElement == null) {
                sortableList.appendChild(dragging);
              } else {
                sortableList.insertBefore(dragging, afterElement);
              }
            });
            function getDragAfterElement(container, y) {
              const sortableElements = [...container.querySelectorAll('.sortable:not(.dragging)')];
              return sortableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) {
                  return { offset: offset, element: child };
                } else {
                  return closest;
                }
              }, { offset: Number.NEGATIVE_INFINITY }).element;
            }
          }

          async function saveAndNext(index) {
            let answers;
            if (document.querySelector('input[type="text"][name="q' + index + '"]')) {
              answers = document.getElementById('q' + index + '_input').value;
            } else if (document.getElementById('sortable-' + index)) {
              const items = document.querySelectorAll('#sortable-' + index + ' .sortable');
              answers = Array.from(items).map(item => item.dataset.value);
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
            } else if (document.getElementById('sortable-' + index)) {
              const items = document.querySelectorAll('#sortable-' + index + ' .sortable');
              answers = Array.from(items).map(item => item.dataset.value);
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

app.post('/answer', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  try {
    const { index, answer } = req.body;
    const userTest = userTests.get(req.user);
    if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });
    userTest.answers[index] = answer;
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

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
  await saveResult(req.user, testNumber, score, totalPoints, startTime, endTime);

  const resultHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати ${testNames[testNumber].name}</title>
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

app.get('/results', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin');
  const userTest = userTests.get(req.user);
  let resultsHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Результати</title>
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

app.get('/admin', checkAuth, checkAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Адмін-панель</title>
        <style>
          body { font-size: 24px; margin: 20px; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
          table { border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid black; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
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

app.get('/admin/results', checkAuth, checkAdmin, async (req, res) => {
  let results = [];
  let errorMessage = '';
  try {
    if (!redisClient.isOpen) {
      console.log('Redis not connected in /admin/results, attempting to reconnect...');
      await redisClient.connect();
      console.log('Reconnected to Redis in /admin/results');
    }
    const keyType = await redisClient.type('test_results');
    console.log('Type of test_results:', keyType);
    if (keyType !== 'list' && keyType !== 'none') {
      errorMessage = `Неверный тип данных для test_results: ${keyType}. Ожидается list.`;
      console.error(errorMessage);
    } else {
      results = await redisClient.lRange('test_results', 0, -1);
      console.log('Fetched results from Redis:', results);
    }
  } catch (fetchError) {
    console.error('Ошибка при получении данных из Redis:', fetchError);
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
    console.log('No results found in test_results');
  } else {
    results.forEach((result, index) => {
      try {
        const r = JSON.parse(result);
        console.log(`Parsed result ${index}:`, r);
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
        console.error(`Ошибка парсинга результата ${index}:`, parseError, 'Raw data:', result);
      }
    });
  }
  adminHtml += `
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `;
  res.send(adminHtml);
});

app.get('/admin/delete-results', checkAuth, checkAdmin, async (req, res) => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
    }
    await redisClient.del('test_results');
    console.log('Test results deleted from Redis');
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Видалено результати</title>
        </head>
        <body>
          <h1>Результати успішно видалено</h1>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Ошибка при удалении результатов:', error.stack);
    res.status(500).send('Помилка при видаленні результатів');
  }
});

app.get('/admin/edit-tests', checkAuth, checkAdmin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Редагувати назви тестів</title>
        <style>
          body { font-size: 24px; margin: 20px; }
          input { font-size: 24px; padding: 5px; margin: 5px; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Редагувати назви та час тестів</h1>
        <form method="POST" action="/admin/edit-tests">
          <div>
            <label for="test1">Назва Тесту 1:</label>
            <input type="text" id="test1" name="test1" value="${testNames['1'].name}" required>
            <label for="time1">Час (сек):</label>
            <input type="number" id="time1" name="time1" value="${testNames['1'].timeLimit}" required min="1">
          </div>
          <div>
            <label for="test2">Назва Тесту 2:</label>
            <input type="text" id="test2" name="test2" value="${testNames['2'].name}" required>
            <label for="time2">Час (сек):</label>
            <input type="number" id="time2" name="time2" value="${testNames['2'].timeLimit}" required min="1">
          </div>
          <button type="submit">Зберегти</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `);
});

app.post('/admin/edit-tests', checkAuth, checkAdmin, (req, res) => {
  try {
    const { test1, test2, time1, time2 } = req.body;
    testNames['1'] = {
      name: test1 || testNames['1'].name,
      timeLimit: parseInt(time1) || testNames['1'].timeLimit
    };
    testNames['2'] = {
      name: test2 || testNames['2'].name,
      timeLimit: parseInt(time2) || testNames['2'].timeLimit
    };
    console.log('Updated test names and time limits:', testNames);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Назви оновлено</title>
        </head>
        <body>
          <h1>Назви та час тестів успішно оновлено</h1>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Ошибка при редактировании названий тестов:', error.stack);
    res.status(500).send('Помилка при оновленні назв тестів');
  }
});

app.get('/admin/create-test', checkAuth, checkAdmin, (req, res) => {
  const excelFiles = fs.readdirSync(__dirname).filter(file => file.endsWith('.xlsx') && file.startsWith('questions'));
  console.log('Available Excel files:', excelFiles);
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Створити новий тест</title>
        <style>
          body { font-size: 24px; margin: 20px; }
          input { font-size: 24px; padding: 5px; margin: 5px; }
          select { font-size: 24px; padding: 5px; margin: 5px; }
          button { font-size: 24px; padding: 10px 20px; margin: 5px; }
        </style>
      </head>
      <body>
        <h1>Створити новий тест</h1>
        <form method="POST" action="/admin/create-test">
          <div>
            <label for="testName">Назва нового тесту:</label>
            <input type="text" id="testName" name="testName" required>
          </div>
          <div>
            <label for="timeLimit">Час (сек):</label>
            <input type="number" id="timeLimit" name="timeLimit" value="3600" required min="1">
          </div>
          <div>
            <label for="excelFile">Оберіть файл Excel з питаннями:</label>
            <select id="excelFile" name="excelFile" required>
              ${excelFiles.map(file => `<option value="${file}">${file}</option>`).join('')}
            </select>
          </div>
          <button type="submit">Створити</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
      </body>
    </html>
  `);
});

app.post('/admin/create-test', checkAuth, checkAdmin, async (req, res) => {
  try {
    const { testName, excelFile, timeLimit } = req.body;
    const match = excelFile.match(/^questions(\d+)\.xlsx$/);
    if (!match) throw new Error('Невірний формат файлу Excel');
    const testNumber = match[1];
    if (testNames[testNumber]) throw new Error('Тест з таким номером вже існує');

    testNames[testNumber] = {
      name: testName,
      timeLimit: parseInt(timeLimit) || 3600
    };
    console.log('Created new test:', { testNumber, testName, timeLimit, excelFile });
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Тест створено</title>
        </head>
        <body>
          <h1>Новий тест "${testName}" створено</h1>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Ошибка при создании нового теста:', error.stack);
    res.status(500).send(`Помилка при створенні тесту: ${error.message}`);
  }
});

module.exports = app;