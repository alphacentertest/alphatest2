const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('redis');

const app = express();

const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789',
  'admin': 'adminpass'
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Настройка Redis
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis connected'));
redisClient.on('reconnecting', () => console.log('Redis reconnecting'));

(async () => {
  try {
    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (err) {
    console.error('Failed to connect to Redis on startup:', err);
  }
})();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
    if (!user) return res.status(401).json({ success: false, message: 'Невірний пароль' });

    res.cookie('auth', user, {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    if (user === 'admin') {
      res.json({ success: true, redirect: '/admin/results' });
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
  if (!user || !validPasswords[user]) {
    return res.redirect('/');
  }
  req.user = user;
  next();
};

const checkAdmin = (req, res, next) => {
  const user = req.cookies.auth;
  if (user !== 'admin') {
    return res.status(403).json({ error: 'Доступно тільки для адміністратора' });
  }
  next();
};

app.get('/select-test', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Вибір тесту</title>
      </head>
      <body>
        <h1>Виберіть тест</h1>
        <button onclick="window.location.href='/test?test=1'">Почати Тест 1</button>
        <button onclick="window.location.href='/test?test=2'">Почати Тест 2</button>
      </body>
    </html>
  `);
});

const loadQuestions = async (testNumber) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(__dirname, `questions${testNumber}.xlsx`);
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
          options: rowValues.slice(2, 8).filter(Boolean),
          correctAnswers: rowValues.slice(8, 11).filter(Boolean),
          type: rowValues[11] || 'multiple',
          points: Number(rowValues[12]) || 0
        });
      }
    });
    return jsonData;
  } catch (error) {
    console.error(`Ошибка в loadQuestions (test ${testNumber}):`, error.stack);
    throw error;
  }
};

const userTests = new Map();

const saveResult = async (user, testNumber, score, totalPoints, startTime, endTime) => {
  try {
    if (!redisClient.isOpen) {
      await redisClient.connect();
      console.log('Reconnected to Redis in saveResult');
    }
    const duration = Math.round((endTime - startTime) / 1000);
    const result = {
      user,
      testNumber,
      score,
      totalPoints,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration
    };
    await redisClient.lPush('test_results', JSON.stringify(result));
    console.log(`Saved result for ${user} in Redis`);
  } catch (error) {
    console.error('Ошибка сохранения в Redis:', error.stack);
  }
};

app.get('/test', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
  const testNumber = req.query.test === '2' ? 2 : 1;
  try {
    const questions = await loadQuestions(testNumber);
    userTests.set(req.user, {
      testNumber,
      questions,
      answers: {},
      currentQuestion: 0,
      startTime: Date.now()
    });
    res.redirect(`/test/question?index=0`);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

app.get('/test/question', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, testNumber } = userTest;
  const index = parseInt(req.query.index) || 0;

  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  userTest.currentQuestion = index;
  const q = questions[index];
  console.log('Rendering question:', { index, picture: q.picture, text: q.text, options: q.options });
  let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Тест ${testNumber}</title>
      </head>
      <body>
        <h1>Тест ${testNumber}</h1>
        <div>
  `;
  if (q.picture) {
    html += `<img src="${q.picture}" alt="Picture" style="max-width: 300px;" onerror="this.src='/images/placeholder.png'; console.log('Image failed to load: ${q.picture}')"><br>`;
  }
  html += `
          <p>${index + 1}. ${q.text}</p>
  `;
  if (!q.options || q.options.length === 0) {
    const userAnswer = userTest.answers[index] || '';
    html += `
      <input type="text" name="q${index}" id="q${index}_input" value="${userAnswer}" placeholder="Введіть відповідь"><br>
    `;
  } else {
    q.options.forEach((option, optIndex) => {
      const checked = userTest.answers[index]?.includes(option) ? 'checked' : '';
      html += `
        <input type="checkbox" name="q${index}" value="${option}" id="q${index}_${optIndex}" ${checked}>
        <label for="q${index}_${optIndex}">${option}</label><br>
      `;
    });
  }
  html += `
        </div><br>
        <button ${index === 0 ? 'disabled' : ''} onclick="window.location.href='/test/question?index=${index - 1}'">Назад</button>
        <button ${index === questions.length - 1 ? 'disabled' : ''} onclick="saveAndNext(${index})">Вперед</button>
        <button onclick="finishTest(${index})">Завершити тест</button>
        <script>
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
            window.location.href = '/result';
          }
        </script>
      </body>
    </html>
  `;
  res.send(html);
});

app.post('/answer', checkAuth, (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
  try {
    const { index, answer } = req.body;
    const userTest = userTests.get(req.user);
    if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });
    userTest.answers[index] = answer; // Сохраняем как массив или строку
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.get('/result', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
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
        <title>Результати Тесту ${testNumber}</title>
      </head>
      <body>
        <h1>Результати Тесту ${testNumber}</h1>
        <p>Ваш результат: ${score} з ${totalPoints}</p>
        <button onclick="window.location.href='/results'">Переглянути результати</button>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(resultHtml);
});

app.get('/results', checkAuth, async (req, res) => {
  if (req.user === 'admin') return res.redirect('/admin/results');
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
      <p>Тест ${testNumber}: ${score} з ${totalPoints}, тривалість: ${duration} сек</p>
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

app.get('/admin/results', checkAuth, checkAdmin, async (req, res) => {
  let redisConnected = false;
  try {
    if (!redisClient.isOpen) {
      console.log('Redis not connected in /admin/results, attempting to reconnect...');
      await redisClient.connect();
      console.log('Reconnected to Redis in /admin/results');
    }
    redisConnected = true;
  } catch (connectError) {
    console.error('Failed to connect to Redis in /admin/results:', connectError);
  }

  let results = [];
  let errorMessage = '';
  if (redisConnected) {
    try {
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
  } else {
    console.log('Redis not connected, skipping fetch');
    errorMessage = 'Нет подключения к Redis';
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
        </style>
      </head>
      <body>
        <h1>Результати всіх користувачів</h1>
        <p>Статус Redis: ${redisConnected ? 'Підключено' : 'Немає підключення'}</p>
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
          </tr>
  `;
  if (!results || results.length === 0) {
    adminHtml += '<tr><td colspan="7">Немає результатів</td></tr>';
    console.log('No results found in test_results');
  } else {
    results.forEach((result, index) => {
      try {
        const r = JSON.parse(result);
        console.log(`Parsed result ${index}:`, r);
        adminHtml += `
          <tr>
            <td>${r.user || 'N/A'}</td>
            <td>${r.testNumber || 'N/A'}</td>
            <td>${r.score || '0'}</td>
            <td>${r.totalPoints || '0'}</td>
            <td>${r.startTime || 'N/A'}</td>
            <td>${r.endTime || 'N/A'}</td>
            <td>${r.duration || 'N/A'}</td>
          </tr>
        `;
      } catch (parseError) {
        console.error(`Ошибка парсинга результата ${index}:`, parseError, 'Raw data:', result);
      }
    });
  }
  adminHtml += `
        </table>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  res.send(adminHtml);
});

module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}