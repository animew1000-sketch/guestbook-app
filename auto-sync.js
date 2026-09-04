require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');

const SYNC_INTERVAL_MS = 1000;
const activeEngine = process.env.DB_ENGINE || 'clevercloud';

async function syncOnce() {
    let sourcePool, targetXamppPool, sqliteDb;

    try {
        // Dynamic load for SQLite to prevent Render deployment build errors
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');

        // 1. Open Local SQLite Database
        sqliteDb = await open({
            filename: path.join(__dirname, 'database.db'),
            driver: sqlite3.Database
        });

        // Ensure Local SQLite Tables Exist
        await sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                avatar_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS follows (
                follower_id INT,
                following_id INT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (follower_id, following_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INT,
                name TEXT,
                message TEXT,
                image_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        try {
            await sqliteDb.exec(`ALTER TABLE messages ADD COLUMN user_id INT;`);
        } catch (mErr) {}

        // Determine source database pool based on active DB_ENGINE setting
        if (activeEngine === 'xampp') {
            sourcePool = mysql.createPool({
                host: process.env.XAMPP_HOST || 'localhost',
                user: process.env.XAMPP_USER || 'root',
                password: process.env.XAMPP_PASSWORD || '',
                database: process.env.XAMPP_DB || 'guestbook_db',
                port: Number(process.env.XAMPP_PORT || 3306),
                waitForConnections: true,
                connectionLimit: 2
            });
        } else {
            sourcePool = mysql.createPool({
                host: process.env.CLEVER_HOST || process.env.MYSQL_ADDON_HOST,
                user: process.env.CLEVER_USER || process.env.MYSQL_ADDON_USER,
                password: process.env.CLEVER_PASSWORD || process.env.MYSQL_ADDON_PASSWORD,
                database: process.env.CLEVER_DB || process.env.MYSQL_ADDON_DB,
                port: Number(process.env.CLEVER_PORT || process.env.MYSQL_ADDON_PORT || 3306),
                waitForConnections: true,
                connectionLimit: 2
            });
        }

        // Pull active source data
        const [users] = await sourcePool.query('SELECT * FROM users');
        const [follows] = await sourcePool.query('SELECT * FROM follows');
        const [messages] = await sourcePool.query('SELECT * FROM messages');

        // -------------------------------------------------------------
        // 1. ALWAYS SYNC TO SQLITE (database.db)
        // -------------------------------------------------------------
        const liveUserIds = users.map(u => u.id);
        if (liveUserIds.length > 0) {
            const userPlaceholders = liveUserIds.map(() => '?').join(',');
            await sqliteDb.run(`DELETE FROM users WHERE id NOT IN (${userPlaceholders})`, liveUserIds);
        } else {
            await sqliteDb.run(`DELETE FROM users`);
        }
        for (const u of users) {
            await sqliteDb.run(
                `INSERT INTO users (id, email, password_hash, username, avatar_url, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON CONFLICT(id) DO UPDATE SET 
                 email=excluded.email, password_hash=excluded.password_hash, username=excluded.username, avatar_url=excluded.avatar_url`,
                [u.id, u.email, u.password_hash, u.username, u.avatar_url, u.created_at]
            );
        }

        await sqliteDb.run(`DELETE FROM follows`);
        for (const f of follows) {
            await sqliteDb.run(
                `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)`,
                [f.follower_id, f.following_id, f.created_at]
            );
        }

        const liveMsgIds = messages.map(m => m.id);
        if (liveMsgIds.length > 0) {
            const msgPlaceholders = liveMsgIds.map(() => '?').join(',');
            await sqliteDb.run(`DELETE FROM messages WHERE id NOT IN (${msgPlaceholders})`, liveMsgIds);
        } else {
            await sqliteDb.run(`DELETE FROM messages`);
        }
        for (const m of messages) {
            await sqliteDb.run(
                `INSERT INTO messages (id, user_id, name, message, image_url, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON CONFLICT(id) DO UPDATE SET 
                 message=excluded.message, image_url=excluded.image_url, user_id=excluded.user_id`,
                [m.id, m.user_id, m.name, m.message, m.image_url, m.created_at]
            );
        }

        // -------------------------------------------------------------
        // 2. SYNC TO XAMPP (Only when Clever Cloud is the primary source)
        // -------------------------------------------------------------
        if (activeEngine === 'clevercloud') {
            try {
                targetXamppPool = mysql.createPool({
                    host: process.env.XAMPP_HOST || 'localhost',
                    user: process.env.XAMPP_USER || 'root',
                    password: process.env.XAMPP_PASSWORD || '',
                    database: process.env.XAMPP_DB || 'guestbook_db',
                    port: Number(process.env.XAMPP_PORT || 3306),
                    waitForConnections: true,
                    connectionLimit: 2,
                    connectTimeout: 500
                });

                if (liveUserIds.length > 0) {
                    const userPlaceholders = liveUserIds.map(() => '?').join(',');
                    await targetXamppPool.query(`DELETE FROM users WHERE id NOT IN (${userPlaceholders})`, liveUserIds);
                } else {
                    await targetXamppPool.query(`DELETE FROM users`);
                }
                for (const u of users) {
                    await targetXamppPool.query(
                        `INSERT INTO users (id, email, password_hash, username, avatar_url, created_at) 
                         VALUES (?, ?, ?, ?, ?, ?) 
                         ON DUPLICATE KEY UPDATE 
                         email=VALUES(email), password_hash=VALUES(password_hash), username=VALUES(username), avatar_url=VALUES(avatar_url)`,
                        [u.id, u.email, u.password_hash, u.username, u.avatar_url, u.created_at]
                    );
                }

                await targetXamppPool.query(`DELETE FROM follows`);
                for (const f of follows) {
                    await targetXamppPool.query(
                        `INSERT IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)`,
                        [f.follower_id, f.following_id, f.created_at]
                    );
                }

                if (liveMsgIds.length > 0) {
                    const msgPlaceholders = liveMsgIds.map(() => '?').join(',');
                    await targetXamppPool.query(`DELETE FROM messages WHERE id NOT IN (${msgPlaceholders})`, liveMsgIds);
                } else {
                    await targetXamppPool.query(`DELETE FROM messages`);
                }
                for (const m of messages) {
                    await targetXamppPool.query(
                        `INSERT INTO messages (id, user_id, name, message, image_url, created_at) 
                         VALUES (?, ?, ?, ?, ?, ?) 
                         ON DUPLICATE KEY UPDATE 
                         message=VALUES(message), image_url=VALUES(image_url), user_id=VALUES(user_id)`,
                        [m.id, m.user_id, m.name, m.message, m.image_url, m.created_at]
                    );
                }
            } catch (xErr) {}
        }

        console.log(`[${new Date().toLocaleTimeString()}] Mode [${activeEngine.toUpperCase()}]: Synced database successfully.`);

    } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Sync error:`, err.message);
    } finally {
        if (sqliteDb) await sqliteDb.close();
        if (sourcePool) await sourcePool.end();
        if (targetXamppPool) await targetXamppPool.end();
    }
}

console.log(`Starting dynamic engine sync (polling every ${SYNC_INTERVAL_MS / 1000}s)...`);
syncOnce();
setInterval(syncOnce, SYNC_INTERVAL_MS);