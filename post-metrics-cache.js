/**
 * Post Metrics Cache - Sistema SEPARADO do GAM Cache
 * Armazena métricas de posts individuais em SQLite + Memory
 *
 * NÃO MODIFICA redis-cache.js - usa storage próprio
 */

// Cache em memória para respostas rápidas
const memoryCache = new Map();
const MEMORY_TTL = 5 * 60 * 1000; // 5 minutos em memória

/**
 * Gerar chave de cache
 */
function getCacheKey(userId, startDate, endDate, type = 'individual') {
  return `post_metrics:${userId}:${type}:${startDate}:${endDate}`;
}

/**
 * Obter do cache em memória
 */
function getFromMemory(key) {
  const cached = memoryCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`[PostMetricsCache] Memory HIT: ${key}`);
    return cached.data;
  }
  if (cached) {
    memoryCache.delete(key);
  }
  return null;
}

/**
 * Salvar no cache em memória
 */
function saveToMemory(key, data, ttlMs = MEMORY_TTL) {
  memoryCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs,
  });
  console.log(`[PostMetricsCache] Memory SAVE: ${key}`);
}

/**
 * Limpar cache em memória
 */
function clearMemoryCache() {
  const size = memoryCache.size;
  memoryCache.clear();
  console.log(`[PostMetricsCache] Memory cache cleared (${size} entries)`);
  return size;
}

/**
 * Classe para gerenciar cache SQLite de post metrics
 */
class PostMetricsCacheManager {
  constructor(db) {
    this.db = db;
    this.tableName = 'post_metrics_cache';
    this.TTL_MINUTES = 30; // Cache por 30 minutos
  }

  /**
   * Inicializar tabela de cache (se não existir)
   */
  async initTable() {
    return new Promise((resolve, reject) => {
      const sql = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          cache_key TEXT NOT NULL,
          post_id TEXT,
          post_url TEXT,
          post_slug TEXT,
          category TEXT,
          domain TEXT,
          impressions INTEGER DEFAULT 0,
          clicks INTEGER DEFAULT 0,
          revenue REAL DEFAULT 0,
          ecpm REAL DEFAULT 0,
          ctr REAL DEFAULT 0,
          viewability REAL DEFAULT 0,
          viewable_impressions INTEGER DEFAULT 0,
          measurable_impressions INTEGER DEFAULT 0,
          accounts TEXT,
          start_date TEXT,
          end_date TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP,
          UNIQUE(user_id, cache_key, post_id, domain)
        )
      `;

      this.db.run(sql, (err) => {
        if (err) {
          console.error('[PostMetricsCache] Error creating table:', err);
          reject(err);
        } else {
          console.log('[PostMetricsCache] Table initialized');

          // Criar índices para performance
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_post_metrics_user ON ${this.tableName}(user_id)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_post_metrics_key ON ${this.tableName}(cache_key)`);
          this.db.run(`CREATE INDEX IF NOT EXISTS idx_post_metrics_expires ON ${this.tableName}(expires_at)`);

          resolve();
        }
      });
    });
  }

  /**
   * Obter métricas do cache SQLite
   */
  async get(userId, startDate, endDate, type = 'individual') {
    const cacheKey = getCacheKey(userId, startDate, endDate, type);

    // Primeiro tenta memória com chave exata
    const memCached = getFromMemory(cacheKey);
    if (memCached) {
      return memCached;
    }

    // Tenta SQLite com chave exata primeiro
    const exactMatch = await this.getExact(userId, cacheKey);
    if (exactMatch && exactMatch.length > 0) {
      return exactMatch;
    }

    // Se não encontrou exato, busca QUALQUER cache válido do usuário
    // O cron salva últimos 30 dias, então retorna isso se disponível
    console.log(`[PostMetricsCache] No exact match, trying any valid cache for user ${userId}`);
    return this.getLatestAvailable(userId, type);
  }

  /**
   * Busca exata por cache_key
   */
  async getExact(userId, cacheKey) {
    return new Promise((resolve) => {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE user_id = ?
        AND cache_key = ?
        AND expires_at > datetime('now')
        ORDER BY impressions DESC
      `;

      this.db.all(sql, [userId, cacheKey], (err, rows) => {
        if (err || !rows || rows.length === 0) {
          return resolve(null);
        }
        console.log(`[PostMetricsCache] SQLite EXACT HIT: ${cacheKey} (${rows.length} posts)`);
        const data = this.transformRows(rows);
        saveToMemory(cacheKey, data);
        resolve(data);
      });
    });
  }

  /**
   * Busca o cache mais recente disponível para o usuário
   */
  async getLatestAvailable(userId, type = 'individual') {
    return new Promise((resolve) => {
      const sql = `
        SELECT * FROM ${this.tableName}
        WHERE user_id = ?
        AND cache_key LIKE ?
        AND expires_at > datetime('now')
        ORDER BY created_at DESC, impressions DESC
      `;

      const keyPattern = `post_metrics:${userId}:${type}:%`;

      this.db.all(sql, [userId, keyPattern], (err, rows) => {
        if (err || !rows || rows.length === 0) {
          console.log(`[PostMetricsCache] No valid cache found for user ${userId}`);
          return resolve(null);
        }
        console.log(`[PostMetricsCache] Found ${rows.length} cached posts for user ${userId} (latest available)`);
        resolve(this.transformRows(rows));
      });
    });
  }

  /**
   * Transforma rows do SQLite para formato de objeto
   */
  transformRows(rows) {
    return rows.map(row => ({
      postId: row.post_id,
      postUrl: row.post_url,
      postSlug: row.post_slug,
      category: row.category,
      domain: row.domain,
      impressions: row.impressions,
      clicks: row.clicks,
      revenue: row.revenue,
      ecpm: row.ecpm,
      ctr: row.ctr,
      viewability: row.viewability,
      viewableImpressions: row.viewable_impressions,
      measurableImpressions: row.measurable_impressions,
      accounts: row.accounts ? JSON.parse(row.accounts) : [],
    }));
  }

  /**
   * Salvar métricas no cache SQLite
   */
  async set(userId, startDate, endDate, posts, type = 'individual') {
    const cacheKey = getCacheKey(userId, startDate, endDate, type);
    const expiresAt = new Date(Date.now() + this.TTL_MINUTES * 60 * 1000).toISOString();

    // Salvar em memória primeiro
    saveToMemory(cacheKey, posts);

    return new Promise((resolve, reject) => {
      // Primeiro limpa cache antigo para essa chave
      this.db.run(
        `DELETE FROM ${this.tableName} WHERE user_id = ? AND cache_key = ?`,
        [userId, cacheKey],
        (err) => {
          if (err) {
            console.error('[PostMetricsCache] Error clearing old cache:', err);
          }

          if (!posts || posts.length === 0) {
            return resolve();
          }

          // Preparar statement para insert (OR REPLACE para evitar erros de UNIQUE)
          const sql = `
            INSERT OR REPLACE INTO ${this.tableName} (
              user_id, cache_key, post_id, post_url, post_slug, category, domain,
              impressions, clicks, revenue, ecpm, ctr, viewability,
              viewable_impressions, measurable_impressions, accounts,
              start_date, end_date, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          const stmt = this.db.prepare(sql);
          let completed = 0;
          let errors = 0;

          posts.forEach(post => {
            stmt.run([
              userId,
              cacheKey,
              post.postId || '',
              post.postUrl || '',
              post.postSlug || '',
              post.category || '',
              post.domain || '',
              post.impressions || 0,
              post.clicks || 0,
              post.revenue || 0,
              post.ecpm || 0,
              post.ctr || 0,
              post.viewability || 0,
              post.viewableImpressions || 0,
              post.measurableImpressions || 0,
              JSON.stringify(post.accounts || []),
              startDate,
              endDate,
              expiresAt,
            ], (err) => {
              if (err) {
                errors++;
                console.error('[PostMetricsCache] Insert error:', err.message);
              } else {
                completed++;
              }

              if (completed + errors === posts.length) {
                stmt.finalize();
                console.log(`[PostMetricsCache] SQLite SAVE: ${cacheKey} (${completed} posts, ${errors} errors)`);
                resolve();
              }
            });
          });
        }
      );
    });
  }

  /**
   * Limpar cache expirado
   */
  async cleanExpired() {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM ${this.tableName} WHERE expires_at < datetime('now')`,
        function(err) {
          if (err) {
            console.error('[PostMetricsCache] Error cleaning expired:', err);
            return reject(err);
          }
          console.log(`[PostMetricsCache] Cleaned ${this.changes} expired entries`);
          resolve(this.changes);
        }
      );
    });
  }

  /**
   * Limpar todo o cache de um usuário
   */
  async clearUserCache(userId) {
    // Limpar memória
    for (const key of memoryCache.keys()) {
      if (key.startsWith(`post_metrics:${userId}:`)) {
        memoryCache.delete(key);
      }
    }

    // Limpar SQLite
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM ${this.tableName} WHERE user_id = ?`,
        [userId],
        function(err) {
          if (err) {
            console.error('[PostMetricsCache] Error clearing user cache:', err);
            return reject(err);
          }
          console.log(`[PostMetricsCache] Cleared ${this.changes} entries for user ${userId}`);
          resolve(this.changes);
        }
      );
    });
  }

  /**
   * Limpar TODO o cache
   */
  async clearAll() {
    clearMemoryCache();

    return new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM ${this.tableName}`, function(err) {
        if (err) {
          console.error('[PostMetricsCache] Error clearing all cache:', err);
          return reject(err);
        }
        console.log(`[PostMetricsCache] Cleared ALL cache (${this.changes} entries)`);
        resolve(this.changes);
      });
    });
  }

  /**
   * Obter estatísticas do cache
   */
  async getStats() {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT
          COUNT(*) as total_entries,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT cache_key) as unique_keys,
          SUM(CASE WHEN expires_at > datetime('now') THEN 1 ELSE 0 END) as valid_entries,
          SUM(CASE WHEN expires_at <= datetime('now') THEN 1 ELSE 0 END) as expired_entries
        FROM ${this.tableName}
      `;

      this.db.get(sql, (err, row) => {
        if (err) {
          console.error('[PostMetricsCache] Error getting stats:', err);
          return reject(err);
        }

        resolve({
          sqlite: row || {},
          memory: {
            size: memoryCache.size,
            keys: Array.from(memoryCache.keys()),
          },
        });
      });
    });
  }
}

module.exports = {
  PostMetricsCacheManager,
  getFromMemory,
  saveToMemory,
  clearMemoryCache,
  getCacheKey,
};
