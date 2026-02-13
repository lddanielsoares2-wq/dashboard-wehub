/**
 * Redis Cache Layer for Google Ad Manager metrics
 * Provides fast in-memory caching with automatic expiration
 */

const redis = require('redis');
const sqlite3 = require('sqlite3').verbose();
const { join } = require('path');

// Redis client (will auto-connect when needed)
let redisClient = null;
let redisEnabled = false;

// SQLite database instance (shared from index.js to avoid SQLITE_BUSY errors)
let db = null;

/**
 * Set the shared database instance
 * MUST be called by index.js before using any cache functions
 */
function setDatabase(dbInstance) {
  db = dbInstance;
  console.log('[Cache] Using shared database instance');
}

// Initialize Redis client
async function initRedis() {
  if (redisClient) return redisClient;

  try {
    // Try to connect to Redis (local or via environment variable)
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    redisClient = redis.createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            console.log('[Redis] Max retries reached. Running without Redis.');
            redisEnabled = false;
            return false; // Stop reconnecting
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });

    redisClient.on('error', (err) => {
      console.log('[Redis] Error:', err.message);
      redisEnabled = false;
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected successfully');
      redisEnabled = true;
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.log('[Redis] Failed to connect:', error.message);
    console.log('[Redis] Running without Redis cache (will use SQLite only)');
    redisEnabled = false;
    return null;
  }
}

// Create cache table in SQLite
async function initCacheTable() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS gam_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        cache_key TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        dimension_type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `, (err) => {
      if (err) {
        console.error('[Cache] Failed to create table:', err);
        reject(err);
      } else {
        console.log('[Cache] Table initialized');

        // Create index for faster lookups
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_gam_cache_lookup
          ON gam_cache (user_id, cache_key, expires_at);
        `, () => {
          resolve();
        });
      }
    });
  });
}

// Generate cache key
function generateCacheKey(userId, startDate, endDate, dimensionType = 'AD_UNIT') {
  return `gam:${userId}:${startDate}:${endDate}:${dimensionType}`;
}

// Get from Redis cache
async function getFromRedis(cacheKey) {
  if (!redisEnabled || !redisClient) return null;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log('[Redis] Cache HIT:', cacheKey);
      return JSON.parse(cached);
    }
  } catch (error) {
    console.log('[Redis] Get error:', error.message);
  }

  return null;
}

// Save to Redis cache
async function saveToRedis(cacheKey, data, ttlSeconds = 300) {
  if (!redisEnabled || !redisClient) return;

  try {
    await redisClient.setEx(cacheKey, ttlSeconds, JSON.stringify(data));
    console.log('[Redis] Cached:', cacheKey, '(TTL:', ttlSeconds, 's)');
  } catch (error) {
    console.log('[Redis] Set error:', error.message);
  }
}

// Get from SQLite cache
async function getFromSQLite(userId, cacheKey) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();

    db.get(
      `SELECT data FROM gam_cache
       WHERE user_id = ? AND cache_key = ? AND expires_at > ?`,
      [userId, cacheKey, now],
      (err, row) => {
        if (err) {
          console.error('[SQLite] Get error:', err);
          reject(err);
        } else if (row) {
          console.log('[SQLite] Cache HIT:', cacheKey);
          try {
            resolve(JSON.parse(row.data));
          } catch (parseErr) {
            console.error('[SQLite] Parse error:', parseErr);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    );
  });
}

// Save to SQLite cache
async function saveToSQLite(userId, cacheKey, data, startDate, endDate, dimensionType, ttlSeconds = 300) {
  return new Promise((resolve, reject) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const dataStr = JSON.stringify(data);

    db.run(
      `INSERT OR REPLACE INTO gam_cache
       (user_id, cache_key, data, start_date, end_date, dimension_type, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, cacheKey, dataStr, startDate, endDate, dimensionType, expiresAt],
      (err) => {
        if (err) {
          console.error('[SQLite] Save error:', err);
          reject(err);
        } else {
          console.log('[SQLite] Cached:', cacheKey);
          resolve();
        }
      }
    );
  });
}

// Get cached data (tries Redis first, then SQLite)
async function getCachedData(userId, startDate, endDate, dimensionType = 'AD_UNIT') {
  const cacheKey = generateCacheKey(userId, startDate, endDate, dimensionType);

  // Try Redis first (fastest)
  const redisData = await getFromRedis(cacheKey);
  if (redisData) return redisData;

  // Fallback to SQLite (persistent)
  const sqliteData = await getFromSQLite(userId, cacheKey);

  // If found in SQLite, warm up Redis cache
  if (sqliteData && redisEnabled) {
    await saveToRedis(cacheKey, sqliteData, 300); // 5 minutes TTL
  }

  return sqliteData;
}

// Save to both Redis and SQLite
async function setCachedData(userId, startDate, endDate, dimensionType, data, ttlSeconds = 300) {
  const cacheKey = generateCacheKey(userId, startDate, endDate, dimensionType);

  // Save to both caches in parallel
  await Promise.all([
    saveToRedis(cacheKey, data, ttlSeconds),
    saveToSQLite(userId, cacheKey, data, startDate, endDate, dimensionType, ttlSeconds)
  ]);
}

// Clear expired cache entries from SQLite
async function clearExpiredCache() {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();

    db.run(
      `DELETE FROM gam_cache WHERE expires_at < ?`,
      [now],
      function(err) {
        if (err) {
          console.error('[Cache] Clear expired error:', err);
          reject(err);
        } else {
          if (this.changes > 0) {
            console.log('[Cache] Cleared', this.changes, 'expired entries');
          }
          resolve(this.changes);
        }
      }
    );
  });
}

// Clear all cache for a user
async function clearUserCache(userId) {
  // Clear Redis (pattern matching)
  if (redisEnabled && redisClient) {
    try {
      const keys = await redisClient.keys(`gam:${userId}:*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
        console.log('[Redis] Cleared', keys.length, 'keys for user', userId);
      }
    } catch (error) {
      console.log('[Redis] Clear error:', error.message);
    }
  }

  // Clear SQLite
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM gam_cache WHERE user_id = ?`,
      [userId],
      function(err) {
        if (err) {
          console.error('[SQLite] Clear error:', err);
          reject(err);
        } else {
          console.log('[SQLite] Cleared', this.changes, 'entries for user', userId);
          resolve(this.changes);
        }
      }
    );
  });
}

// Get cache statistics
async function getCacheStats(userId) {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();

    db.all(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) as valid,
        SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) as expired
       FROM gam_cache
       WHERE user_id = ?`,
      [now, now, userId],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows[0] || { total: 0, valid: 0, expired: 0 });
        }
      }
    );
  });
}

// Initialize Redis on module load
initRedis().catch(err => {
  console.log('[Redis] Init failed, using SQLite only:', err.message);
});

// NOTE: initCacheTable() is NOT called here anymore
// It will be called by index.js after setDatabase() is called with the shared db instance

// Auto-cleanup every hour
setInterval(() => {
  if (db) {
    clearExpiredCache().catch(err => {
      console.error('[Cache] Auto-cleanup failed:', err);
    });
  }
}, 60 * 60 * 1000); // 1 hour

module.exports = {
  setDatabase,
  initCacheTable,
  getCachedData,
  setCachedData,
  clearUserCache,
  clearExpiredCache,
  getCacheStats,
  generateCacheKey,
};
