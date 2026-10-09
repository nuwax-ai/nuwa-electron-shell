import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import log from 'electron-log';
import { APP_DATA_DIR_NAME } from './services/constants';
import { APP_NAME_IDENTIFIER } from '@shared/constants';

const nuwaxHome = path.join(app.getPath('home'), APP_DATA_DIR_NAME);
const dbPath = path.join(nuwaxHome, `${APP_NAME_IDENTIFIER}.db`);

let db: Database.Database | null = null;

function isCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB');
}

function prepareDatabase(handle: Database.Database): void {
  // Create tables
  handle.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  log.info('Database tables created');
  // 建表语句只触碰 schema 页；quick_check 才能发现其余数据页的损坏
  const verdict = handle.pragma('quick_check', { simple: true });
  if (verdict !== 'ok') {
    throw Object.assign(new Error(`quick_check failed: ${String(verdict)}`), { code: 'SQLITE_CORRUPT' });
  }
  // Seed only a missing preference: upgrades and same-version promotion must
  // keep the user's subscription, including a stable choice made on beta.
  const channel = /-beta(?:\.|$)/.test(app.getVersion()) ? 'beta' : 'stable';
  handle.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run('update_channel', JSON.stringify(channel));
}

/**
 * 损坏文件连同日志旁路文件整体改名保留供排查，不删除用户数据。
 * 旁路文件先于主文件移动；任一步失败都把已移动的文件改回原处并返回 null，
 * 避免主文件已走、-wal 仍留在原路径，被之后新建的库当作自己的日志回放。
 */
function quarantineCorruptDatabase(): string | null {
  const backup = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const moved: Array<[from: string, to: string]> = [];
  const move = (from: string, to: string): void => {
    fs.renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(dbPath + suffix)) move(dbPath + suffix, backup + suffix);
    }
    move(dbPath, backup);
    return backup;
  } catch (error) {
    log.error('Failed to move corrupt database aside:', error);
    for (const [from, to] of moved.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch (restoreError) {
        log.error(`Failed to restore ${from} after an incomplete quarantine:`, restoreError);
      }
    }
    return null;
  }
}

export function initDatabase(): void {
  try {
    db = new Database(dbPath);
    log.info('Database initialized at:', dbPath);
    prepareDatabase(db);
    return;
  } catch (error) {
    log.error('Database initialization failed:', error);
    // 只读、磁盘满、被锁等非损坏错误保持原行为：句柄仍可读，不挪动文件
    if (!isCorruption(error)) return;
  }

  // 损坏时旧句柄上每次读写都会抛错，且下次启动会重复同样的失败；挪开后重建一个可用的库
  try { db?.close(); } catch { /* 句柄已不可用 */ }
  db = null;
  const backup = quarantineCorruptDatabase();
  if (!backup) return;
  log.error(`Corrupt database moved to ${backup}; starting with a fresh database`);
  try {
    db = new Database(dbPath);
    prepareDatabase(db);
    log.info('Database re-created at:', dbPath);
  } catch (error) {
    log.error('Database re-creation failed:', error);
    // 全新文件上建表失败的句柄读不到任何内容，留着只会让启动期的 readSetting 抛 no such table
    try { db?.close(); } catch { /* 句柄已不可用 */ }
    db = null;
  }
}

export function getDb(): Database.Database | null {
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('[App] Database closed');
  }
}

export function readSetting(key: string): unknown {
  const row = db?.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function writeSetting(key: string, value: unknown): boolean {
  if (!db) return false;
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
  return true;
}
