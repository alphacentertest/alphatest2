const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const fs = require('fs').promises;

const app = express();

// Пароли
const validPasswords = {
  'user1': 'pass123',
  'user2': 'pass456',
  'user3': 'pass789'
};

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Логин
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
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /login:', error.stack);
    res.status(500).json({ success: false, message: 'Помилка сервера', details: error.message });
  }
});

// Проверка авторизации
const checkAuth = (req, res, next) => {
  const user = req.cookies.auth;
  if (!user || !validPasswords[user]) {
    return res.status(403).json({ error: 'Будь ласка, увійдіть спочатку' });
  }
  req.user = user;
  next();
};

// Выбор теста
app.get('/select-test', checkAuth, (req, res) => {
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

// Загрузка вопросов
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
        jsonData.push({
          question: String(rowValues[0] || ''),
          options: rowValues.slice(1, 7).filter(Boolean),
          correctAnswers: rowValues.slice(7, 10).filter(Boolean),
          type: rowValues[10] || 'multiple',
          points: Number(rowValues[11]) || 0
        });
      }
    });
    return jsonData;
  } catch (error) {
    console.error(`Ошибка в loadQuestions (test ${testNumber}):`, error.stack);
    throw error;
  }
};

// Хранилище тестов
const userTests = new Map();

// Начало теста
app.get('/test', checkAuth, async (req, res) => {
  const testNumber = req.query.test === '2' ? 2 : 1;
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

    userTests.set(req.user, {
      testNumber,
      questions: enhancedQuestions,
      answers: {},
      currentQuestion: 0
    });

    res.redirect(`/test/question?index=0`);
  } catch (error) {
    console.error('Ошибка в /test:', error.stack);
    res.status(500).send('Помилка при завантаженні тесту');
  }
});

// Отображение вопроса
app.get('/test/question', checkAuth, (req, res) => {
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).send('Тест не розпочато');

  const { questions, currentQuestion, testNumber } = userTest;
  const index = parseInt(req.query.index) || 0;

  if (index < 0 || index >= questions.length) {
    return res.status(400).send('Невірний номер питання');
  }

  userTest.currentQuestion = index;
  const q = questions[index];
  let html = `
    <html>
      <body>
        <h1>Тест ${testNumber}</h1>
        <div>
          <p>${index + 1}. ${q.question}</p>
  `;
  if (q.image) {
    html += `<img src="${q.image}" alt="Picture" style="max-width: 300px;"><br>`;
  }
  q.options.forEach((option, optIndex) => {
    const checked = userTest.answers[index]?.includes(option) ? 'checked' : '';
    html += `
      <input type="checkbox" name="q${index}" value="${option}" id="q${index}_${optIndex}" ${checked}>
      <label for="q${index}_${optIndex}">${option}</label><br>
    `;
  });
  html += `
        </div><br>
        <button ${index === 0 ? 'disabled' : ''} onclick="window.location.href='/test/question?index=${index - 1}'">Назад</button>
        <button ${index === questions.length - 1 ? 'disabled' : ''} onclick="saveAndNext(${index})">Вперед</button>
        <button onclick="finishTest(${index})">Завершити тест</button>
        <script>
          async function saveAndNext(index) {
            const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
            const answers = Array.from(checked).map(input => input.value);
            await fetch('/answer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ index, answer: answers })
            });
            window.location.href = '/test/question?index=' + (index + 1);
          }
          async function finishTest(index) {
            const checked = document.querySelectorAll('input[name="q' + index + '"]:checked');
            const answers = Array.from(checked).map(input => input.value);
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

// Сохранение ответа
app.post('/answer', checkAuth, (req, res) => {
  try {
    const { index, answer } = req.body;
    const userTest = userTests.get(req.user);
    if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });
    userTest.answers[index] = answer || [];
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.stack);
    res.status(500).json({ error: 'Ошибка при сохранении ответа', details: error.message });
  }
});

// Результаты
app.get('/result', checkAuth, async (req, res) => {
  const userTest = userTests.get(req.user);
  if (!userTest) return res.status(400).json({ error: 'Тест не розпочато' });

  const { questions, answers, testNumber } = userTest;
  let score = 0;
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);

  questions.forEach((q, index) => {
    const userAnswer = answers[index] || [];
    if (q.type === 'multiple' && userAnswer.length > 0) {
      const correctAnswers = q.correctAnswers.map(String);
      const userAnswers = userAnswer.map(String);
      if (correctAnswers.length === userAnswers.length && 
          correctAnswers.every(val => userAnswers.includes(val)) && 
          userAnswers.every(val => correctAnswers.includes(val))) {
        score += q.points;
      }
    }
  });

  const resultHtml = `
    <html>
      <body>
        <h1>Результати Тесту ${testNumber}</h1>
        <p>Ваш результат: ${score} з ${totalPoints}</p>
        <button onclick="window.location.href='/'">Повернутися на головну</button>
      </body>
    </html>
  `;
  userTests.delete(req.user);
  res.send(resultHtml);
});

// Экспорт для Vercel
module.exports = app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}