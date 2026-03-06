const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbDir = path.join(__dirname, 'storage', 'db');
const audioDir = path.join(__dirname, 'storage', 'audio');
const dbPath = path.join(dbDir, 'meetings.db');

fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    status TEXT,
    started_at TEXT,
    ended_at TEXT,
    cliente TEXT,
    proyecto TEXT,
    responsable TEXT,
    participantes TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    chunk_number INTEGER,
    file_path TEXT,
    processed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    chunk_number INTEGER,
    speaker TEXT,
    text TEXT,
    timestamp TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS actas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT UNIQUE,
    acta_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tareas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    tarea_id TEXT,
    tipo TEXT,
    descripcion TEXT,
    responsable TEXT,
    estado TEXT DEFAULT 'pendiente',
    fecha_compromiso TEXT,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
  )`);
});

db.close((err) => {
  if (err) {
    console.error('Error closing database:', err.message);
    process.exit(1);
  }
  console.log('Database initialized successfully');
});
