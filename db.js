require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');

// On Render (production), lock to clevercloud. Locally, default to xampp.
const engine = process.env.NODE_ENV === 'production' 
    ? 'clevercloud' 
    : (process.env.DB_ENGINE || 'xampp');

let pool, sqliteDb;

async function getDb() {
    if (pool || sqliteDb) return { pool, sqliteDb, engine };

    if (engine === 'xampp') {
        pool = mysql.createPool({
            host: process.env.XAMPP_HOST || 'localhost',
            user: process.env.XAMPP_USER || 'root',
            password: process.env.XAMPP_PASSWORD || '',
            database: process.env.XAMPP_DB || 'guestbook_db',
            port: Number(process.env.XAMPP_PORT || 3306),
            waitForConnections: true,
            connectionLimit: 10
        });
        console.log('Active Engine: LOCAL XAMPP MySQL');
    } else if (engine === 'sqlite') {
        // Dynamically load SQLite only when running locally
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');
        
        sqliteDb = await open({
            filename: path.join(__dirname, 'database.db'),
            driver: sqlite3.Database
        });
        console.log('Active Engine: LOCAL SQLite');
    } else {
        pool = mysql.createPool({
            host: process.env.CLEVER_HOST || process.env.MYSQL_ADDON_HOST,
            user: process.env.CLEVER_USER || process.env.MYSQL_ADDON_USER,
            password: process.env.CLEVER_PASSWORD || process.env.MYSQL_ADDON_PASSWORD,
            database: process.env.CLEVER_DB || process.env.MYSQL_ADDON_DB,
            port: Number(process.env.CLEVER_PORT || process.env.MYSQL_ADDON_PORT || 3306),
            waitForConnections: true,
            connectionLimit: 10
        });
        console.log('Active Engine: CLEVER CLOUD MySQL');
    }

    return { pool, sqliteDb, engine };
}

async function query(sql, params = []) {
    const { pool, sqliteDb, engine } = await getDb();
    if (engine === 'sqlite') {
        if (sql.trim().toUpperCase().startsWith('SELECT')) return await sqliteDb.all(sql, params);
        return await sqliteDb.run(sql, params);
    } else {
        const [rows] = await pool.query(sql, params);
        return rows;
    }
}

module.exports = { getDb, query };