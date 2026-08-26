# nemkit

Toolkit opinionado para construir APIs RESTful con **Node.js + Express + MongoDB**, production-ready, modular y con principios SOLID.

**nem** = Node + Express + Mongo | **kit** = toolkit

## Filosofía

- Mínimas dependencias externas (solo 4: express, mongoose, jsonwebtoken, dotenv)
- Todo lo demás es implementación propia: logger, cache, rate-limiter, validador, crypto, CORS, storage
- Modular: usa solo lo que necesitas
- Legible y mantenible
- Expone las libs base (express, mongoose, jwt) para uso directo

## Instalación

```bash
npm install nemkit
```

## Estructura

```
nemkit/src/modules/
├── core/           → createApp, createServer, loadEnv, MongoClient
├── data/           → BaseRepository, MongoRepository, BaseService, platformSchema
├── http/           → BaseController, errors, errorMiddleware, response, requestId
├── security/       → JwtManager, auth, cors, crypto, rateLimiter
├── observability/  → RequestContext (AsyncLocalStorage)
├── logs/           → Logger (rotación, niveles, child loggers)
├── cache/          → MemoryCache (LRU/LFU, TTL, stale-while-revalidate)
├── storage/        → DiskStorage, MemoryStorage (streaming, Range support)
├── queue/          → Cola de tareas en memoria (concurrency, retry, DLQ, priority)
├── seeds/          → Seeder para data por defecto (upsert, bulk, dry run)
├── helpers/        → UniqueNumberUtil, pagination, date, queryFilters
└── validators/     → Validador schema-based (sin express-validator)
```

## Uso rápido

```js
const { createApp, createServer, loadEnv, MongoClient, createLogger, requestIdMiddleware } = require('nemkit');

const env = loadEnv({
  PORT: { type: 'number', default: 3000 },
  MONGODB_URI: { required: true },
});

const logger = createLogger({ level: 'info', appName: 'my-api' });
const mongo = new MongoClient({ uri: env.MONGODB_URI, logger });
const app = createApp({ logger });

app.use(requestIdMiddleware);

// ... rutas ...

createServer({ app, mongo, logger, port: env.PORT });
```

## Módulos

### core

```js
const { createApp, createServer, loadEnv, MongoClient } = require('nemkit');
```

### data (Repository + Service)

```js
const { MongoRepository, BaseService } = require('nemkit');

class UsersRepository extends MongoRepository {
  constructor() { super(UserModel); }
}

class UsersService extends BaseService {
  constructor() { super(new UsersRepository()); }
}
```

### http (Controller + Errors + Response)

```js
const { BaseController, HttpError, success, created, paginated } = require('nemkit');

class UsersController extends BaseController {
  constructor() {
    super(usersService, { createSchema: { name: { type: 'string', required: true } } });
    this.searchFields = ['name', 'email'];
  }
}
```

### security

```js
const { JwtManager, createAuthMiddleware, createCorsMiddleware, createRateLimiter, hashPassword, comparePassword } = require('nemkit');
```

### validators

```js
const { createValidator } = require('nemkit');

const userValidator = createValidator({
  name:  { type: 'string', required: true, trim: true, minLength: 2 },
  email: { type: 'email', required: true, lowercase: true },
  age:   { type: 'number', min: 18 },
});

router.post('/users', userValidator.middleware(), controller.create);
```

### storage

```js
const { DiskStorage, MemoryStorage, serveFile } = require('nemkit');

const disk = new DiskStorage({ basePath: './uploads' });
await disk.save('videos/intro.mp4', buffer, { mime: 'video/mp4' });

// Servir con Range support (video streaming)
app.get('/files/:key(*)', (req, res) => serveFile(req, res, disk, req.params.key));
```

### cache

```js
const { createCache } = require('nemkit');

const cache = createCache({ maxSize: 5000, defaultTtlMs: 60000, policy: 'LRU' });
const data = await cache.getOrSet('users:list', () => db.find({}));
```

### queue

```js
const { createQueue } = require('nemkit');

const emailQueue = createQueue('emails', {
  concurrency: 3,
  maxRetries: 3,
  retryDelayMs: 1000,
  backoffMultiplier: 2,
  jobTimeoutMs: 30000,
});

emailQueue.process(async (job) => {
  await sendEmail(job.data.to, job.data.template);
});

emailQueue.add({ to: 'user@mail.com', template: 'welcome' });
emailQueue.add({ to: 'vip@mail.com', template: 'alert' }, { priority: 'high' });

emailQueue.on('completed', (job) => logger.info('Done', { jobId: job.id }));
emailQueue.on('dead', (job) => logger.error('Dead', { jobId: job.id }));
```

### seeds

```js
const { createSeeder } = require('nemkit');

const seeder = createSeeder({ logger });

// Upsert por _id
await seeder.run(RoleModel, [
  { _id: 1, name: 'Admin', code: 'ADMIN', permissions: ['users.read', 'users.write'] },
  { _id: 2, name: 'User', code: 'USER', permissions: ['profile.read'] },
]);

// Upsert por campo custom
await seeder.run(CatalogModel, catalogs, { matchKey: 'code' });

// Desde archivo JSON
await seeder.runFromFile(CatalogModel, './seeds/catalogs.json', { matchKey: 'code' });

// Dry run (simula sin ejecutar)
await seeder.run(RoleModel, data, { dryRun: true });
```

### logs

```js
const { createLogger } = require('nemkit');

const logger = createLogger({ level: 'info', appName: 'my-api', logsPath: './logs' });
logger.info('Server started', { port: 3000 });

const childLog = logger.child({ requestId: '01ABC', module: 'auth' });
childLog.warn('Token expired');
```

### Libs expuestas

```js
const { express, mongoose, jwt, dotenv } = require('nemkit');

const router = express.Router();
const Schema = mongoose.Schema;
```

## Dependencias

| Paquete | Razón |
|---------|-------|
| `express` | HTTP framework |
| `mongoose` | ODM MongoDB |
| `jsonwebtoken` | JWT sign/verify |
| `dotenv` | Carga .env |

Todo lo demás es **nativo de Node.js**: crypto (scrypt), streams, fs, async_hooks.

## Requisitos

- Node.js >= 20.0.0
- MongoDB >= 6.0

## Licencia

MIT
