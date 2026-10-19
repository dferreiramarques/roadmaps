'use strict';
// Load a roadmaps file into the data folder:   node scripts/seed.js [path/to/roadmap.json]
// Products with the same id are replaced; the old versions stay in their history.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Store } = require('../src/store');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'seed', 'roadmap.json'));
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = new Store(dataDir);
  await store.init();
  const done = await store.importAll(JSON.parse(await fs.readFile(file, 'utf8')));
  console.log(`Imported ${done.length} product(s) from ${file} into ${dataDir}`);
})().catch(e => { console.error(e.message); process.exit(1); });
