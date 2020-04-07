/* eslint-disable no-console */
const redis = require('redis');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs');
const idmEnum = require('./idempotency_enum');


// should declare as environment variables
const IDEMPOTENCY_REDIS_HOST = 'localhost';
const IDEMPOTENCY_REDIS_DB = 11;
const IDEMPOTENCY_REDIS_PREFIX = 'IDEMPOTENCY_';

const redisConfig = {
  db: IDEMPOTENCY_REDIS_DB,
  host: IDEMPOTENCY_REDIS_HOST,
  prefix: IDEMPOTENCY_REDIS_PREFIX,
};

// Seting up cache environment
const client = redis.createClient(redisConfig);
client.setnxP = util.promisify(client.setnx);
client.getP = util.promisify(client.get);
client.setP = util.promisify(client.set);


// Error handling
client.on('error', console.error);

// sets hard default config
let idmConfig = {
  // >>>> to deploy, this should be default false
  // ENABLED: process.env.IDEMPOTENCY_ENABLED || false,
  ENABLED: process.env.IDEMPOTENCY_ENABLED || true,
  WITH_ERROR: process.env.IDEMPOTENCY_WITH_ERROR || 0,
  TIMEOUT: process.env.IDEMPOTENCY_TIMEOUT || 20000,
  TTL: process.env.IDEMPOTENCY_TTL || 20000,
  BYPASS_METHODS: process.envIDEMPOTENCY_BYPASS_METHODS || 'GET;OPTIONS;',
};

// pre-load config file and override defaults
fs.exists(idmEnum.RC_FILE, (exists) => {
  if (exists) {
    const rawdata = fs.readFileSync(idmEnum.RC_FILE);
    const jsonConf = JSON.parse(rawdata);
    idmConfig = { defaults: { ...idmConfig }, ...jsonConf || {} };
    console.log('idmConfig', idmConfig);
  }
});


const loadMethodConfig = (path, method) => {
  const { defaults } = idmConfig;
  const bypass = defaults.BYPASS_METHODS.indexOf(`${method.toUpperCase()};`) >= 0;

  const methodConfig = {
    ...defaults,
    ENABLED: defaults.ENABLED && !bypass,
  };
  const methodPath = `${method.toUpperCase()}:${path.toLowerCase()}`;
  return {
    ...methodConfig,
    ...idmConfig.paths[methodPath],
  };
};


// function to process the idempotency
const getIdempotentExecution = (key, subscriber, publisher, conf) => new Promise(
  (resolve, reject) => {
    subscriber.subscribe(key); // subscribe to the value as soon as posible

    setTimeout(() => { reject(new Error('ETIMOUT - IDEMPOTENCY TIMEOUT')); }, conf.TIMEOUT);
    subscriber.on('message', (channel, message) => {
      if (channel === key && message !== idmEnum.PENDING) {
        // result has arived, so terminate execution
        resolve(message);
      }
    });

    client.setnxP(key, idmEnum.PENDING)
      .then(async (inserted) => {
        if (!inserted) {
          // key alread exists
          const actualValue = await client.getP(key);
          if (actualValue !== idmEnum.PENDING) {
            resolve(actualValue);
          }
        } else {
          // new key (first call)
          resolve(idmEnum.PENDING);
        }
      });
  },
)
  .finally((result) => {
    publisher.unsubscribe();
    return result;
  });


module.exports = async (req, res, next) => {
  const methodConfig = loadMethodConfig(req.path, req.method);
  console.log('methodConfig', methodConfig);
  if (!methodConfig.ENABLED) {
    next();
    return;
  }

  res.indepontencyStartTime = new Date().getTime();
  // Prepare pub-sub
  const subscriber = redis.createClient(redisConfig);
  const publisher = redis.createClient(redisConfig);
  subscriber.on('error', console.error);
  publisher.on('error', console.error);


  // wraps "res.send" method to finish idempotency pending
  const defaultSend = res.send;
  function newSend(...fullArgs) {
    defaultSend.apply(res, [fullArgs[0]]);
    if (res.idempotentPending) {
      let [body] = fullArgs;
      const { idempotencyKey } = this;
      const status = fullArgs[1] || this.statusCode;
      if (body) {
        const message = JSON.stringify({
          body,
          idempotencyKey,
          status,
        });
        if ((status >= 200 && status <= 299) || methodConfig.WITH_ERROR) {
          delete this.idempotentPending;
          client.set(
            idempotencyKey,
            message,
            'EX',
            methodConfig.TTL,
            () => publisher.publish(idempotencyKey, message),
          );
        }
      }
      body = JSON.stringify(body);
    }
  }
  res.send = newSend.bind(res);

  // mount checksum
  let checksum = req.get('x-idempotency-key');
  checksum = checksum || crypto
    .createHash('sha256')
    .update(JSON.stringify({ body: req.body, path: req.path }))
    .digest('hex');
  res.idempotencyKey = checksum;
  res.set('x-idempotency-key', checksum);

  // process request
  try {
    const processResult = await getIdempotentExecution(
      checksum, subscriber, publisher, methodConfig,
    );
    if (processResult === idmEnum.PENDING) {
      // identified the first call
      res.idempotentPending = true;
      res.set('x-idempotency-duration', new Date().getTime() - res.indepontencyStartTime);
      res.set('x-idempotency-source', idmEnum.SOURCE_API);
      next();
      return;
    }
    // returned from idempotent cache
    const idempotentMessage = JSON.parse(processResult);
    res.set('x-idempotency-duration', new Date().getTime() - res.indepontencyStartTime);
    res.set('x-idempotency-source', idmEnum.SOURCE_CACHE);
    res.send(JSON.parse(idempotentMessage.body), idempotentMessage.status);
    return;
  } catch (error) {
    res.status(408).send({ error: error.message });
  }
};
