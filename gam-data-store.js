/**
 * GAM Persistent Data Store v2
 * - Stores daily GAM statistics permanently in SQLite
 * - Smart worker: 1x/hour for today, midnight sync for yesterday
 * - Non-blocking: never interferes with user requests
 * - Lazy loading support: serves stale data while refreshing in background
 */

let db = null;
let gamGetMultiAccountStatistics = null;
let gamCache = null;

const TABLE_NAME = 'gam_daily_data';

// Worker state
let workerRunning = false;
let workerInterval = null;
let userRequestInProgress = false; // Flag to prevent worker during user requests

// ============================================================
// TABLE INITIALIZATION
// ============================================================
function initTable() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        dimension_type TEXT NOT NULL DEFAULT 'AD_UNIT',
        data TEXT NOT NULL,
        account_count INTEGER DEFAULT 0,
        successful_accounts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date, dimension_type)
      );
    `, (err) => {
      if (err) return reject(err);
      db.run(`CREATE INDEX IF NOT EXISTS idx_gam_daily_lookup ON ${TABLE_NAME} (user_id, date, dimension_type);`, () => {
        console.log('[GAM Store] Table initialized');
        resolve();
      });
    });
  });
}

// ============================================================
// DATA ACCESS
// ============================================================

function getDayData(userId, date, dimensionType = 'AD_UNIT') {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT data, updated_at FROM ${TABLE_NAME} WHERE user_id = ? AND date = ? AND dimension_type = ?`,
      [userId, date, dimensionType],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        try {
          resolve({ data: JSON.parse(row.data), updated_at: row.updated_at });
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

function getRangeData(userId, startDate, endDate, dimensionType = 'AD_UNIT') {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT date, data, updated_at FROM ${TABLE_NAME} WHERE user_id = ? AND date >= ? AND date <= ? AND dimension_type = ? ORDER BY date`,
      [userId, startDate, endDate, dimensionType],
      (err, rows) => {
        if (err) return reject(err);
        resolve((rows || []).map(r => {
          try {
            return { date: r.date, data: JSON.parse(r.data), updated_at: r.updated_at };
          } catch (e) {
            return null;
          }
        }).filter(Boolean));
      }
    );
  });
}

function saveDayData(userId, date, dimensionType, data) {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(data);
    const accountCount = data.accountCount || 0;
    const successfulAccounts = data.successfulAccounts || 0;

    db.run(
      `INSERT OR REPLACE INTO ${TABLE_NAME} (user_id, date, dimension_type, data, account_count, successful_accounts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [userId, date, dimensionType, dataStr, accountCount, successfulAccounts],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function getMissingDates(userId, startDate, endDate, dimensionType = 'AD_UNIT') {
  return new Promise((resolve, reject) => {
    const allDates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      allDates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    db.all(
      `SELECT date FROM ${TABLE_NAME} WHERE user_id = ? AND date >= ? AND date <= ? AND dimension_type = ?`,
      [userId, startDate, endDate, dimensionType],
      (err, rows) => {
        if (err) return reject(err);
        const existingDates = new Set((rows || []).map(r => r.date));
        const missing = allDates.filter(d => !existingDates.has(d));
        resolve(missing);
      }
    );
  });
}

// Get metadata about stored data (for lazy loading info)
function getDataInfo(userId, date, dimensionType = 'AD_UNIT') {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT updated_at, account_count, successful_accounts FROM ${TABLE_NAME} WHERE user_id = ? AND date = ? AND dimension_type = ?`,
      [userId, date, dimensionType],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({
          updated_at: row.updated_at,
          account_count: row.account_count,
          successful_accounts: row.successful_accounts,
          age_minutes: Math.floor((Date.now() - new Date(row.updated_at + 'Z').getTime()) / 60000),
        });
      }
    );
  });
}

// ============================================================
// DATA AGGREGATION
// ============================================================

function aggregateDays(daysData) {
  if (daysData.length === 0) return null;
  if (daysData.length === 1) return daysData[0].data;

  const domainMap = {};
  let allAccounts = [];
  let accountCount = 0;
  let successfulAccounts = 0;
  let failedAccounts = 0;

  for (const dayEntry of daysData) {
    const day = dayEntry.data;
    if (!day || !day.data) continue;

    accountCount = Math.max(accountCount, day.accountCount || 0);
    successfulAccounts = Math.max(successfulAccounts, day.successfulAccounts || 0);
    failedAccounts = Math.max(failedAccounts, day.failedAccounts || 0);
    if (day.accounts && day.accounts.length > allAccounts.length) {
      allAccounts = day.accounts;
    }

    for (const record of day.data) {
      const key = record.domain || record.adUnitName || 'unknown';
      if (!domainMap[key]) {
        domainMap[key] = {
          date: record.date,
          impressions: 0, clicks: 0, revenue: 0,
          unfilled: 0, unfilled_impressions: 0,
          adUnitName: record.adUnitName || '',
          domain: record.domain || key,
          original_currency: record.original_currency || 'USD',
          accounts: record.accounts || [],
          currencies: record.currencies || [],
          ctr: 0, ecpm: 0,
        };
      }

      const d = domainMap[key];
      d.impressions += record.impressions || 0;
      d.clicks += record.clicks || 0;
      d.revenue += record.revenue || 0;
      d.unfilled += record.unfilled || 0;
      d.unfilled_impressions += record.unfilled_impressions || 0;

      if (record.accounts) {
        for (const acc of record.accounts) {
          if (!d.accounts.includes(acc)) d.accounts.push(acc);
        }
      }
      if (record.currencies) {
        for (const cur of record.currencies) {
          if (!d.currencies.includes(cur)) d.currencies.push(cur);
        }
      }
    }
  }

  const data = Object.values(domainMap).map(d => {
    d.ctr = d.impressions > 0 ? parseFloat(((d.clicks / d.impressions) * 100).toFixed(2)) : 0;
    d.ecpm = d.impressions > 0 ? parseFloat(((d.revenue / d.impressions) * 1000).toFixed(2)) : 0;
    return d;
  });

  const totals = {
    impressions: 0, clicks: 0, revenue: 0,
    unfilled_impressions: 0, ctr: 0, ecpm: 0,
    requests_served: 0, pmr: 0, active_view: 0,
  };

  for (const d of data) {
    totals.impressions += d.impressions;
    totals.clicks += d.clicks;
    totals.revenue += d.revenue;
    totals.unfilled_impressions += d.unfilled_impressions;
  }

  totals.requests_served = totals.impressions + totals.unfilled_impressions;
  totals.ctr = totals.impressions > 0 ? parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0;
  totals.ecpm = totals.impressions > 0 ? parseFloat(((totals.revenue / totals.impressions) * 1000).toFixed(2)) : 0;
  totals.pmr = totals.requests_served > 0 ? parseFloat(((totals.impressions / totals.requests_served) * 100).toFixed(2)) : 0;
  totals.active_view = totals.pmr;

  const floatingNumbers = {};
  for (const d of data) {
    floatingNumbers[d.domain] = parseFloat(d.revenue.toFixed(2));
  }
  floatingNumbers.impressions = totals.impressions;
  floatingNumbers.clicks = totals.clicks;
  floatingNumbers.revenue = parseFloat(totals.revenue.toFixed(2));
  floatingNumbers.ctr = totals.ctr;
  floatingNumbers.ecpm = totals.ecpm;
  floatingNumbers.pmr = totals.pmr;
  floatingNumbers.active_view = totals.active_view;
  floatingNumbers.requests_served = totals.requests_served;
  floatingNumbers.unfilled_impressions = totals.unfilled_impressions;

  return {
    success: true,
    data,
    totals,
    FloatingNumbers: floatingNumbers,
    accountCount,
    successfulAccounts,
    failedAccounts,
    accounts: allAccounts,
  };
}

// ============================================================
// GET DATA FOR ENDPOINT (with lazy loading metadata)
// ============================================================

async function getDataForRange(userId, startDate, endDate, dimensionType = 'AD_UNIT') {
  const today = new Date().toISOString().split('T')[0];

  // Single day - fast path
  if (startDate === endDate) {
    const dayResult = await getDayData(userId, startDate, dimensionType);
    if (dayResult) {
      const ageMinutes = Math.floor((Date.now() - new Date(dayResult.updated_at + 'Z').getTime()) / 60000);
      const isStale = (startDate === today && ageMinutes > 20); // Today's data older than 20 min is stale
      console.log(`[GAM Store] HIT: ${startDate} (updated ${dayResult.updated_at}, age: ${ageMinutes}min, stale: ${isStale})`);
      return {
        ...dayResult.data,
        _data_info: {
          updated_at: dayResult.updated_at,
          age_minutes: ageMinutes,
          is_stale: isStale,
          from_store: true,
        }
      };
    }
    return null;
  }

  // Multi-day range
  const daysData = await getRangeData(userId, startDate, endDate, dimensionType);

  const allDates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    allDates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  const existingDates = new Set(daysData.map(d => d.date));
  const missingDates = allDates.filter(d => !existingDates.has(d));

  if (missingDates.length > 0) {
    console.log(`[GAM Store] PARTIAL: have ${daysData.length}/${allDates.length} days, missing: ${missingDates.join(', ')}`);
    return null;
  }

  console.log(`[GAM Store] HIT: ${startDate} to ${endDate} (${daysData.length} days aggregated)`);
  const aggregated = aggregateDays(daysData);
  if (aggregated) {
    // Find oldest update in the range
    const oldestUpdate = daysData.reduce((oldest, d) => {
      return d.updated_at < oldest ? d.updated_at : oldest;
    }, daysData[0].updated_at);
    const ageMinutes = Math.floor((Date.now() - new Date(oldestUpdate + 'Z').getTime()) / 60000);

    aggregated._data_info = {
      updated_at: oldestUpdate,
      age_minutes: ageMinutes,
      is_stale: allDates.includes(today) && ageMinutes > 20,
      from_store: true,
      days_count: daysData.length,
    };
  }
  return aggregated;
}

// ============================================================
// SMART WORKER (non-blocking, 1x/hour)
// ============================================================

async function fetchAndStoreDay(userId, date, dimensionType = 'AD_UNIT') {
  // Don't run if a user request is in progress
  if (userRequestInProgress) {
    console.log(`[GAM Worker] Skipping ${date} - user request in progress`);
    return null;
  }

  console.log(`[GAM Worker] Fetching ${date}...`);

  const fakeReq = {
    query: { startDate: date, endDate: date, dimensionType },
    user: { id: userId }
  };

  const result = await new Promise((resolve, reject) => {
    gamGetMultiAccountStatistics(fakeReq, {
      json: (data) => resolve(data),
      status: (code) => ({
        json: (data) => code >= 400 ? reject(new Error(data.error || 'API Error')) : resolve(data)
      })
    }, db);
  });

  await saveDayData(userId, date, dimensionType, result);

  // Also save to Redis for fast access
  if (gamCache) {
    try {
      await gamCache.setCachedData(userId, date, date, dimensionType, result, 300);
    } catch (e) {
      // Ignore Redis errors
    }
  }

  console.log(`[GAM Worker] Stored ${date}: ${result.data ? result.data.length : 0} domains, ${result.successfulAccounts || 0} accounts`);
  return result;
}

async function runSmartWorker() {
  if (workerRunning) {
    console.log('[GAM Worker] Already running, skipping');
    return;
  }

  // Don't run if user request is happening
  if (userRequestInProgress) {
    console.log('[GAM Worker] User request in progress, postponing...');
    return;
  }

  workerRunning = true;

  try {
    // Get admin user
    const users = await new Promise((resolve, reject) => {
      db.all("SELECT id FROM users WHERE role = 'admin' LIMIT 1", [], (err, rows) => {
        err ? reject(err) : resolve(rows || []);
      });
    });

    if (users.length === 0) {
      console.log('[GAM Worker] No admin users found');
      return;
    }

    const userId = users[0].id;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getUTCHours();
    const dimensionType = 'AD_UNIT';

    // === SMART SYNC LOGIC ===

    // 1. Always refresh today
    console.log(`[GAM Worker] Refreshing today (${today})...`);
    await fetchAndStoreDay(userId, today, dimensionType);

    // 2. Between 3-6 AM UTC (0-3 AM Brasília): refresh yesterday (final data after day closes)
    // This ensures we get complete data after the Brazil timezone day ends at 3 AM UTC
    if (hour >= 3 && hour <= 6) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const yesterdayInfo = await getDataInfo(userId, yesterdayStr, dimensionType);

      // Refresh yesterday if: missing, incomplete accounts, or last update was before midnight
      const shouldRefreshYesterday = !yesterdayInfo ||
        yesterdayInfo.successful_accounts < yesterdayInfo.account_count ||
        yesterdayInfo.age_minutes > 360; // Older than 6 hours

      if (shouldRefreshYesterday) {
        console.log(`[GAM Worker] Midnight sync: refreshing yesterday (${yesterdayStr})...`);
        // Wait 15s to avoid rate limiting
        await new Promise(r => setTimeout(r, 15000));
        if (!userRequestInProgress) {
          await fetchAndStoreDay(userId, yesterdayStr, dimensionType);
        }
      } else {
        console.log(`[GAM Worker] Yesterday (${yesterdayStr}) is complete, skipping`);
      }
    }

    console.log(`[GAM Worker] Done. Next run in 15 min.`);

  } catch (err) {
    console.error('[GAM Worker] Error:', err.message);
  } finally {
    workerRunning = false;
  }
}

// Manual refresh triggered by user (via API endpoint)
async function manualRefresh(userId, date, dimensionType = 'AD_UNIT') {
  if (workerRunning) {
    return { success: false, error: 'Worker is already running. Please wait.' };
  }

  workerRunning = true;
  userRequestInProgress = true;

  try {
    console.log(`[GAM Manual] Refreshing ${date} for user ${userId}...`);
    const result = await fetchAndStoreDay(userId, date, dimensionType);
    return {
      success: true,
      domains: result.data ? result.data.length : 0,
      accounts: result.successfulAccounts || 0,
      total_accounts: result.accountCount || 0,
    };
  } catch (err) {
    console.error('[GAM Manual] Error:', err.message);
    return { success: false, error: err.message };
  } finally {
    workerRunning = false;
    userRequestInProgress = false;
  }
}

// Flag for user requests (to prevent worker interference)
function setUserRequestActive(active) {
  userRequestInProgress = active;
}

// ============================================================
// INITIALIZATION
// ============================================================

async function init(dbInstance, gamMultiAccountFn, gamCacheInstance) {
  db = dbInstance;
  gamGetMultiAccountStatistics = gamMultiAccountFn;
  gamCache = gamCacheInstance;

  await initTable();

  const count = await new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as cnt FROM ${TABLE_NAME}`, [], (err, row) => {
      err ? reject(err) : resolve(row ? row.cnt : 0);
    });
  });
  console.log(`[GAM Store] ${count} days of data stored`);

  // Start smart worker after 30 seconds (let the server stabilize first)
  setTimeout(() => {
    console.log('[GAM Worker] Starting initial fetch...');
    runSmartWorker();
  }, 30000);

  // Run worker every 15 minutes
  workerInterval = setInterval(() => {
    runSmartWorker();
  }, 15 * 60 * 1000);

  console.log('[GAM Worker] Smart worker scheduled: every 15min, midnight sync enabled');
}

function stop() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

function isWorkerRunning() {
  return workerRunning;
}

module.exports = {
  init,
  stop,
  getDataForRange,
  getDayData,
  saveDayData,
  getMissingDates,
  aggregateDays,
  runSmartWorker,
  manualRefresh,
  setUserRequestActive,
  isWorkerRunning,
  getDataInfo,
};
