const express = require('express');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const redis = require('redis');
const path = require('path');
const ExcelJS = require('exceljs');
const app = express();

// Настройка Redis клиента
const redisClient = redis.createClient({
  url: process.env.REDIS_URL // Будет браться из Vercel
});
redisClient.connect().catch(err => console.error('Redis connect error:', err));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Для HTTPS установите secure: true
}));

// Тестовый маршрут для проверки Redis
app.get('/test-redis', async (req, res) => {
  try {
    await redisClient.set('testKey', 'Redis works!');
    const value = await redisClient.get('testKey');
    res.json({ success: true, value });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const loadQuestions = async () => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(__dirname, 'questions.xlsx')).catch(err => {
      throw new Error(`Не удалось прочитать questions.xlsx: ${err.message}`);
    });
    const sheet = workbook.getWorksheet('Questions');
    if (!sheet) throw new Error('Лист "Questions" не найден');

    const jsonData = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1) {
        const rowValues = row.values.slice(1);
        jsonData.push({
          question: rowValues[0],
          options: rowValues.slice(1, 7).filter(Boolean),
          correctAnswers: rowValues.slice(7, 10).filter(Boolean),
          type: rowValues[10],
          points: rowValues[11] || 0
        });
      }
    });
    if (jsonData.length === 0) throw new Error('Нет данных в листе Questions');
    return jsonData;
  } catch (error) {
    console.error('Ошибка в loadQuestions:', error.message);
    throw error;
  }
};

app.post('/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = 'test123';
  if (password === correctPassword) {
    req.session.loggedIn = true;
    console.log('Session set:', req.session); // Для отладки
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Невірний пароль' });
  }
});

app.get('/questions', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  const questions = await loadQuestions();
  res.json(questions);
});

app.post('/answer', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Не авторизовано');
  }
  try {
    if (!req.session.answers) req.session.answers = {};
    const { index, answer } = req.body;
    if (index === undefined || answer === undefined) {
      throw new Error('Некорректные данные в запросе');
    }
    req.session.answers[index] = answer;
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /answer:', error.message);
    res.status(500).json({ error: 'Ошибка при сохранении ответа' });
  }
});

app.get('/result', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  try {
    const questions = await loadQuestions();
    let score = 0;
    const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
    const answers = req.session.answers || {};

    questions.forEach((q, index) => {
      const userAnswer = answers[index];
      if (q.type === 'multiple' && userAnswer) {
        const correctAnswers = q.correctAnswers;
        const userAnswersArray = Array.isArray(userAnswer) ? userAnswer : [userAnswer];
        if (userAnswersArray.length === correctAnswers.length && 
            userAnswersArray.every(val => correctAnswers.includes(q.options[val]))) {
          score += q.points;
        }
      } else if (q.type === 'input' && userAnswer) {
        if (typeof userAnswer === 'string' && 
            userAnswer.trim().toLowerCase() === q.correctAnswers[0].toLowerCase()) {
          score += q.points;
        }
      }
    });
    res.json({ score, totalPoints });
  } catch (error) {
    console.error('Ошибка в /result:', error.message);
    res.status(500).json({ error: 'Помилка при підрахунку результатів' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});