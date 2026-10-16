const { app } = require('electron');
app.whenReady().then(() => {
  let sqlite = 'missing';
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table t(a)');
    db.prepare('insert into t values (?)').run(1);
    sqlite = 'ok ' + JSON.stringify(db.prepare('select count(*) c from t').get());
  } catch (e) { sqlite = 'error ' + e.message; }
  console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome, sqlite }));
  app.quit();
});
