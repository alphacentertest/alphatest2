const express = require('express');
const session = require('express-session');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs').promises;

const app = express();

// Пароли для каждого пользователя
const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
};

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// Главная страница (логин)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Обработка логина
app.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    console.log('Login attempt:', { password });
    if (!password) return res.status(400).json({ success: false, message: 'Пароль не вказано' });
    const user = Object.keys(validPasswords).find(u => validPasswords[u] === password);
    if (!user) return res.status(401).json({ success: false, message: 'Невірний пароль' });

    req.session.loggedIn = true;
    req.session.user = user;
    req.session.results = req.session.results || [];
    req.session.answers = req.session.answers || {};
    console.log('Session after login:', req.session);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера', details: error.message });
  }
});

// Страница выбора теста
app.get('/select-test', (req, res) => {
  console.log('Accessing /select-test, session:', req.session);
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  res.send(`
    <html>
      <body>
        <h1>Виберіть тест</h1>
        <button onclick="window.location.href='/test?test=1'">Почати Тест 1</button>
        <button onclick="window.location.href='/test?test=2'">Почати Тест 2</button>
      </body>
    </html>
  `);
});

// Загрузка вопросов из файла
const loadQuestions = async (testNumber) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const filePath = path.join(__dirname, `questions${testNumber}.xlsx`);
    console.log(`Reading file: ${filePath}`);
    await workbook.xlsx.readFile(filePath);
    const jsonData = [];
    const sheet = workbook.getWorksheet('Questions');

    if (!sheet) throw new Error(`Лист "Questions" не знайдено в questions${testNumber}.xlsx`);

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        console.log(`Row ${rowNumber}:`, rowValues);
        jsonData.push({
          question: String(rowValues[0] || ''),
          options: rowValues.slice(1, 7).filter(Boolean),
          correctAnswers: rowValues.slice(7, 10).filter(Boolean),
          type: rowValues[10] || 'multiple',
          points: Number(rowValues[11]) || 0
        });
      }
    });

    console.log(`Questions loaded for test ${testNumber}:`, jsonData);
    return jsonData;
  } catch (error) {
    console.error(`Ошибка в loadQuestions (test ${testNumber}):`, error.stack);
    throw error;
  }
};

// Маршрут для теста
app.get('/test', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  const testNumber = req.query.test === '2' ? 2 : 1;
  req.session.currentTest = testNumber;
  try {
    const questions = await loadQuestions(testNumber);
    const enhancedQuestions = questions.map((q) => {
      const pictureMatch = q.question.match(/^Picture (\d+)/i);
      if (pictureMatch) {
        const pictureNum = pictureMatch[1];
        q.image = `/images/Picture ${pictureNum}.png`;
        q.question = q.question.replace(/^Picture \d+\s*/i, '');
      }
      return q;
    });

    let html = `
      <html>
        <body>
          <h1>Тест ${testNumber}</h1>
          <form id="testForm">
    `;
    enhancedQuestions.forEach((q, index) => {
      html += `<div>
        <p>${index + 1}. ${q.question}</p>`;
      if (q.image) {
        html += `<img src="${q.image}" alt="Picture" style="max-width: 300px;"><br>`;
      }
      q.options.forEach((option, optIndex) => {
        html += `
          <input type="radio" name="q${index}" value="${option}" id="q${index}_${optIndex}">
          <label for="q${index}_${optIndex}">${option}</label><br>
        `;
      });
      html += `</div><br>`;
    });
    html += `
          <button type="button" onclick="submitAnswers()">Відправити відповіді</button>
          </form>
          <script>
            async function submitAnswers() {
              const form = document.getElementById('testForm');
              const answers = {};
              ${enhancedQuestions.map((_, i) => `
                const selected = form.querySelector('input[name="q${i}"]:checked');
                if (selected) answers[${i}] = [selected.value];
              `).join('')}
              await fetch('/answer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers })
              });
              const response = await fetch('/result');
              const data = await response.json();
              alert('Ваш результат: ' + data.score + ' з ' + data.totalPoints);
              window.location.href = '/results';
            }
          </script>
        </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

// Сохранение ответа
app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) return res.status(403).json({ error: 'Не авторизовано' });
  try {
    if (!req.session.answers) req.session.answers = {};
    const { answers } = req.body;
    Object.keys(answers).forEach(index => {
      req.session.answers[index] = answers[index];
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Ошибка при сохранении ответа', details: error.message });
  }
});

// Подсчет результатов
app.get('/result', async (req, res) => {
  if (!req.session.loggedIn) return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  const testNumber = req.session.currentTest || 1;
  try {
    const questions = await loadQuestions(testNumber);
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
    const answers = req.session.answers || {};

    questions.forEach((q, index) => {
      const userAnswer = answers[index];
      if (q.type === 'multiple' && userAnswer) {
        const correctAnswers = q.correctAnswers.map(String);
        if (Array.isArray(userAnswer) && 
            userAnswer.length === correctAnswers.length && 
            userAnswer.every(val => correctAnswers.includes(String(val))) && 
            correctAnswers.every(val => userAnswer.includes(String(val)))) {
          score += q.points;
        }
      } else if (q.type === 'input' && userAnswer && typeof userAnswer === 'string') {
        if (userAnswer.trim().toLowerCase() === q.correctAnswers[0].toLowerCase()) score += q.points;
      }
    });

    const resultData = { 
      user: req.session.user, 
      test: `Test ${testNumber}`, 
      score, 
      totalPoints, 
      answers, 
      timestamp: new Date().toISOString() 
    };
    req.session.results = req.session.results || [];
    req.session.results.push(resultData);
    console.log('Saved result:', resultData);
    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка в /result:', error.stack);
    res.status(500).json({ error: 'Помилка при підрахунку результатів', details: error.message });
  }
});

// Просмотр результатов
app.get('/results', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  const adminPassword = 'admin123';
  try {
    const allResults = req.session.results || [];
    if (req.query.admin === adminPassword) {
      res.json(allResults);
    } else {
      const userResults = allResults.filter(result => result.user === req.session.user);
      res.json(userResults);
    }
  } catch (error) {
    console.error('Ошибка в /results:', error.stack);
    res.status(500).json({ error: 'Помилка при завантаженні результатів', details: error.message });
  }
});

// Экспорт для Vercel
module.exports = app;

// Локальный запуск
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}