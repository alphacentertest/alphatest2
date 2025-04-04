const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis'); // Используем ioredis вместо redis
const AWS = require('aws-sdk');

// Инициализация приложения
const app = express();

// Настройка Redis
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Настройка AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Настройка middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // Для favicon и других статических файлов

// Настройка multer для загрузки файлов
const upload = multer({ dest: '/tmp/uploads' });

// Убедимся, что директория /tmp/uploads существует
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Глобальные переменные
let validPasswords = {};
let isInitialized = false;
let initializationError = null;
const testNames = {
  '1': { name: 'Тест 1', timeLimit: 600, questionsFile: 'questions1.xlsx' },
  '2': { name: 'Тест 2', timeLimit: 900, questionsFile: 'questions2.xlsx' }
};

// Функция для форматирования времени
const formatDuration = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} хв ${remainingSeconds} сек`;
};

// Функция для управления режимом камеры
const getCameraMode = async () => {
  const mode = await redisClient.get('cameraMode');
  return mode === 'true';
};

const setCameraMode = async (mode) => {
  await redisClient.set('cameraMode', mode.toString());
};

// Функция загрузки пользователей из Redis
const initializeUsersInRedis = async () => {
  const usersKey = 'users';
  const keyType = await redisClient.type(usersKey);
  if (keyType !== 'string' && keyType !== 'none') {
    console.warn(`Key ${usersKey} has wrong type (${keyType}). Deleting and reinitializing.`);
    await redisClient.del(usersKey);
  }

  const existingUsers = await redisClient.get(usersKey);
  if (!existingUsers) {
    const defaultUsers = { admin: 'admin123' };
    await redisClient.set(usersKey, JSON.stringify(defaultUsers));
    return defaultUsers;
  }
  return JSON.parse(existingUsers);
};

// Функция загрузки вопросов из S3
const loadQuestions = async (questionsFile) => {
  try {
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: questionsFile
    };
    const file = await s3.getObject(params).promise();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.Body);
    const jsonData = [];
    const sheet = workbook.getWorksheet('Questions');

    if (!sheet) throw new Error(`Лист "Questions" не знайдено в ${questionsFile}`);

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
    console.error(`Ошибка в loadQuestions (${questionsFile}):`, error.stack);
    throw error;
  }
};

// Инициализация сервера
const initializeServer = async () => {
  let attempt = 1;
  const maxAttempts = 5;

  while (attempt <= maxAttempts) {
    try {
      console.log(`Starting server initialization (Attempt ${attempt} of ${maxAttempts})...`);
      validPasswords = await initializeUsersInRedis();
      console.log('Users loaded successfully from Redis:', validPasswords);
      await redisClient.connect();
      console.log('Connected to Redis');
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

// Middleware для проверки админа
const checkAdmin = (req, res, next) => {
  const user = req.cookies.user;
  console.log(`checkAdmin: User ${user} attempting to access admin route`);
  if (!user || validPasswords[user] !== req.cookies.auth) {
    console.log(`checkAdmin: Redirecting user ${user} to login`);
    return res.redirect('/');
  }
  if (user !== 'admin') {
    console.log(`checkAdmin: Access denied for user ${user}`);
    return res.status(403).send('Доступ заборонено. Тільки для адміністратора.');
  }
  next();
};

// Применяем middleware ко всем маршрутам
app.use(checkInitialization);

// Маршрут для логина
app.get('/', (req, res) => {
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
          <label>Ім'я користувача:</label>
          <input type="text" name="username" required>
          <label>Пароль:</label>
          <div class="password-container">
            <input type="password" id="password" name="password" value="${savedPassword}" required>
            <span class="eye-icon" onclick="togglePassword()">👁️</span>
          </div>
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

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (validPasswords[username] && validPasswords[username] === password) {
    res.cookie('user', username, { httpOnly: true });
    res.cookie('auth', password, { httpOnly: true });
    res.cookie('savedPassword', password, { httpOnly: false });
    if (username === 'admin') {
      res.redirect('/admin');
    } else {
      res.redirect('/test');
    }
  } else {
    res.status(401).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Помилка входу</title>
          <style>
            body { font-size: 16px; margin: 20px; }
            h1 { font-size: 24px; margin-bottom: 20px; }
            p { color: red; }
            a { color: #007bff; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>Помилка входу</h1>
          <p>Неправильне ім'я користувача або пароль.</p>
          <a href="/">Спробувати ще раз</a>
        </body>
      </html>
    `);
  }
});

// Маршрут для тестов
app.get('/test', async (req, res) => {
  const user = req.cookies.user;
  if (!user || validPasswords[user] !== req.cookies.auth) {
    return res.redirect('/');
  }
  if (user === 'admin') {
    return res.redirect('/admin');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Вибір тесту</title>
        <style>
          body { font-size: 16px; margin: 20px; }
          h1 { font-size: 24px; margin-bottom: 20px; }
          select, button { font-size: 16px; padding: 5px; margin: 5px 0; }
          button { border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; }
          button:hover { background-color: #0056b3; }
        </style>
      </head>
      <body>
        <h1>Виберіть тест, ${user}</h1>
        <form action="/test/start" method="POST">
          <select name="testNumber" required>
            <option value="">-- Виберіть тест --</option>
            ${Object.entries(testNames).map(([num, data]) => `
              <option value="${num}">${data.name}</option>
            `).join('')}
          </select>
          <button type="submit">Почати тест</button>
        </form>
        <button onclick="window.location.href='/logout'">Вийти</button>
      </body>
    </html>
  `);
});

// Маршрут админ-панели
app.get('/admin', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));

    const questionsByTest = {};
    for (const result of parsedResults) {
      const testNumber = result.testNumber;
      if (!questionsByTest[testNumber]) {
        try {
          questionsByTest[testNumber] = await loadQuestions(testNames[testNumber].questionsFile);
        } catch (error) {
          console.error(`Ошибка загрузки вопросов для теста ${testNumber}:`, error.stack);
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
    console.error('Ошибка в /admin:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

app.post('/admin/delete-results', checkAdmin, async (req, res) => {
  try {
    await redisClient.del('test_results');
    res.json({ success: true, message: 'Результати тестів успішно видалені' });
  } catch (error) {
    console.error('Ошибка в /admin/delete-results:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні результатів' });
  }
});

app.post('/admin/toggle-camera', checkAdmin, async (req, res) => {
  try {
    const currentMode = await getCameraMode();
    await setCameraMode(!currentMode);
    res.json({ success: true, message: `Камера ${!currentMode ? 'увімкнена' : 'вимкнена'}` });
  } catch (error) {
    console.error('Ошибка в /admin/toggle-camera:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при зміні стану камери' });
  }
});

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
    res.json({ success: true, message: 'Тест успішно оновлено' });
  } catch (error) {
    console.error('Ошибка в /admin/update-test:', error.stack);
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
    res.json({ success: true, message: 'Тест успішно видалено' });
  } catch (error) {
    console.error('Ошибка в /admin/delete-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при видаленні тесту' });
  }
});

app.get('/admin/create-test', checkAdmin, (req, res) => {
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
          label { display: block; margin: 10px 0 5px; }
          input[type="text"], input[type="number"], input[type="file"] { font-size: 16px; padding: 5px; margin: 5px 0; width: 100%; max-width: 300px; box-sizing: border-box; }
          button { font-size: 16px; padding: 10px 20px; border: none; border-radius: 5px; background-color: #007bff; color: white; cursor: pointer; margin: 10px 0; }
          button:hover { background-color: #0056b3; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>Створити тест</h1>
        <form id="createTestForm" enctype="multipart/form-data">
          <label>Назва тесту:</label>
          <input type="text" id="name" name="name" required>
          <label>Часовий ліміт (секунд):</label>
          <input type="number" id="timeLimit" name="timeLimit" required>
          <label>Файл з питаннями (Excel):</label>
          <input type="file" id="questionsFile" name="questionsFile" accept=".xlsx" required>
          <button type="submit">Створити тест</button>
        </form>
        <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        <p id="error" class="error"></p>
        <script>
          document.getElementById('createTestForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const formData = new FormData();
            formData.append('name', document.getElementById('name').value);
            formData.append('timeLimit', document.getElementById('timeLimit').value);
            formData.append('questionsFile', document.getElementById('questionsFile').files[0]);

            const response = await fetch('/admin/create-test', {
              method: 'POST',
              body: formData
            });
            const result = await response.json();
            if (result.success) {
              window.location.href = '/admin';
            } else {
              document.getElementById('error').textContent = result.message;
            }
          });
        </script>
      </body>
    </html>
  `);
});

app.post('/admin/create-test', checkAdmin, upload.single('questionsFile'), async (req, res) => {
  try {
    const { name, timeLimit } = req.body;
    const questionsFile = req.file;

    if (!name || !timeLimit || !questionsFile) {
      return res.status(400).json({ success: false, message: 'Усі поля обов’язкові' });
    }

    const newTestNum = String(Object.keys(testNames).length + 1);
    const newFileName = `questions${newTestNum}.xlsx`;

    // Загружаем файл в S3
    const fileContent = fs.readFileSync(questionsFile.path);
    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: newFileName,
      Body: fileContent,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
    await s3.upload(params).promise();

    // Удаляем временный файл
    fs.unlinkSync(questionsFile.path);

    // Проверяем, что файл можно прочитать
    await loadQuestions(newFileName);

    testNames[newTestNum] = {
      name,
      timeLimit: parseInt(timeLimit),
      questionsFile: newFileName
    };

    res.json({ success: true, message: 'Тест успішно створено' });
  } catch (error) {
    console.error('Ошибка в /admin/create-test:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка при створенні тесту: ' + error.message });
  }
});

app.get('/admin/view-results', checkAdmin, async (req, res) => {
  try {
    const results = await redisClient.lRange('test_results', 0, -1);
    const parsedResults = results.map(r => JSON.parse(r));

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
              </tr>
            </thead>
            <tbody>
              ${parsedResults.map(result => `
                <tr>
                  <td>${result.user}</td>
                  <td>${testNames[result.testNumber]?.name || 'Невідомий тест'}</td>
                  <td>${result.score} / ${result.totalPoints}</td>
                  <td>${formatDuration(result.duration)}</td>
                  <td>${Math.round((result.suspiciousBehavior / (result.duration || 1)) * 100)}%</td>
                  <td>${new Date(result.endTime).toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <button onclick="window.location.href='/admin'">Повернутися до адмін-панелі</button>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Ошибка в /admin/view-results:', error.stack);
    res.status(500).send('Помилка сервера');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('auth');
  res.clearCookie('savedPassword');
  res.clearCookie('user');
  res.redirect('/');
});

// Запуск сервера после инициализации
initializeServer().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize server:', err.stack);
  process.exit(1);
});