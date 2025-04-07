const express = require('express');
const ExcelJS = require('exceljs');
const path = require('path');
const fsSync = require('fs'); // Синхронные методы fs

const app = express();

// Middleware для обработки форм и JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Статическая папка для изображений (если есть)
app.use(express.static(path.join(__dirname, 'public')));

// Глобальные переменные
let users = [];

// Загрузка пользователей из users.xlsx
const loadUsers = async () => {
  try {
    const filePath = path.join(__dirname, 'data', 'users.xlsx');
    if (!fsSync.existsSync(filePath)) {
      console.error(`Файл пользователей ${filePath} не найден`);
      return [];
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    let sheet = workbook.getWorksheet('Users');
    if (!sheet) {
      console.error('Лист "Users" не найден');
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

    console.log(`Загружено ${users.length} пользователей`);
    return users;
  } catch (error) {
    console.error(`Ошибка загрузки пользователей: ${error.message}`);
    return [];
  }
};

// Загрузка вопросов из файла questionsX.xlsx
const loadQuestions = async (questionsFile) => {
  try {
    const filePath = path.join(__dirname, 'data', questionsFile);
    if (!fsSync.existsSync(filePath)) {
      console.error(`Файл вопросов ${filePath} не найден`);
      return [];
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    let sheet = workbook.getWorksheet('Questions') || workbook.getWorksheet('Sheet1');
    if (!sheet) {
      console.error('Лист "Questions" или "Sheet1" не найден');
      return [];
    }

    const questions = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const pictureNumber = String(row.getCell(1).value || '').trim();
        const picture = pictureNumber ? `/images/Picture${pictureNumber}.png` : null;
        const question = {
          picture: picture,
          text: String(row.getCell(2).value || '').trim(),
          type: String(row.getCell(27).value || 'multiple').trim().toLowerCase(),
          options: [],
          correctAnswers: [],
          points: parseInt(row.getCell(28).value) || 1,
        };

        // Читаем варианты ответа (столбцы 3–14)
        for (let i = 3; i <= 14; i++) {
          const option = row.getCell(i).value;
          if (option) question.options.push(String(option).trim());
        }

        // Читаем правильные ответы (столбцы 15–26)
        for (let i = 15; i <= 26; i++) {
          const correctAnswer = row.getCell(i).value;
          if (correctAnswer) question.correctAnswers.push(String(correctAnswer).trim());
        }

        if (question.text) questions.push(question);
      }
    });

    console.log(`Загружено ${questions.length} вопросов из ${questionsFile}`);
    return questions;
  } catch (error) {
    console.error(`Ошибка загрузки вопросов из ${questionsFile}: ${error.message}`);
    return [];
  }
};

// Инициализация сервера
const initializeServer = async () => {
  console.log('Инициализация сервера...');
  users = await loadUsers();
  if (users.length === 0) {
    console.error('Не удалось загрузить пользователей. Проверьте файл users.xlsx.');
  }
};

// Главная страница (вход)
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Вход</title>
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
          input[type="password"] {
            font-size: 16px;
            padding: 5px;
            width: 100%;
            box-sizing: border-box;
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
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Вход</h1>
          <form action="/login" method="POST">
            <label>Пароль:</label>
            <input type="password" name="password" required>
            <button type="submit">Войти</button>
          </form>
          <p id="error" class="error"></p>
        </div>
        <script>
          const urlParams = new URLSearchParams(window.location.search);
          const error = urlParams.get('error');
          if (error) {
            document.getElementById('error').textContent = decodeURIComponent(error);
          }
        </script>
      </body>
    </html>
  `);
});

// Обработка входа
app.post('/login', async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.redirect('/login?error=' + encodeURIComponent('Пароль не может быть пустым'));
  }

  // Проверяем пароль
  const user = users.find(u => u.password === password.trim());
  if (!user) {
    return res.redirect('/login?error=' + encodeURIComponent('Неверный пароль'));
  }

  // Если пароль верный, перенаправляем на страницу выбора теста
  res.redirect('/select-test');
});

// Страница выбора теста
app.get('/select-test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Выбор теста</title>
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
        </style>
      </head>
      <body>
        <h1>Выберите тест</h1>
        <div class="tests">
          <button onclick="window.location.href='/test/1'">Тест 1</button>
          <button onclick="window.location.href='/test/2'">Тест 2</button>
        </div>
      </body>
    </html>
  `);
});

// Страница теста
app.get('/test/:testNumber', async (req, res) => {
  const { testNumber } = req.params;
  const questionsFile = testNumber === '1' ? 'questions1.xlsx' : 'questions2.xlsx';
  const testName = testNumber === '1' ? 'Тест 1' : 'Тест 2';

  const questions = await loadQuestions(questionsFile);
  if (questions.length === 0) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Ошибка</title>
        </head>
        <body>
          <h1>Ошибка</h1>
          <p>Не удалось загрузить вопросы для ${testName}. Проверьте файл ${questionsFile}.</p>
          <button onclick="window.location.href='/select-test'">Вернуться к выбору теста</button>
        </body>
      </html>
    `);
  }

  // Простое отображение вопросов
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${testName}</title>
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
            text-align: left;
          }
          img {
            max-width: 100%;
            height: auto;
            margin-bottom: 20px;
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
        </style>
      </head>
      <body>
        <h1>${testName}</h1>
        ${questions.map((q, idx) => `
          <div class="question">
            ${q.picture ? `<img src="${q.picture}" alt="Изображение вопроса" onerror="this.src='/images/placeholder.png'">` : ''}
            <p>Вопрос ${idx + 1}: ${q.text}</p>
            <div class="options">
              ${q.options.map(opt => `<div class="option">${opt}</div>`).join('')}
            </div>
            <p>Правильный ответ: ${q.correctAnswers.join(', ')}</p>
          </div>
        `).join('')}
        <button onclick="window.location.href='/select-test'">Вернуться к выбору теста</button>
      </body>
    </html>
  `);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  await initializeServer();
});
