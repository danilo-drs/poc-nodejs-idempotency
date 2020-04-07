const redis = require('redis');
const util = require('util');

const client = redis.createClient({ db: 11 });
const subscriber = redis.createClient({ db: 11 });
const publisher = redis.createClient({ db: 11 });

const IDEMPOTENTING = 'IDEMPOTENT-PENDING';


client.on('error', console.error);
subscriber.on('error', console.error);


client.setnxP = util.promisify(client.setnx);

const argv = require('yargs')
  .default('key', 10)
  .default('value', 10)
  .argv();

console.log('key:', argv.key);
console.log('value:', argv.value);
console.log('delete:', argv.delete);


const setIdempotentresult = (value) => {

};

client.setnxP(argv.key, 'PENDING')
  .then((keySaving) => {
    console.log('keySaving:', keySaving);
    if (argv.delete) client.del(argv.key);

    client.set(argv.key, argv.value);
    publisher.publish(argv.key, argv.value);
    console.log('MUDOU');
  });


const getIdempotentExecution = (key) => new Promise((resolve) => {
  subscriber.subscribe(key); // guarantee that the value will be streammed if necessary
  subscriber.on('message', (channel, message) => {
    if (message !== IDEMPOTENTING) {
      resolve(message);
    }
  });

  client.setnx(key, IDEMPOTENTING)
    .then((pStatus) => {
      if (pStatus === 0) {
        const actualValue = client.get(key);
        if (message !== IDEMPOTENTING) {
          subscriber.unsubscribe(key);
          resolve(actualValue);
        } else {
          setTimeout(() => reject('idempotent time-out'), 5000);
        }
      }
    });
})
  .finally((result) => {
    publisher.unsubscribe();
  });

// // node-base request

// before post
// Se existir e o retorno
