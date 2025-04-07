const crypto = require('crypto');

const sessionSecret = crypto.randomBytes(32).toString('base64');
console.log('Generated session secret:', sessionSecret);
