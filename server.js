const express = require('express');
const Redis = require('ioredis');
const session = require('express-session');
const RedisStore = require('connect-redis').default;

const app = express();

// Настройка Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Настройка хранилища сессий с использованием Redis
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: 'your-secret-key', // Замените на свой секретный ключ
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' } // Для Vercel secure: true
}));

// Middleware для обработки форм и JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Статическая папка для изображений (если есть)
app.use(express.static('public'));

// Логирование всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Глобальные переменные
let users = [];

// Загрузка пользователей из Redis
const loadUsers = async () => {
  try {
    const usersData = await redis.get('users');
    if (!usersData) {
      console.error('Данные пользователей не найдены в Redis');
      return [];
    }
    users = JSON.parse(usersData);
    console.log(`Загружено ${users.length} пользователей из Redis:`, users);
    return users;
  } catch (error) {
    console.error(`Ошибка загрузки пользователей из Redis: ${error.message}`);
    return [];
  }
};

// Загрузка вопросов из Redis
const loadQuestions = async (testNumber) => {
  try {
    const key = `questions${testNumber}`;
    const questionsData = await redis.get(key);
    if (!questionsData) {
      console.error(`Данные вопросов для теста ${testNumber} не найдены в Redis`);
      return [];
    }
    const questions = JSON.parse(questionsData);
    console.log(`Загружено ${questions.length} вопросов для теста ${testNumber} из Redis`);
    return questions;
  } catch (error) {
    console.error(`Ошибка загрузки вопросов для теста ${testNumber} из Redis: ${error.message}`);
    return [];
  }
};

// Инициализация сервера
const initializeServer = async () => {
  console.log('Инициализация сервера...');
  users = await loadUsers();
  if (users.length === 0) {
    console.error('Не удалось загрузить пользователей из Redis.');
  }
};

// Главная страница (вход)
app.get('/login', (req, res) => {
  // Если пользователь уже авторизован, перенаправляем на /select-test
  if (req.session.isAuthenticated) {
    console.log('Пользователь уже авторизован, перенаправляем на /select-test');
    return res.redirect('/select-test');
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Введіть пароль</title>
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
          .password-container {
            display: flex;
            align-items: center;
            position: relative;
            width: 100%;
          }
          .eye-icon {
            font-size: 20px;
            cursor: pointer;
            margin-right: 10px;
          }
          input[type="password"], input[type="text"] {
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
          <h1>Введіть пароль</h1>
          <form action="/login" method="POST">
            <label>Пароль:</label>
            <div class="password-container">
              <span class="eye-icon" onclick="togglePassword()">👁️</span>
              <input type="password" id="password" name="password" required>
            </div>
            <label><input type="checkbox" name="rememberMe"> Запам'ятати мене</label>
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
  console.log(`Введённый пароль: "${password}"`);

  if (!password) {
    console.log('Пароль пустой');
    return res.redirect('/login?error=' + encodeURIComponent('Пароль не може бути порожнім'));
  }

  // Проверяем, загружены ли пользователи
  if (users.length === 0) {
    console.log('Список пользователей пуст');
    return res.redirect('/login?error=' + encodeURIComponent('Помилка сервера: користувачі не завантажені'));
  }

  // Проверяем пароль
  const trimmedPassword = password.trim();
  console.log(`Пароль после trim: "${trimmedPassword}"`);
  console.log('Список пользователей:', users);
  const user = users.find(u => u.password === trimmedPassword);
  if (!user) {
    console.log('Пароль не найден в списке пользователей');
    return res.redirect('/login?error=' + encodeURIComponent('Пароль невірний'));
  }

  console.log(`Успешная авторизация для пользователя: ${user.username}`);
  req.session.isAuthenticated = true; // Устанавливаем флаг авторизации в сессии
  res.redirect('/select-test');
});

// Middleware для проверки авторизации
const checkAuth = (req, res, next) => {
  if (!req.session.isAuthenticated) {
    console.log('Неавторизованный доступ к /select-test');
    return res.redirect('/login?error=' + encodeURIComponent('Будь ласка, увійдіть'));
  }
  next();
};

// Страница выбора теста
app.get('/select-test', checkAuth, (req, res) => {
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
        </style>
      </head>
      <body>
        <h1>Виберіть тест</h1>
        <div class="tests">
          <button onclick="window.location.href='/test/1'">Тест 1</button>
          <button onclick="window.location.href='/test/2'">Тест 2</button>
          <button onclick="window.location.href='/test/3'">Тест 3</button>
          <button onclick="window.location.href='/logout'">Вийти</button>
        </div>
      </body>
    </html>
  `);
});

// Страница теста
app.get('/test/:testNumber', checkAuth, async (req, res) => {
  const { testNumber } = req.params;
  let testName;

  // Определяем название теста в зависимости от testNumber
  if (testNumber === '1') {
    testName = 'Тест 1';
  } else if (testNumber === '2') {
    testName = 'Тест 2';
  } else if (testNumber === '3') {
    testName = 'Тест 3';
  } else {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Помилка</title>
        </head>
        <body>
          <h1>Помилка</h1>
          <p>Тест з номером ${testNumber} не знайдено.</p>
          <button onclick="window.location.href='/select-test'">Повернутися до вибору тесту</button>
        </body>
      </html>
    `);
  }

  const questions = await loadQuestions(testNumber);
  if (questions.length === 0) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Помилка</title>
        </head>
        <body>
          <h1>Помилка</h1>
          <p>Не вдалося завантажити питання для ${testName}.</p>
          <button onclick="window.location.href='/select-test'">Повернутися до вибору тесту</button>
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
            ${q.picture ? `<img src="${q.picture}" alt="Зображення питання" onerror="this.src='/images/placeholder.png'">` : ''}
            <p>Питання ${idx + 1}: ${q.text}</p>
            <div class="options">
              ${q.options.map(opt => `<div class="option">${opt}</div>`).join('')}
            </div>
            <p>Правильна відповідь: ${q.correctAnswers.join(', ')}</p>
          </div>
        `).join('')}
        <button onclick="window.location.href='/select-test'">Повернутися до вибору тесту</button>
      </body>
    </html>
  `);
});

// Маршрут для выхода
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error(`Ошибка при выходе: ${err.message}`);
      return res.redirect('/select-test');
    }
    console.log('Пользователь вышел');
    res.redirect('/login');
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  await initializeServer();
});
