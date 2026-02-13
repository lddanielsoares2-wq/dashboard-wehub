const axios = require("axios");
const { cachedRequest, generateCacheKey } = require("./facebook-cache");

/**
 * Google Ad Manager Integration Module
 * Handles OAuth 2.0 authentication and API requests to Google Ad Manager API v1
 */

// API timeout configuration (90 seconds like JoinAds to avoid Cloudflare 524)
const API_REQUEST_TIMEOUT = 90000; // 90 seconds

/**
 * Extract clean domain name from Ad Unit Name
 * Examples:
 *   "Brasilinvest360_WEB_Content1_20251028" -> "brasilinvest360"
 *   "redeamplo.com_Content1" -> "redeamplo.com"
 *   "Copablog_Mobile_Banner" -> "copablog"
 */
function extractDomainFromAdUnit(adUnitName, accountDomain = null) {
  if (!adUnitName) return accountDomain || 'unknown';

  // If ad unit is "Default" or too short, use account domain
  if (accountDomain && (adUnitName.toLowerCase() === 'default' || adUnitName.length < 3)) {
    return accountDomain.toLowerCase().replace(/\.com\.br$|\.com$|\.net\.br$|\.online$|\.info$|\.xyz$/, '');
  }

  // Extract domain before first underscore or space
  const match = adUnitName.match(/^([^_\s]+)/i);
  if (match) {
    let extracted = match[1].toLowerCase();

    // Remove language prefixes (es., pt., en., fr., etc.)
    extracted = extracted.replace(/^[a-z]{2}\./, '');

    // If extracted is "default" or "unknown", use account domain
    if (accountDomain && (extracted === 'default' || extracted === 'unknown')) {
      return accountDomain.toLowerCase().replace(/\.com\.br$|\.com$|\.net\.br$|\.online$|\.info$|\.xyz$/, '');
    }

    return extracted;
  }

  return accountDomain ? accountDomain.toLowerCase().replace(/\.com\.br$|\.com$|\.net\.br$|\.online$|\.info$|\.xyz$/, '') : adUnitName.toLowerCase();
}

 // Exchange rates cache (updated daily)
// Rates represent "1 source currency = X USD"
let exchangeRatesCache = {
  rates: {
    USD: 1,      // 1 USD = 1 USD
    EUR: 1.18,   // 1 EUR ≈ 1.18 USD (Dec 2024)
    GBP: 1.27,   // 1 GBP ≈ 1.27 USD
    BRL: 0.17    // 1 BRL ≈ 0.17 USD
  }, // Fallback rates
  lastUpdated: null // Force refresh on restart
};
/**

 * Get current exchange rates (all to USD)
 * Uses a free API or fallback to hardcoded rates
 */
async function getExchangeRates() {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Use cached rates if less than 24h old
  if (exchangeRatesCache.lastUpdated && (now - exchangeRatesCache.lastUpdated) < oneDayMs) {
    console.log('[GAM] Using cached exchange rates (EUR: ' + exchangeRatesCache.rates.EUR + ')');
    return exchangeRatesCache.rates;
  }

  console.log('[GAM] Fetching fresh exchange rates from API...');

  try {
    // Try to get fresh rates from exchangerate-api.com (free tier: 1500 requests/month)
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', {
      timeout: 5000
    });

    if (response.data && response.data.rates) {
      // API returns rates as "1 USD = X currency"
      // We need rates as "1 currency = X USD" for conversion
      const eurFromAPI = response.data.rates.EUR;
      const eurToUSD = 1 / eurFromAPI;

      console.log(`[GAM] API returned: 1 USD = ${eurFromAPI} EUR`);
      console.log(`[GAM] Converted: 1 EUR = ${eurToUSD.toFixed(4)} USD`);

      exchangeRatesCache.rates = {
        USD: 1,
        EUR: eurToUSD, // 1 EUR = X USD
        GBP: 1 / response.data.rates.GBP, // 1 GBP = X USD
        BRL: 1 / response.data.rates.BRL, // 1 BRL = X USD
      };
      exchangeRatesCache.lastUpdated = now;
      console.log('[GAM] ✅ Exchange rates updated successfully');
    }
  } catch (error) {
    console.warn('[GAM] Failed to fetch exchange rates, using fallback:', error.message);
  }

  console.log('[GAM] Current rates:', exchangeRatesCache.rates);
  return exchangeRatesCache.rates;
}

/**
 * Convert amount from source currency to USD
 */
function convertToUSD(amount, fromCurrency) {
  if (fromCurrency === 'USD') return amount;

  const rates = exchangeRatesCache.rates;
  const rate = rates[fromCurrency];

  if (!rate) {
    console.warn(`[GAM] Unknown currency ${fromCurrency}, treating as USD`);
    return amount;
  }

  // Log conversion for debugging
  if (fromCurrency === 'EUR' && amount > 1000) {
    console.log(`[GAM Convert] ${fromCurrency} ${amount.toFixed(2)} × ${rate} = USD ${(amount * rate).toFixed(2)}`);
  }

  // Rates are stored as "1 source currency = X USD"
  // So we multiply: amount in EUR × rate = amount in USD
  return amount * rate;
}

class GoogleAdManagerClient {
  constructor(networkCode, accessToken, refreshToken, currencyCode = 'USD', timezone = 'America/New_York', domain = null) {
    this.clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    this.refreshToken = refreshToken || process.env.GOOGLE_ADS_REFRESH_TOKEN;
    this.networkCode = networkCode || process.env.GAM_NETWORK_CODE;
    this.accessToken = accessToken;
    this.tokenExpiry = null;
    this.currencyCode = currencyCode;
    this.timezone = timezone;
    this.domain = domain;

    // API Endpoints
    this.tokenEndpoint = "https://oauth2.googleapis.com/token";
    // Using Google Ad Manager Reporting API - correct endpoint
    this.apiBaseUrl = "https://admanager.googleapis.com/v1";
  }

  /**
   * Validate that all required environment variables are set
   */
  validateConfig() {
    const missing = [];
    if (!this.clientId) missing.push("GOOGLE_ADS_CLIENT_ID");
    if (!this.clientSecret) missing.push("GOOGLE_ADS_CLIENT_SECRET");
    if (!this.refreshToken) missing.push("GOOGLE_ADS_REFRESH_TOKEN");
    if (!this.networkCode) missing.push("GAM_NETWORK_CODE");

    if (missing.length > 0) {
      throw new Error(
        `Missing required Google Ad Manager environment variables: ${missing.join(", ")}`
      );
    }
  }

  /**
   * Get a fresh access token using the refresh token
   */
  async getAccessToken() {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      console.log("[GAM] Using cached access token");
      return this.accessToken;
    }

    console.log("[GAM] Fetching new access token...");

    try {
      const response = await axios.post(this.tokenEndpoint, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      });

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

      console.log("[GAM] ✅ Access token obtained successfully");
      return this.accessToken;
    } catch (error) {
      console.error("[GAM] ❌ Failed to obtain access token:", error.response?.data || error.message);
      throw new Error("Failed to authenticate with Google Ad Manager");
    }
  }

  /**
   * Step 2: Create a report definition
   */
  async createReport(reportDefinition) {
    const accessToken = await this.getAccessToken();
    const url = `${this.apiBaseUrl}/networks/${this.networkCode}/reports`;

    console.log("[GAM] Step 2: Creating report definition...");

    try {
      const response = await axios.post(url, reportDefinition, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: API_REQUEST_TIMEOUT,
      });

      console.log("[GAM] ✅ Report created:", response.data.reportId);
      return response.data;
    } catch (error) {
      console.error("[GAM] ❌ Failed to create report:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Step 3: Run the report (starts async processing)
   */
  async runReport(reportId) {
    const accessToken = await this.getAccessToken();
    const url = `${this.apiBaseUrl}/networks/${this.networkCode}/reports/${reportId}:run`;

    console.log("[GAM] Step 3: Running report:", reportId);

    try {
      const response = await axios.post(url, {}, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: API_REQUEST_TIMEOUT,
      });

      const operationName = response.data.name;
      console.log("[GAM] ✅ Report running, operation:", operationName);
      return response.data;
    } catch (error) {
      console.error("[GAM] ❌ Failed to run report:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Step 4: Poll operation status until done
   */
  async pollOperation(operationName, maxAttempts = 30) {
    const accessToken = await this.getAccessToken();
    const url = `${this.apiBaseUrl}/${operationName}`;

    console.log("[GAM] Step 4: Polling operation status...");

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: API_REQUEST_TIMEOUT,
        });

        if (response.data.done) {
          console.log("[GAM] ✅ Operation completed!");
          return response.data;
        }

        console.log(`[GAM] ⏳ Waiting... (${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      } catch (error) {
        console.error("[GAM] ❌ Error polling operation:", error.response?.data || error.message);
        throw error;
      }
    }

    throw new Error("Report processing timeout - exceeded maximum polling attempts");
  }

  /**
   * Step 5: Fetch report results
   * @param {string} reportResultPath - Full path like "networks/23323318131/reports/6602155645/results/8666601189"
   */
  async fetchReportResults(reportResultPath) {
    const accessToken = await this.getAccessToken();
    // Use the full path from the response
    const url = `${this.apiBaseUrl}/${reportResultPath}:fetchRows`;

    console.log("[GAM] Step 5: Fetching report results from:", url);

    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: API_REQUEST_TIMEOUT,
      });

      console.log("[GAM] ✅ Report results fetched:", response.data.rows?.length || 0, "rows");
      return response.data;
    } catch (error) {
      console.error("[GAM] ❌ Failed to fetch results:", error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get statistics from Google Ad Manager
   * Implements the full async workflow: CREATE → RUN → POLL → FETCH
   * @param {Object} params - Query parameters
   * @param {string} params.startDate - Start date in YYYY-MM-DD format
   * @param {string} params.endDate - End date in YYYY-MM-DD format
   * @param {string} params.dimensionType - Dimension type: DATE, AD_UNIT, ORDER, LINE_ITEM
   */
  async getStatistics(params = {}) {
    const { startDate, endDate, dimensionType = "DATE" } = params;

    // Default to today if not specified
    const today = new Date().toISOString().split("T")[0];
    const end = endDate || today;
    const start = startDate || today;

    console.log(`[GAM] Starting report workflow from ${start} to ${end} with dimension ${dimensionType}`);

    try {
      // Use FixedDateRange for custom dates
      // Google Ad Manager API v1 uses "fixed" field for FixedDateRange
      // Reference: https://cloud.google.com/php/docs/reference/googleads/ad-manager/latest/V1.Report.DateRange.FixedDateRange
      const dateRange = {
        fixed: {
          startDate: this.formatDateForAPI(start),
          endDate: this.formatDateForAPI(end)
        }
      };

      console.log("[GAM] Using FIXED date range:", JSON.stringify(dateRange, null, 2));

      // Step 1: Build report using correct REST API v1 Beta structure
      const reportBody = {
        reportDefinition: {
          dimensions: this.getDimensions(dimensionType),
          metrics: [
            "IMPRESSIONS",
            "CLICKS",
            "REVENUE",
            "AVERAGE_ECPM",
            "CTR",
            "UNFILLED_IMPRESSIONS"
          ],
          dateRange,
          reportType: 'HISTORICAL',
          currencyCode: this.currencyCode
          // Note: timezone is set at network level, not in report definition
        }
      };

      console.log("[GAM] Creating report from", start, "to", end);
      console.log("[GAM] Report body:", JSON.stringify(reportBody, null, 2));

      // Step 2: Create report
      const report = await this.createReport(reportBody);
      const reportId = report.reportId;

      // Step 3: Run report
      const operation = await this.runReport(reportId);
      const operationName = operation.name;

      // Step 4: Poll until done
      const completedOperation = await this.pollOperation(operationName);

      // Extract reportResult path from response
      // The response contains the full path like: "networks/23323318131/reports/6602155645/results/8666601189"
      const reportResultPath = completedOperation.response.reportResult;
      console.log("[GAM] Report result path:", reportResultPath);

      // Step 5: Fetch results using the full path
      const results = await this.fetchReportResults(reportResultPath);

      // Transform the API response to match our internal format
      const transformedData = this.transformReportData(results, dimensionType);

      return {
        success: true,
        data: transformedData,
      };
    } catch (error) {
      console.error("[GAM] Error in report workflow:", error.message);

      // If it's a 429 error, throw it so retry logic can catch it
      const is429 = error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED');
      if (is429) {
        console.error("[GAM] 429 Rate limit detected - throwing error for retry");
        throw error; // Let retry logic handle this
      }

      // For other errors, return success=false
      return {
        success: false,
        data: [],
        error: error.message,
      };
    }
  }

  /**
   * Get dimensions array based on dimension type
   */
  getDimensions(dimensionType) {
    switch (dimensionType) {
      case "AD_UNIT":
        return ["AD_UNIT_NAME"];
      case "ORDER":
        return ["ORDER_NAME"];
      case "LINE_ITEM":
        return ["LINE_ITEM_NAME"];
      case "DATE":
      default:
        return ["DATE"];
    }
  }


  /**
   * Format date for Google Ad Manager API (Google.Type.Date format)
   * Input: "YYYY-MM-DD" string
   * Output: { year: number, month: number, day: number }
   */
  formatDateForAPI(dateString) {
    // Parse date string directly to avoid timezone issues
    const [year, month, day] = dateString.split('-').map(Number);

    return {
      year: year,
      month: month, // Month is 1-indexed in Google API (1 = January)
      day: day
    };
  }

  /**
   * Transform Google Ad Manager API response to our internal format
   * Handles the new API response structure with dimensionValues and metricValueGroups
   */
  transformReportData(reportResult, dimensionType) {
    if (!reportResult.rows || reportResult.rows.length === 0) {
      console.log("[GAM] No data returned from report");
      return [];
    }

    // Debug: log first row structure
    if (reportResult.rows.length > 0) {
      console.log("[GAM] Sample row structure:", JSON.stringify(reportResult.rows[0], null, 2));
    }

    return reportResult.rows.map((row, index) => {
      // Extract dimension values (AD_UNIT_NAME, ORDER_NAME, etc.)
      const dimensionValues = row.dimensionValues || [];
      // Dimension can be stringValue (for names) or intValue (for dates like 20251210)
      const dimensionValue = dimensionValues[0]?.stringValue || dimensionValues[0]?.intValue?.toString() || "";

      // Extract metric values
      const metricValues = row.metricValueGroups?.[0]?.primaryValues || [];

      // Debug: log metric values for first row
      if (index === 0) {
        console.log("[GAM] Metric values:", metricValues.map((v, i) => ({ index: i, value: v })));
      }

      // Metrics are in order: IMPRESSIONS, CLICKS, REVENUE, AVERAGE_ECPM, CTR, UNFILLED_IMPRESSIONS
      // Note: API returns intValue (not int64Value) and doubleValue
      // REVENUE and ECPM come in the account's currency (EUR, GBP, BRL, USD)
      const impressions = parseInt(metricValues[0]?.intValue || metricValues[0]?.int64Value || "0");
      const clicks = parseInt(metricValues[1]?.intValue || metricValues[1]?.int64Value || "0");
      const revenue = parseFloat(metricValues[2]?.doubleValue || "0"); // In account currency
      const ecpm = parseFloat(metricValues[3]?.doubleValue || "0"); // In account currency
      const ctr = parseFloat(metricValues[4]?.doubleValue || "0");
      const unfilled = parseInt(metricValues[5]?.intValue || metricValues[5]?.int64Value || "0");

      // Debug: log revenue for first row to verify currency
      if (index === 0) {
        console.log(`[GAM] Revenue in ${this.currencyCode}:`, revenue);
      }

      const baseData = {
        date: new Date().toISOString(), // Will be set properly based on dimension
        impressions,
        clicks,
        ctr: ctr * 100, // Convert to percentage
        revenue,
        ecpm,
        unfilled,
      };

      // Add dimension-specific fields
      switch (dimensionType) {
        case "AD_UNIT":
          return {
            ...baseData,
            adUnitName: dimensionValue,
            domain: extractDomainFromAdUnit(dimensionValue, this.domain), // Extract clean domain with account fallback
            unfilled_impressions: unfilled, // Add alias for consistency
          };
        case "ORDER":
          return {
            ...baseData,
            orderName: dimensionValue,
          };
        case "LINE_ITEM":
          return {
            ...baseData,
            lineItemName: dimensionValue,
          };
        case "DATE":
          return {
            ...baseData,
            date: this.parseDateValue(dimensionValue),
          };
        default:
          return baseData;
      }
    });
  }

  /**
   * Parse date value from API response
   */
  parseDateValue(dateValue) {
    if (!dateValue) return new Date().toISOString();

    // Date format from API is typically YYYYMMDD
    if (dateValue.length === 8) {
      const year = dateValue.substring(0, 4);
      const month = dateValue.substring(4, 6);
      const day = dateValue.substring(6, 8);
      return `${year}-${month}-${day}T00:00:00.000Z`;
    }

    return dateValue;
  }

  /**
   * Test connection to Google Ad Manager
   */
  async testConnection() {
    try {
      this.validateConfig();
      const accessToken = await this.getAccessToken();

      return {
        connected: true,
        networkCode: this.networkCode,
        message: "Successfully connected to Google Ad Manager",
      };
    } catch (error) {
      return {
        connected: false,
        error: error.message,
      };
    }
  }
}

// Create singleton instance
const gamClient = new GoogleAdManagerClient();

/**
 * Express route handlers
 */

/**
 * GET /api/googleadmanager/statistics
 * Get statistics from Google Ad Manager with caching
 */
async function getStatistics(req, res) {
  try {
    console.log("[GAM] Request params:", req.query);

    const { startDate, endDate, dimensionType = "DATE", days } = req.query;

    // Calculate dates if days parameter is provided
    let start = startDate;
    let end = endDate;

    if (days && !startDate && !endDate) {
      end = new Date().toISOString().split("T")[0];
      start = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
    }

    // Cache key based on request parameters
    const cacheKey = generateCacheKey("gam_stats", {
      startDate: start,
      endDate: end,
      dimensionType,
      user_id: req.user?.id || "anonymous",
    });

    console.log("[GAM] Cache key:", cacheKey);

    // Use short cache (5 minutes) for GAM statistics to ensure fresher data
    const result = await cachedRequest("short", cacheKey, async () => {
      console.log("[GAM] ❌ Cache MISS - Calling Google Ad Manager API...");

      const stats = await gamClient.getStatistics({
        startDate: start,
        endDate: end,
        dimensionType,
      });

      return { data: stats };
    });

    console.log(
      "[GAM] ✅ Response sent (cached:",
      result._cached || false,
      ")"
    );

    return res.json({
      ...result.data,
      _cache_info: {
        cached: result._cached || false,
        cache_type: result._cacheType || "none",
        cache_timestamp: result._cacheTimestamp || null,
      },
    });
  } catch (err) {
    console.error("[GAM] Error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
      data: [],
    });
  }
}

/**
 * GET /api/googleadmanager/status
 * Test connection to Google Ad Manager
 */
async function getConnectionStatus(req, res) {
  try {
    const status = await gamClient.testConnection();
    return res.json(status);
  } catch (err) {
    console.error("[GAM] Connection test error:", err.message);
    return res.status(500).json({
      connected: false,
      error: err.message,
    });
  }
}

/**
 * Refresh access token for a specific account
 */
async function refreshAccountToken(account) {
  try {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: account.refresh_token,
      grant_type: 'refresh_token'
    }, {
      timeout: 15000 // 15 seconds for OAuth refresh
    });

    const { access_token, expires_in } = response.data;
    const tokenExpiry = Date.now() + (expires_in * 1000);

    return {
      access_token,
      token_expiry: tokenExpiry
    };
  } catch (error) {
    console.error(`[GAM Multi] Failed to refresh token for account ${account.id}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get valid access token for account (refresh if needed)
 */
async function getValidAccessToken(account, db) {
  // Check if token is still valid (with 5 min buffer)
  if (account.access_token && account.token_expiry && Date.now() < (account.token_expiry - 300000)) {
    return account.access_token;
  }

  // Refresh token
  console.log(`[GAM Multi] Refreshing token for account ${account.id}`);
  const { access_token, token_expiry } = await refreshAccountToken(account);

  // Update in database
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE google_ad_manager_accounts SET access_token = ?, token_expiry = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [access_token, token_expiry, account.id],
      (err) => err ? reject(err) : resolve()
    );
  });

  return access_token;
}

/**
 * Get statistics from a single account with retry logic for 429 errors
 */
async function getAccountStatistics(account, params, db) {
  const { startDate, endDate, dimensionType } = params;

  console.log(`[GAM Multi] 📊 Fetching stats for: ${account.account_name} (${account.network_code})`);

  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const accessToken = await getValidAccessToken(account, db);

      // Create client instance with account's currency and timezone
      const accountClient = new GoogleAdManagerClient(
        account.network_code,
        accessToken,
        account.refresh_token,
        account.currency_code || 'USD',
        account.timezone || 'America/New_York',
        account.domain || null
      );
      accountClient.tokenExpiry = account.token_expiry;

      const stats = await accountClient.getStatistics({
        startDate,
        endDate,
        dimensionType
      });

      // Success - return immediately
      if (stats.success) {
        console.log(`[GAM Multi] ✅ ${account.account_name}: ${stats.data?.length || 0} records (attempt ${attempt})`);

        return {
          accountId: account.id,
          accountName: account.account_name,
          networkCode: account.network_code,
          currencyCode: account.currency_code || 'USD',
          timezone: account.timezone || 'America/New_York',
          success: stats.success,
          data: stats.data || []
        };
      }

      lastError = stats.error;
      console.warn(`[GAM Multi] ⚠️ ${account.account_name} returned success=false (attempt ${attempt}/${maxRetries}):`, stats.error);

    } catch (error) {
      lastError = error;

      // Check if it's a 429 rate limit error
      const is429 = error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('RESOURCE_EXHAUSTED');

      if (is429 && attempt < maxRetries) {
        // Exponential backoff: 5s, 10s, 20s
        const waitTime = 5000 * Math.pow(2, attempt - 1);
        console.warn(`[GAM Multi] ⏳ Rate limit (429) for ${account.account_name}. Retrying in ${waitTime/1000}s... (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue; // Retry
      }

      // If not 429 or last attempt, break and return error
      console.error(`[GAM Multi] ❌ ${account.account_name} failed (attempt ${attempt}/${maxRetries}):`, error.message);
      break;
    }
  }

  // All retries failed - return error result
  return {
    accountId: account.id,
    accountName: account.account_name,
    networkCode: account.network_code,
    success: false,
    error: lastError?.message || lastError || 'Unknown error after retries',
    data: []
  };
}

/**
 * Aggregate metrics from multiple accounts
 * Converts all revenues to USD before summing
 */
function aggregateMetrics(accountsData, dimensionType) {
  const aggregated = {};
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalRevenue = 0;
  let totalUnfilled = 0;

  accountsData.forEach(accountResult => {
    if (!accountResult.success || !accountResult.data) return;

    // Get currency for this account
    const accountCurrency = accountResult.currencyCode || 'USD';

    accountResult.data.forEach(row => {
      let key;

      // Define key based on dimension type
      switch (dimensionType) {
        case 'AD_UNIT':
          key = `${row.ad_unit_name || row.name || 'Unknown'} (${accountResult.accountName})`;
          break;
        case 'ORDER':
          key = `${row.order_name || row.name || 'Unknown'} (${accountResult.accountName})`;
          break;
        case 'LINE_ITEM':
          key = `${row.line_item_name || row.name || 'Unknown'} (${accountResult.accountName})`;
          break;
        case 'DATE':
        default:
          key = row.date;
          break;
      }

      if (!aggregated[key]) {
        aggregated[key] = {
          ...row,
          impressions: 0,
          clicks: 0,
          revenue: 0, // Revenue in ORIGINAL currency (not converted)
          original_currency: accountCurrency, // Store the currency
          unfilled_impressions: 0,
          accounts: [],
          currencies: [] // Track which currencies contributed
        };
      }

      const revenueOriginal = row.revenue || 0;
      const revenueInUSD = convertToUSD(revenueOriginal, accountCurrency); // Only for totals

      // Debug: Log conversion for Finkerr
      if (accountResult.accountName && accountResult.accountName.includes('Finkerr') && revenueOriginal > 0) {
        console.log(`[GAM] Finkerr revenue: ${accountCurrency} ${revenueOriginal.toFixed(2)} → USD ${revenueInUSD.toFixed(2)}`);
      }

      // Sum metrics (keep revenue in original currency, do NOT convert)
      aggregated[key].impressions += row.impressions || 0;
      aggregated[key].clicks += row.clicks || 0;
      aggregated[key].revenue += revenueOriginal; // Keep in original currency
      aggregated[key].unfilled_impressions += row.unfilled_impressions || 0;
      aggregated[key].accounts.push(accountResult.accountName);

      // Track currency if not already tracked
      if (!aggregated[key].currencies.includes(accountCurrency)) {
        aggregated[key].currencies.push(accountCurrency);
      }

      // Update totals in USD (for aggregating different currencies)
      totalImpressions += row.impressions || 0;
      totalClicks += row.clicks || 0;
      totalRevenue += revenueInUSD; // Convert to USD only for global totals
      totalUnfilled += row.unfilled_impressions || 0;
    });
  });

  // Convert to array and recalculate derived metrics
  const result = Object.entries(aggregated).map(([key, data]) => {
    const ctr = data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0;
    const ecpm = data.impressions > 0 ? (data.revenue / data.impressions) * 1000 : 0;

    const row = {
      ...data,
      ctr: parseFloat(ctr.toFixed(2)),
      ecpm: parseFloat(ecpm.toFixed(2))
    };

    // Debug: Log Finkerr data to verify original_currency
    if (key.toLowerCase().includes('finkerr')) {
      console.log('[GAM DEBUG] Finkerr row has original_currency?', 'original_currency' in row);
      console.log('[GAM DEBUG] Finkerr row.original_currency =', row.original_currency);
    }

    return row;
  });

  // Calculate additional metrics (like JoinAds)
  const totalRequests = totalImpressions + totalUnfilled;
  const pmr = totalRequests > 0 ? (totalImpressions / totalRequests) * 100 : 0; // Programmatic Match Rate
  const activeView = totalImpressions > 0 ? ((totalImpressions - totalUnfilled) / totalImpressions) * 100 : 0;
  const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const ecpm = totalImpressions > 0 ? (totalRevenue / totalImpressions) * 1000 : 0;

  return {
    data: result,
    totals: {
      impressions: totalImpressions,
      clicks: totalClicks,
      revenue: totalRevenue,
      unfilled_impressions: totalUnfilled,
      ctr: parseFloat(ctr.toFixed(2)),
      ecpm: parseFloat(ecpm.toFixed(2)),
      requests_served: totalRequests,
      pmr: parseFloat(pmr.toFixed(2)), // Programmatic Match Rate
      active_view: parseFloat(activeView.toFixed(2)), // Viewability
    },
    // FloatingNumbers - Global metrics like JoinAds
    FloatingNumbers: {
      impressions: totalImpressions,
      clicks: totalClicks,
      revenue: totalRevenue,
      ctr: parseFloat(ctr.toFixed(2)),
      ecpm: parseFloat(ecpm.toFixed(2)),
      pmr: parseFloat(pmr.toFixed(2)),
      active_view: parseFloat(activeView.toFixed(2)),
      requests_served: totalRequests,
      unfilled_impressions: totalUnfilled,
    }
  };
}

/**
 * Get aggregated statistics from all user accounts
 */
async function getMultiAccountStatistics(req, res, db) {
  try {
    const { startDate, endDate, dimensionType = "DATE", days } = req.query;
    const userId = req.user.id;

    // Calculate dates if days parameter is provided
    let start = startDate;
    let end = endDate;

    if (days && !startDate && !endDate) {
      end = new Date().toISOString().split("T")[0];
      start = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
    }

    // Ensure exchange rates are loaded
    await getExchangeRates();

    console.log(`[GAM Multi] Fetching statistics for user ${userId} from ${start} to ${end}`);

    // Get all active accounts for user
    const accounts = await new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM google_ad_manager_accounts WHERE user_id = ? AND is_active = 1',
        [userId],
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });

    if (accounts.length === 0) {
      console.log(`[GAM Multi] No active accounts found for user ${userId}`);
      return res.json({
        success: true,
        data: [],
        message: 'No active Google Ad Manager accounts found',
        accountCount: 0
      });
    }

    console.log(`[GAM Multi] Found ${accounts.length} active account(s)`);

    // Process accounts in PARALLEL BATCHES to avoid rate limits
    // Balanced batch size for speed vs rate limit prevention
    const BATCH_SIZE = 3; // 6 accounts per batch = ~60s total for 22 accounts
    const BATCH_DELAY_MS = 6000; // 1 second between batches
    const accountsPromises = [];

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(accounts.length / BATCH_SIZE);

      console.log(`[GAM Multi] Processing batch ${batchNum}/${totalBatches}: ${batch.map(a => a.account_name).join(', ')}`);

      // Process batch in parallel
      const batchPromises = batch.map(account =>
        getAccountStatistics(account, { startDate: start, endDate: end, dimensionType }, db)
          .then(result => ({ status: 'fulfilled', value: result }))
          .catch(error => ({ status: 'rejected', reason: error }))
      );

      const batchResults = await Promise.all(batchPromises);
      accountsPromises.push(...batchResults);

      // Add delay between batches (except for last batch)
      if (i + BATCH_SIZE < accounts.length) {
        console.log(`[GAM Multi] Batch ${batchNum} done. Waiting ${BATCH_DELAY_MS/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    console.log(`[GAM Multi] All batches completed. Processing results...`);

    // Extract successful results (fulfilled promises where account.success is true)
    const accountsData = accountsPromises
      .filter(result => result.status === 'fulfilled' && result.value?.success === true)
      .map(result => result.value);

    // Log failures (rejected promises + fulfilled but with success=false)
    const failedAccounts = [];

    accountsPromises.forEach((result, index) => {
      if (result.status === 'rejected') {
        failedAccounts.push({
          account: accounts[index].account_name,
          error: result.reason?.message || 'Unknown error'
        });
      } else if (result.status === 'fulfilled' && result.value?.success === false) {
        failedAccounts.push({
          account: accounts[index].account_name,
          error: result.value?.error || 'Unknown error (success=false)'
        });
      }
    });

    if (failedAccounts.length > 0) {
      console.error(`[GAM Multi] ${failedAccounts.length} account(s) failed:`, failedAccounts);
    }

    console.log(`[GAM Multi] Successfully fetched data from ${accountsData.length}/${accounts.length} accounts`);

    // Log individual account results
    accountsData.forEach(accountResult => {
      const dataCount = accountResult.data?.length || 0;
      console.log(`[GAM Multi] ✅ ${accountResult.accountName}: ${dataCount} records`);
    });

    if (failedAccounts.length > 0) {
      failedAccounts.forEach(failed => {
        console.log(`[GAM Multi] ❌ ${failed.account}: ${failed.error}`);
      });
    }

    // Aggregate results
    const aggregatedResults = aggregateMetrics(accountsData, dimensionType);

    // DEBUG: Log what aggregateMetrics returns
    console.log('[GAM Multi] aggregatedResults keys:', Object.keys(aggregatedResults));
    console.log('[GAM Multi] totals keys:', Object.keys(aggregatedResults.totals || {}));
    console.log('[GAM Multi] Has FloatingNumbers?', 'FloatingNumbers' in aggregatedResults);
    console.log('[GAM Multi] Total domains (including zeros):', aggregatedResults.data.length);

    return res.json({
      success: true,
      ...aggregatedResults,
      accountCount: accounts.length,
      successfulAccounts: accountsData.length,
      failedAccounts: failedAccounts.length,
      accounts: accountsData.map(a => ({
        id: a.accountId,
        name: a.accountName,
        success: a.success,
        dataCount: a.data?.length || 0
      })),
      errors: failedAccounts.length > 0 ? failedAccounts : undefined
    });

  } catch (error) {
    console.error('[GAM Multi] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
}

/**
 * DELETE /api/googleadmanager/cache
 * Clear Google Ad Manager cache
 */
async function clearGAMCache(req, res) {
  try {
    const { clearCache } = require('./facebook-cache');

    // Clear all GAM-related cache in short tier (since we use 5min cache now)
    const result = clearCache('short', 'gam_');

    console.log(`[GAM Cache] Cleared ${result.total} cache entries`);

    return res.json({
      success: true,
      message: `Cache cleared successfully (${result.total} entries)`,
      cleared: result
    });
  } catch (error) {
    console.error('[GAM Cache] Error clearing cache:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

module.exports = {
  GoogleAdManagerClient,
  gamClient,
  getStatistics,
  getConnectionStatus,
  getMultiAccountStatistics,
  refreshAccountToken,
  getValidAccessToken,
  clearGAMCache
};
