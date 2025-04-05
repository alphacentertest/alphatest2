const { createClient } = require('redis');

const redisClient = createClient({
  url: 'redis://default:BnB234v9OBeTLYbpIm2TWGXjnu8hqXO3@redis-13808.c1.us-west-2-2.ec2.redns.redis-cloud.com:13808'
});

redisClient.on('error', (err) => console.error('Redis Error:', err));
redisClient.connect().then(() => {
  console.log('Connected to Redis');
  redisClient.quit();
}).catch(err => console.error('Connect Error:', err));
