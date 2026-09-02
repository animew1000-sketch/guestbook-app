const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const SYNC_INTERVAL_MS = 1000; // Polls Clever Cloud every 5 seconds

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

        // --- PULL USERS ---
        const [users] = await mysqlPool.query('SELECT * FROM users');
        for (const u of users) {
            await sqliteDb.run(
                `INSERT INTO users (id, email, password_hash, username, avatar_url, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON CONFLICT(id) DO UPDATE SET 
                 email=excluded.email, password_hash=excluded.password_hash, username=excluded.username, avatar_url=excluded.avatar_url`,
                [u.id, u.email, u.password_hash, u.username, u.avatar_url, u.created_at]
            );
        }

        // --- PULL FOLLOWS ---
        const [follows] = await mysqlPool.query('SELECT * FROM follows');
        for (const f of follows) {
            await sqliteDb.run(
                `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)`,
                [f.follower_id, f.following_id, f.created_at]
            );
        }

        // --- PULL MESSAGES ---
        const [messages] = await mysqlPool.query('SELECT * FROM messages');
        for (const m of messages) {
            await sqliteDb.run(
                `INSERT INTO messages (id, user_id, name, message, image_url, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON CONFLICT(id) DO UPDATE SET 
                 message=excluded.message, image_url=excluded.image_url`,
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