const bcrypt = require('bcryptjs');

const password = 'your-admin-password'; // Replace with your desired admin password
const saltRounds = 10;

bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) {
    console.error('Error generating hash:', err);
    return;
  }
  console.log('Generated hash:', hash);
});
