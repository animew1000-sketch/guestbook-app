const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const SYNC_INTERVAL_MS = 1000; // Polls Clever Cloud every 1 second

async function syncOnce() {
    let mysqlPool, sqliteDb;

    try {
        // 1. Connect to Live Clever Cloud MySQL
        mysqlPool = mysql.createPool({
            host: process.env.MYSQL_ADDON_HOST,
            user: process.env.MYSQL_ADDON_USER,
            password: process.env.MYSQL_ADDON_PASSWORD,
            database: process.env.MYSQL_ADDON_DB,
            port: Number(process.env.MYSQL_ADDON_PORT || 3306),
            waitForConnections: true,
            connectionLimit: 2
        });

        // 2. Open Local SQLite Database
        sqliteDb = await open({
            filename: path.join(__dirname, 'database.db'),
            driver: sqlite3.Database
        });

        // 3. Ensure Local SQLite Tables Exist
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
                PRIMARY KEY (follower_id, following_id),
                FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INT,
                name TEXT,
                message TEXT,
                image_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
        `);

        // Migration check: Add user_id column to messages table if missing in database.db
        try {
            await sqliteDb.exec(`ALTER TABLE messages ADD COLUMN user_id INT;`);
        } catch (mErr) {
            // Ignored if column user_id already exists
        }

        // --- PULL USERS (WITH DELETION SYNC) ---
        const [users] = await mysqlPool.query('SELECT * FROM users');
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

        // --- PULL FOLLOWS (WITH DELETION SYNC) ---
        const [follows] = await mysqlPool.query('SELECT * FROM follows');
        await sqliteDb.run(`DELETE FROM follows`); // Clear existing local relationships to catch any unfollow actions

        for (const f of follows) {
            await sqliteDb.run(
                `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)`,
                [f.follower_id, f.following_id, f.created_at]
            );
        }

        // --- PULL MESSAGES (WITH DELETION SYNC) ---
        const [messages] = await mysqlPool.query('SELECT * FROM messages');
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

        console.log(`[${new Date().toLocaleTimeString()}] Local database.db updated successfully.`);
    } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Sync error:`, err.message);
    } finally {
        if (sqliteDb) await sqliteDb.close();
        if (mysqlPool) await mysqlPool.end();
    }
}

console.log(`Starting real-time local sync (polling every ${SYNC_INTERVAL_MS / 1000}s)...`);
syncOnce();
setInterval(syncOnce, SYNC_INTERVAL_MS);