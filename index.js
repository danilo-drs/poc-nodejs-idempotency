const express = require('express');
const bodyParser = require('body-parser');
const { argv } = require('yargs').default('port', 3000);
const idempotencyMiddleware = require('./idempotency-meddleware');

const app = express();
app.use(bodyParser.json());

app.use(idempotencyMiddleware);

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

app.post('/', async (req, res) => {
  console.log('ENTROU no método');
  const { delay } = req.body;
  await sleep(delay);
  console.log('FIM do método');
  res.send({ ...req.body, random: Math.trunc(Math.random() * 1000) });
});

app.listen(argv.port, () => {
  console.log(`App listening on port ${argv.port}!`);
});
