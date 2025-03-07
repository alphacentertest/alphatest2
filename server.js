const express = require('express');
const session = require('express-session');
const path = require('path');
const ExcelJS = require('exceljs');
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  console.log('Session:', req.session);
  next();
});

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the Quiz API! Use /login to authenticate.' });
});

const loadQuestions = async () => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile('questions.xlsx').catch(err => {
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
  try {
    req.session.loggedIn = true;
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка в /login:', error.message);
    res.status(500).json({ error: 'Ошибка авторизации' });
  }
});

app.get('/questions', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(403).send('Будь ласка, увійдіть спочатку');
  }
  try {
    const questions = await loadQuestions();
    res.json(questions);
  } catch (error) {
    console.error('Ошибка в /questions:', error.message);
    res.status(500).json({ error: 'Помилка сервера при завантаженні питань' });
  }
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