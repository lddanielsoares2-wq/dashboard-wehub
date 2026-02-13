const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const dotenv = require("dotenv");
const { join } = require("path");
const fs = require("fs");
const axios = require("axios");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Load environment variables FIRST (before other modules that need env vars)
dotenv.config();

const {
  cachedRequest,
  generateCacheKey,
  clearCache,
  getCacheStats,
} = require("./facebook-cache");

// Import Redis cache for GAM
const gamCache = require("./redis-cache");

// Import Google Ad Manager module (after dotenv.config())
const {
  getStatistics: gamGetStatistics,
  getConnectionStatus: gamGetConnectionStatus,
  getMultiAccountStatistics: gamGetMultiAccountStatistics,
  clearGAMCache,
} = require("./google-ad-manager");

// Import GAM Persistent Data Store
const gamDataStore = require("./gam-data-store");

// Import Post Metrics module (SEPARATE from GAM)
const {
  PostMetricsClient,
  getMultiAccountPostMetrics,
} = require("./post-metrics");

const { PostMetricsCacheManager } = require("./post-metrics-cache");

// Import Analytics Service (proxy to Python service)
const analyticsService = require("./analytics-service");

// Initialize database
const dbPath = join(__dirname, process.env.DATABASE_PATH);
const db = new sqlite3.Database(dbPath);

// Share database instance with gamCache to avoid SQLITE_BUSY errors
// This ensures both index.js and redis-cache.js use the SAME SQLite connection
gamCache.setDatabase(db);
gamCache.initCacheTable().catch(err => {
  console.error('[Cache] Failed to initialize cache table:', err);
});

// Initialize GAM Persistent Data Store (background worker + table)
gamDataStore.init(db, gamGetMultiAccountStatistics, gamCache).catch(err => {
  console.error('[GAM Store] Failed to initialize:', err);
});

const hashData = (data) => {
  return crypto
    .createHash("sha256")
    .update(data.toLowerCase().trim())
    .digest("hex");
};

// Normaliza e aplica hash
function normalizeAndHash(value, type) {
  if (!value) return null;
  value = value.toLowerCase().trim();

  if (type === "ph") {
    value = value.replace(/\D/g, ""); // apenas números
  }

  return hashData(value);
}

// Database helper functions
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Domain accounts helper functions
const DATA_FILE = join(__dirname, "domain-accounts.json");

// API request timeout configuration
// Reduced to 90 seconds to avoid Cloudflare 524 timeout (100s limit on Free plan)
const API_REQUEST_TIMEOUT = 90000; // 90 seconds

// Função para carregar dados do arquivo JSON
function loadDomainAccountsData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("[domain-accounts] Erro ao carregar dados:", error);
  }
  return { domainAdAccounts: {}, domainCosts: {} };
}

// Função para salvar dados no arquivo JSON
function saveDomainAccountsData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (error) {
    console.error("[domain-accounts] Erro ao salvar dados:", error);
    return false;
  }
}

// ===== FACEBOOK GRAPH API UTILITY FUNCTION =====
/**
 * Função utilitária genérica e dinâmica para requisições ao Facebook Graph API
 *
 * @param {string} accountId - ID da conta (pode ser 'me', account ID, business ID, etc.)
 * @param {string} resource - Recurso da API (ex: 'insights', 'campaigns', 'ads', 'adaccounts', etc.)
 * @param {object} params - Parâmetros da requisição (fields, date_preset, time_range, etc.)
 * @param {string} accessToken - Token de acesso do Facebook
 * @returns {Promise<object>} - Resposta da API em formato JSON
 *
 * @example
 * // Buscar gasto de hoje
 * const spendToday = await fbRequest(account.id, 'insights', {
 *   date_preset: 'today',
 *   fields: 'spend'
 * }, accessToken);
 *
 * @example
 * // Buscar impressões e cliques nos últimos 7 dias
 * const metrics = await fbRequest(account.id, 'insights', {
 *   date_preset: 'last_7_days',
 *   fields: 'impressions,clicks,spend,reach'
 * }, accessToken);
 *
 * @example
 * // Buscar campanhas com campos dinâmicos
 * const campaigns = await fbRequest(account.id, 'campaigns', {
 *   fields: 'id,name,status,objective,daily_budget,lifetime_budget'
 * }, accessToken);
 *
 * @example
 * // Buscar contas de anúncios do usuário
 * const adAccounts = await fbRequest('me', 'adaccounts', {
 *   fields: 'id,name,account_status,currency,amount_spent,balance'
 * }, accessToken);
 */
async function fbRequest(accountId, resource, params = {}, accessToken) {
  try {
    // Monta a URL base do Facebook Graph API
    const baseUrl = `https://graph.facebook.com/v18.0/${accountId}/${resource}`;

    // Combina os parâmetros fornecidos com o access_token
    const requestParams = {
      access_token: accessToken,
      ...params,
    };

    console.log(`[fbRequest] Making request to: ${baseUrl}`);
    console.log(`[fbRequest] Params:`, requestParams);

    // Executa a requisição usando axios
    const response = await axios.get(baseUrl, {
      params: requestParams,
    });

    console.log(
      `[fbRequest] Success - Response data length:`,
      JSON.stringify(response.data).length
    );
    return response.data;
  } catch (error) {
    console.error(
      `[fbRequest] Error for ${accountId}/${resource}:`,
      error.response?.data || error.message
    );
    throw error;
  }
}

// Função auxiliar para requisições que não precisam de accountId (ex: /me, /oauth/access_token)
async function fbRequestDirect(endpoint, params = {}, accessToken) {
  try {
    const baseUrl = `https://graph.facebook.com/v18.0/${endpoint}`;

    const requestParams = {
      access_token: accessToken,
      ...params,
    };

    console.log(`[fbRequestDirect] Making request to: ${baseUrl}`);
    console.log(`[fbRequestDirect] Params:`, requestParams);

    const response = await axios.get(baseUrl, {
      params: requestParams,
    });

    console.log(
      `[fbRequestDirect] Success - Response data length:`,
      JSON.stringify(response.data).length
    );
    return response.data;
  } catch (error) {
    console.error(
      `[fbRequestDirect] Error for ${endpoint}:`,
      error.response?.data || error.message
    );
    throw error;
  }
}

/*
 * EXEMPLOS DE USO DAS FUNÇÕES UTILITÁRIAS fbRequest e fbRequestDirect:
 *
 * 1. Buscar gasto de hoje:
 * const spendToday = await fbRequest(accountId, 'insights', {
 *   date_preset: 'today',
 *   fields: 'spend'
 * }, accessToken);
 *
 * 2. Buscar impressões e cliques nos últimos 7 dias:
 * const metricsWeek = await fbRequest(accountId, 'insights', {
 *   date_preset: 'last_7_days',
 *   fields: 'impressions,clicks,ctr'
 * }, accessToken);
 *
 * 3. Buscar campanhas com campos dinâmicos:
 * const campaigns = await fbRequest(accountId, 'campaigns', {
 *   fields: 'id,name,status,objective,daily_budget,lifetime_budget'
 * }, accessToken);
 *
 * 4. Buscar anúncios de uma campanha específica:
 * const ads = await fbRequest(campaignId, 'ads', {
 *   fields: 'id,name,status,creative'
 * }, accessToken);
 *
 * 5. Buscar insights com time_range personalizado:
 * const customInsights = await fbRequest(accountId, 'insights', {
 *   time_range: JSON.stringify({
 *     since: '2024-01-01',
 *     until: '2024-01-31'
 *   }),
 *   fields: 'spend,impressions,clicks,conversions'
 * }, accessToken);
 *
 * 6. Buscar perfil do usuário (usando fbRequestDirect):
 * const userProfile = await fbRequestDirect('me', {
 *   fields: 'id,name,email'
 * }, accessToken);
 *
 * 7. Buscar contas de anúncios do usuário (usando fbRequestDirect):
 * const adAccounts = await fbRequestDirect('me/adaccounts', {
 *   fields: 'id,name,account_status,currency,timezone_name'
 * }, accessToken);
 */

// Create database schema if it doesn't exist
const initDb = async () => {
  try {
    // Users table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        email TEXT,
        facebook_access_token TEXT,
        facebook_user_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add facebook columns to existing users table if they don't exist
    try {
      await dbRun(`ALTER TABLE users ADD COLUMN facebook_access_token TEXT`);
    } catch (e) {
      // Column already exists
    }
    try {
      await dbRun(`ALTER TABLE users ADD COLUMN facebook_user_id TEXT`);
    } catch (e) {
      // Column already exists
    }
    // Add role column for access control (admin = full access, viewer = only metrics)
    try {
      await dbRun(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'`);
    } catch (e) {
      // Column already exists
    }

    // Pixel configurations table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS pixel_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pixel_id TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Event logs table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pixel_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        kwai_click_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        action_params TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Facebook configurations table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS facebook_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pixel_id TEXT NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        test_event_code TEXT,
        app_id TEXT,
        external_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Facebook event logs table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS facebook_event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pixel_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        event_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        response TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Google Ad Manager accounts table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS google_ad_manager_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        account_name TEXT NOT NULL,
        network_code TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT NOT NULL,
        token_expiry INTEGER,
        is_active INTEGER DEFAULT 1,
        currency_code TEXT DEFAULT 'USD',
        timezone TEXT DEFAULT 'America/New_York',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `);

    // Add currency_code and timezone columns if they don't exist (migration)
    try {
      await dbRun(`ALTER TABLE google_ad_manager_accounts ADD COLUMN currency_code TEXT DEFAULT 'USD'`);
    } catch (e) { /* Column already exists */ }

    try {
      await dbRun(`ALTER TABLE google_ad_manager_accounts ADD COLUMN timezone TEXT DEFAULT 'America/New_York'`);
    } catch (e) { /* Column already exists */ }

    // Add domain column for WordPress domain association
    try {
      await dbRun(`ALTER TABLE google_ad_manager_accounts ADD COLUMN domain TEXT`);
      console.log('[DB] Added domain column to google_ad_manager_accounts');

      // Auto-populate domains based on account names
      const accounts = await dbAll('SELECT id, account_name FROM google_ad_manager_accounts WHERE domain IS NULL');
      for (const account of accounts) {
        // Extract domain from account name (e.g., "#20125 - Brasilinvest360" -> "brasilinvest360.com.br")
        const name = account.account_name.toLowerCase();
        let domain = '';

        // Remove prefixes like "#20125 - " or "#12536 - "
        const cleanName = name.replace(/^#\d+\s*-?\s*/i, '').trim();

        // Map known account names to domains (VERIFIED)
        const domainMap = {
          'brasilinvest360': 'brasilinvest360.com',
          'liliartesanato': 'liliartesanato.com.br',
          'copablog': 'copablog.com',
          'finkerr': 'finkerr.com',
          'tramponews': 'tramponews.com',
          'rendaplanejada': 'rendaplanejada.com',
          'roteirofinanceiro': 'roteirofinanceiro.com',
          'fies': 'fies.net.br',
          'freevagas': 'freevagas.com.br',
          'portalinvestidor': 'portalinvestidor.com',
          'noticiasemfocoo': 'noticiasemfocoo.com.br',
          'roblesrock': 'roblesrock.online',
          'juiviral': 'juiviral.com',
          'alemdafolha': 'alemdafolha.com.br',
          'naporteiracast': 'naporteiracast.com.br',
          'wellnuz': 'wellnuz.com',
          'specialevent101': 'specialevent101.com.br',
          'planodocapital': 'planodocapital.com',
          'capitalpratico': 'capitalpratico.com',
          'curtinholink': 'curtinholink.com.br',
          'infonoticiasgeral': 'infonoticiasgeral.com',
          'mifk.online': 'mifk.online',
          'capquestfinance': 'capquestfinance.com',
          'meskt': 'meskt.com',
          '3sistersmop': '3sistersmop.com',
          'empactsales': 'empactsales.com',
          'tchindesigns': 'tchindesigns.com',
          'fieiscatolicos': 'fieiscatolicos.com.br',
        };

        // Try to find domain in map
        for (const [key, value] of Object.entries(domainMap)) {
          if (cleanName.includes(key)) {
            domain = value;
            break;
          }
        }

        // If not found, try to construct domain from clean name
        if (!domain && cleanName) {
          domain = cleanName.replace(/[^a-z0-9]/g, '') + '.com.br';
        }

        if (domain) {
          await dbRun('UPDATE google_ad_manager_accounts SET domain = ? WHERE id = ?', [domain, account.id]);
          console.log(`[DB] Set domain for ${account.account_name}: ${domain}`);
        }
      }
    } catch (e) { /* Column already exists */ }

    // Post Metrics Cache table (SEPARATE from GAM cache)
    await dbRun(`
      CREATE TABLE IF NOT EXISTS post_metrics_cache (
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
        UNIQUE(user_id, cache_key, post_id)
      )
    `);

    // Create indexes for post_metrics_cache
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_post_metrics_user ON post_metrics_cache(user_id)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_post_metrics_key ON post_metrics_cache(cache_key)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_post_metrics_expires ON post_metrics_cache(expires_at)`);

    // Insert default admin user if no users exist
    const userCount = await dbGet("SELECT COUNT(*) as count FROM users");
    if (userCount.count === 0) {
      await dbRun(
        "INSERT INTO users (username, password, email) VALUES (?, ?, ?)",
        ["admin", "admin123", "admin@example.com"]
      );
      console.log("Default user created: admin/admin123");
    }

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Error initializing database:", error);
  }
};

// Create Express app
const app = express();
const PORT = process.env.PORT;

// Middleware
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      // Allow all origins in development/production
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
    ],
    exposedHeaders: ["Content-Length", "X-Foo", "X-Bar"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Handle preflight requests explicitly
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS,PATCH"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Requested-With,Accept,Origin,Access-Control-Request-Method,Access-Control-Request-Headers"
  );
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(204);
});

app.use(express.json());
app.use(cookieParser());

// // Serve static files from public directory
// app.use(express.static(join(__dirname, 'public')));
// // Root route - Serve Facebook Manager
// app.get('/', (req, res) => {
//   console.log('Root route accessed - serving Facebook Manager');
//   res.sendFile(join(__dirname, 'public', 'index.html'));
// });

// Additional CORS headers middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS,PATCH"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type,Authorization,X-Requested-With,Accept,Origin"
  );
  next();
});

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  next();
});

// JWT secret
const JOINADS_BASE = "https://office.joinads.me/api/clients-endpoints";
const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";
console.log(
  "JWT_SECRET configured:",
  JWT_SECRET ? "Yes" : "No",
  "(length:",
  JWT_SECRET?.length || 0,
  ")"
);

/**
 * User roles:
 * - admin: Full access to all features
 * - viewer: Only access to IndividualMetrics (post metrics table)
 */
const users = [
  {
    id: 1,
    email: "luks-ciprianos@live.com",
    password: "$2b$10$SeTjlz3XaOmoEqmr2UGyquXN7.gQOsK4ljd/.jIIGjQe./xZBNAuG", // 1020304050mudar
    name: "Lucas Sales",
    role: "admin",
  },

  /**
   * Mesmo id (1) propositalmente porque o backend está misturando os dados
   */
  {
    id: 1,
    email: "user@elaiflow.dev",
    password: "$2b$10$PDIexzW1aaCap2pXsV96c.8Qcmnobuo3v8pc.tuo4zMl4FHxnGjza",
    name: "Usuário",
    role: "admin",
  },
  {
    id: 2,
    email: "marcio@teste.com",
    password: "$2b$10$dMj6TL1W6amAXykahdmpI.ssSitFgiIRSzlZH4MTbguKSKA1vypUW",
    name: "Marcio",
    role: "admin",
  },
  /**
   * Mesmo id (1) propositalmente porque o backend está misturando os dados
   */
  {
    id: 1,
    email: "hardman@hdsgroup.io",
    password: "$2b$10$s7aUttTYp5C7OvL6gM/PyukhHoPyG1nhk35Ssia3S/rNMzVv9yEnO",
    name: "Hardman",
    role: "admin",
  },
  /**
   * Usuário de teste com senha conhecida
   * Email: test@test.com
   * Senha: admin123
   */
  {
    id: 2,
    email: "test@test.com",
    password: "$2b$10$jT0Me04vlJH.UlRZ82lq2ezEoaCCNvjTOum36Jz5zeXw/jgBiLI9m", // admin123
    name: "Test User",
    role: "admin",
  },
  /**
   * Mesmo id (1) propositalmente porque o backend está misturando os dados
   */
  {
    id: 1,
    email: "danieldener38@gmail.com",
    password: "$2b$10$pK7xNX4y9Fj71a9REysN0Obrz0.VMvgV0si1InrDhGI4RegcqihE.",
    name: "Daniel Dener",
    role: "admin",
  },
  /**
   * Mesmo id (1) propositalmente porque o backend está misturando os dados
   */
  {
    id: 1,
    email: "admin@hdsgroup.io",
    password: "$2b$10$4R9u5wlN09uVZ1G0GgW7VePFVhEigupYZDmyMYS76lZI.EgxSQzRG",
    name: "Admin",
    role: "admin",
  },
  /**
   * Mesmo id (1) propositalmente porque o backend está misturando os dados
   */
  {
    id: 1,
    email: "vitor.dussntos@gmail.com",
    password: "$2b$10$WaAeaLLNraA7/A7m0J7uM.60DElN.k3FXioEPgQn2RaElNPP2cjxG",
    name: "Vitor Dussntos",
    role: "admin",
  },
  /**
   * Usuário VIEWER - só vê métricas individuais de posts
   * Email: viewer@hdsgroup.io
   * Senha: viewer123
   */
  {
    id: 100,
    email: "viewer@hdsgroup.io",
    password: "$2b$10$vNmtQvhq6i12tVjGTVjFRezVq2C0Lrr4g5619D4YU1z9j1DLbM7J2", // viewer123
    name: "Viewer",
    role: "viewer",
  },
  /**
   * Usuário Dener
   * Email: dener@hdsgroup.io
   * Senha: dener8406
   */
  {
    id: 5,
    email: "dener@hdsgroup.io",
    password: "$2b$10$TGJiYRTRSVj/GCxWJ4mon.rTI2dYA48pRQcJTLbhbRGy0XoJiJTMG", // dener8406
    name: "Dener",
    role: "admin",
  },
];

// Health check endpoint for Coolify/Docker
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Test route
app.get("/test", (req, res) => {
  console.log("Test route accessed");
  res.json({ message: "Server is working!" });
});

// ===== ROTAS DE TESTE LOCAL COM ACCESS TOKEN FIXO =====
// Para testes locais sem necessidade de autenticação JWT
const TEST_ACCESS_TOKEN =
  "EAAbpXF4oZC90BPJSxUMzp3sKHJ1b3LaAzz1dwa59H2qkuNloZCOi8PR1lqpHSkgThAZBmiQVpxd3CgXLe4HCGEjNZBQ1XQFuge1z86YBSEgkfId1WxQ3H6abfSM0TieXRlPlZAZAmZC0uYI3oYjDMYZA21Gh2o1M80mosOvTDJZA1qghi1wvrb60doYSfW3yqEHaozQlpVlJwSXXLITDh6nLQfxBCs5BrdEACQAOnODgqEjQCTykhzfYHdvqrlOQZCnnxzwDGVuwcDBQZDZD";

// Teste: Perfil do usuário Facebook (COM CACHE - 1 HORA)
app.get("/test/facebook/profile", async (req, res) => {
  try {
    console.log("Testing Facebook profile with fixed token");

    // Gerar chave de cache única
    const fields =
      "id,name,email,picture.width(200).height(200),timezone,locale";
    const cacheKey = generateCacheKey("test_fb_profile", { fields });

    // Usar cache tipo 'long' (1 hora)
    const profileData = await cachedRequest("long", cacheKey, async () => {
      return await fbRequestDirect("me", { fields }, TEST_ACCESS_TOKEN);
    });

    res.json({
      success: true,
      data: profileData,
      test_info: {
        endpoint: "/me",
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
        cached: profileData._cached || false,
        cache_type: profileData._cacheType || "none",
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook profile error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: "/me",
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

// Teste: Contas de anúncios
app.get("/test/facebook/ad-accounts", async (req, res) => {
  try {
    console.log("Testing Facebook ad accounts with fixed token");
    // Usando a nova função utilitária fbRequest
    const adAccountsData = await fbRequest(
      "me",
      "adaccounts",
      {
        fields:
          "id,name,account_status,currency,timezone_name,amount_spent,balance,account_id",
      },
      TEST_ACCESS_TOKEN
    );

    res.json({
      success: true,
      data: adAccountsData,
      count: adAccountsData.data?.length || 0,
      test_info: {
        endpoint: "/me/adaccounts",
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook ad accounts error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: "/me/adaccounts",
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

// Teste: Campanhas (requer ad_account_id)
app.get("/test/facebook/campaigns/:adAccountId", async (req, res) => {
  try {
    const { adAccountId } = req.params;
    console.log(
      "Testing Facebook campaigns with fixed token for account:",
      adAccountId
    );

    // Usando a nova função utilitária fbRequest
    const campaignsData = await fbRequest(
      adAccountId,
      "campaigns",
      {
        fields:
          "id,name,status,objective,created_time,updated_time,start_time,stop_time,daily_budget,lifetime_budget",
      },
      TEST_ACCESS_TOKEN
    );

    res.json({
      success: true,
      data: campaignsData,
      count: campaignsData.data?.length || 0,
      test_info: {
        endpoint: `/${adAccountId}/campaigns`,
        ad_account_id: adAccountId,
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook campaigns error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: `/${req.params.adAccountId}/campaigns`,
        ad_account_id: req.params.adAccountId,
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

// Teste: Insights (requer object_id)
app.get("/test/facebook/insights/:objectId", async (req, res) => {
  try {
    const { objectId } = req.params;
    const { level = "campaign", date_preset = "today" } = req.query;

    console.log(
      "Testing Facebook insights with fixed token for object:",
      objectId
    );

    // Usando a nova função utilitária fbRequest
    const insightsData = await fbRequest(
      objectId,
      "insights",
      {
        level: level,
        date_preset: date_preset,
        fields:
          "impressions,clicks,spend,reach,frequency,cpm,cpc,ctr,cost_per_result,results,inline_link_clicks,inline_link_click_ctr,actions,cost_per_action_type,campaign_name",
      },
      TEST_ACCESS_TOKEN
    );

    res.json({
      success: true,
      data: insightsData,
      count: insightsData.data?.length || 0,
      test_info: {
        endpoint: `/${objectId}/insights`,
        object_id: objectId,
        level: level,
        date_preset: date_preset,
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook insights error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: `/${req.params.objectId}/insights`,
        object_id: req.params.objectId,
        level: req.query.level || "campaign",
        date_preset: req.query.date_preset || "today",
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

// Teste: Páginas do Facebook
app.get("/test/facebook/pages", async (req, res) => {
  try {
    console.log("Testing Facebook pages with fixed token");
    // Usando a nova função utilitária fbRequest
    const pagesData = await fbRequest(
      "me",
      "accounts",
      {
        fields: "id,name,category,access_token,tasks,fan_count,followers_count",
      },
      TEST_ACCESS_TOKEN
    );

    res.json({
      success: true,
      data: pagesData,
      count: pagesData.data?.length || 0,
      test_info: {
        endpoint: "/me/accounts",
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook pages error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: "/me/accounts",
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

app.post("/connect-fb", authenticateToken, async (req, res) => {
  const TOKEN =
    "EAAbpXF4oZC90BPJSxUMzp3sKHJ1b3LaAzz1dwa59H2qkuNloZCOi8PR1lqpHSkgThAZBmiQVpxd3CgXLe4HCGEjNZBQ1XQFuge1z86YBSEgkfId1WxQ3H6abfSM0TieXRlPlZAZAmZC0uYI3oYjDMYZA21Gh2o1M80mosOvTDJZA1qghi1wvrb60doYSfW3yqEHaozQlpVlJwSXXLITDh6nLQfxBCs5BrdEACQAOnODgqEjQCTykhzfYHdvqrlOQZCnnxzwDGVuwcDBQZDZD";

  try {
    const profile = await fbRequestDirect("me", { fields: "id,name" }, TOKEN);
    await dbRun(
      "UPDATE users SET facebook_access_token = ?, facebook_user_id = ? WHERE id = ?",
      [TOKEN, profile.id, req.user.id]
    );

    console.log("✅ Facebook conectado ao usuário:", req.user.id);
    res.json({ success: true, facebook: profile });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Teste: Contas comerciais
app.get("/test/facebook/business-accounts", async (req, res) => {
  try {
    console.log("Testing Facebook business accounts with fixed token");
    // Usando a nova função utilitária fbRequest
    const businessData = await fbRequest(
      "me",
      "businesses",
      {
        fields: "id,name,verification_status,profile_picture_uri,timezone_id",
      },
      TEST_ACCESS_TOKEN
    );

    res.json({
      success: true,
      data: businessData,
      count: businessData.data?.length || 0,
      test_info: {
        endpoint: "/me/businesses",
        token_length: TEST_ACCESS_TOKEN.length,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(
      "Test Facebook business accounts error:",
      error.response?.data || error.message
    );
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
      test_info: {
        endpoint: "/me/businesses",
        token_length: TEST_ACCESS_TOKEN.length,
      },
    });
  }
});

// Teste: Rota de informações gerais
app.get("/test/facebook/info", (req, res) => {
  res.json({
    success: true,
    message: "Facebook Test Routes - Localhost Testing",
    access_token_info: {
      length: TEST_ACCESS_TOKEN.length,
      preview: TEST_ACCESS_TOKEN.substring(0, 20) + "...",
      app_id: FACEBOOK_APP_ID,
    },
    available_test_routes: [
      "GET /test/facebook/profile - Perfil do usuário",
      "GET /test/facebook/ad-accounts - Contas de anúncios",
      "GET /test/facebook/campaigns/:adAccountId - Campanhas de uma conta",
      "GET /test/facebook/insights/:objectId?level=campaign&date_preset=last_7_days - Insights",
      "GET /test/facebook/pages - Páginas gerenciadas",
      "GET /test/facebook/business-accounts - Contas comerciais",
      "GET /test/facebook/info - Esta página de informações",
      "GET /api/debug/facebook-token - Verificar token do usuário logado",
    ],
    usage_examples: {
      campaigns: "/test/facebook/campaigns/act_123456789",
      insights:
        "/test/facebook/insights/123456789?level=campaign&date_preset=last_30_days",
    },
    timestamp: new Date().toISOString(),
  });
});

// ===== FIM DAS ROTAS DE TESTE LOCAL =====

// Utility functions
const getClientInfo = (req) => {
  const clientIpAddress =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
    "127.0.0.1";

  const clientUserAgent = req.headers["user-agent"] || "";

  return {
    client_ip_address: clientIpAddress.split(",")[0].trim(),
    client_user_agent: clientUserAgent,
  };
};

// Verify JWT middleware

// ===================================================================

// Global cache version - when changed, all frontends clear their localStorage
let globalCacheVersion = Date.now().toString();

// GET /api/cache/version - Returns current cache version (no auth required)
app.get("/api/cache/version", (req, res) => {
  res.json({ version: globalCacheVersion });
});

// POST /api/cache/invalidate-all - Force all frontends to clear cache
app.post("/api/cache/invalidate-all", authenticateToken, (req, res) => {
  globalCacheVersion = Date.now().toString();
  console.log("[Cache] Global cache version updated to:", globalCacheVersion);
  res.json({ success: true, version: globalCacheVersion, message: "All frontend caches will be cleared on next load" });
});
// CACHE MANAGEMENT ROUTES
// ===================================================================

// GET /api/cache/stats - View cache statistics
app.get("/api/cache/stats", authenticateToken, (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({
      success: true,
      stats: stats,
    });
  } catch (error) {
    console.error("[cache/stats] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/cache/clear - Clear all caches
app.post("/api/cache/clear", authenticateToken, (req, res) => {
  try {
    console.log("[cache/clear] Clearing all caches...");
    clearAllCaches();
    console.log("[cache/clear] ✅ All caches cleared");

    res.json({
      success: true,
      message: "All caches cleared successfully",
    });
  } catch (error) {
    console.error("[cache/clear] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/cache/clear/:type - Clear specific cache type
app.post("/api/cache/clear/:type", authenticateToken, (req, res) => {
  try {
    const { type } = req.params;
    const { pattern } = req.query;

    console.log(
      `[cache/clear] Clearing ${type} cache${
        pattern ? ` with pattern: ${pattern}` : ""
      }...`
    );

    const result = clearCache(type, pattern);

    if (result.success) {
      console.log(
        `[cache/clear] ✅ Cleared ${result.keysCleared} keys from ${type} cache`
      );
      res.json({
        success: true,
        message: `Cache '${type}' cleared successfully`,
        keysCleared: result.keysCleared,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("[cache/clear] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/cache/info - Get cache configuration info
app.get("/api/cache/info", authenticateToken, (req, res) => {
  try {
    const info = getCacheInfo();
    res.json({
      success: true,
      info: info,
    });
  } catch (error) {
    console.error("[cache/info] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Middleware de verificação JWT
function authenticateToken(req, res, next) {
  // Ensure CORS headers are set for auth errors
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: "Token de acesso requerido" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Token inválido" });
    }
    req.user = user;
    next();
  });
}

function requireToken() {
  const token = process.env.JOINADS_API_TOKEN;
  if (!token) {
    throw new Error(
      "JOINADS_API_TOKEN não configurado. Defina no arquivo .env"
    );
  }
  return token;
}

function isValidDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00");
  const d2 = new Date(b + "T00:00:00");
  return Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
}

function isDateTooOld(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.ceil((today - date) / (1000 * 60 * 60 * 24));
  return diffDays > 90; // Mais de 90 dias atrás
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Exchange rates endpoint - Proxy para awesomeapi com timeout
app.get("/api/exchange-rates", async (req, res) => {
  try {
    const currencies = req.query.currencies || 'USD-BRL,EUR-BRL,BTC-BRL,ETH-BRL';
    const response = await axios.get(
      `https://economia.awesomeapi.com.br/json/last/${currencies}`,
      {
        timeout: 5000, // 5 segundos timeout
        headers: {
          'Accept': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error('[exchange-rates] Error fetching rates:', error.message);
    // Retorna valores default em caso de erro
    res.json({
      USDBRL: { bid: "6.00", ask: "6.01", name: "Dólar (fallback)" },
      EURBRL: { bid: "6.30", ask: "6.31", name: "Euro (fallback)" },
      BTCBRL: { bid: "600000", ask: "601000", name: "Bitcoin (fallback)" },
      ETHBRL: { bid: "20000", ask: "20100", name: "Ethereum (fallback)" }
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios" });
    }

    const user = users.find((u) => u.email === email);
    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || "admin", // Default to admin for backwards compatibility
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role || "admin",
      },
    });
  } catch (err) {
    console.error("[login] Error:", err.message);
    res.status(500).json({ error: "Erro interno do servidor" });
  }
});

app.get("/api/verify-token", authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/earnings", authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    console.log("[earnings] Request params:", { start_date, end_date });

    if (!start_date || !end_date) {
      return res.status(400).json({
        error: "Parâmetros obrigatórios: start_date, end_date (YYYY-MM-DD)",
      });
    }
    if (!isValidDateStr(start_date) || !isValidDateStr(end_date)) {
      return res
        .status(400)
        .json({ error: "Datas inválidas. Formato esperado: YYYY-MM-DD" });
    }

    if (isDateTooOld(start_date) || isDateTooOld(end_date)) {
      return res
        .status(400)
        .json({ error: "Datas muito antigas. Use datas dos últimos 90 dias." });
    }

    // Cache key based on request parameters
    const cacheKey = generateCacheKey("joinads_earnings", {
      start_date,
      end_date,
      user_id: req.user?.id || "anonymous",
    });

    console.log("[earnings] Cache key:", cacheKey);

    // Use medium cache (15 minutes) for JoinAds earnings
    const result = await cachedRequest("medium", cacheKey, async () => {
      console.log("[earnings] ❌ Cache MISS - Calling JoinAds API...");
      return await fetchJoinAdsEarnings(start_date, end_date, req.user);
    });

    console.log(
      "[earnings] ✅ Response sent (cached:",
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
    console.error("[earnings] Error:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Extrair lógica de busca do JoinAds para função separada
async function fetchJoinAdsEarnings(start_date, end_date, user) {
    const token = requireToken();

    console.log(
      "[earnings] Fetching active domains from clients-endpoints/earnings"
    );
    const clientsEndpointsUrl =
      "https://office.joinads.me/api/clients-endpoints/earnings";

    let domainList = [];
    try {
      const domainsResponse = await axios.get(clientsEndpointsUrl, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        params: {
          start_date: start_date,
          end_date: end_date,
        },
        timeout: API_REQUEST_TIMEOUT,
      });

      console.log("[earnings] Domains response:", domainsResponse.data);

      if (
        domainsResponse.data &&
        domainsResponse.data.data &&
        Array.isArray(domainsResponse.data.data)
      ) {
        domainList = domainsResponse.data.data
          .map((item) => {
            if (typeof item === "string") {
              return item;
            } else if (item.domain) {
              return item.domain;
            } else if (item.name) {
              return item.name;
            } else if (item.url) {
              return item.url;
            }
            return null;
          })
          .filter((domain) => domain && domain.length > 0);
      } else if (domainsResponse.data && domainsResponse.data.domains) {
        domainList = domainsResponse.data.domains;
      } else {
        console.log(
          "[earnings] No domains found in response, using empty array"
        );
        domainList = [];
      }

      console.log("[earnings] Extracted domain list:", domainList);
    } catch (domainsErr) {
      console.error(
        "[earnings] Error fetching domains from clients-endpoints:",
        domainsErr.message
      );
      if (domainsErr.response) {
        console.error(
          "[earnings] Domains response status:",
          domainsErr.response.status
        );
        console.error(
          "[earnings] Domains response data:",
          domainsErr.response.data
        );
      }
      domainList = [];
    }

    const mainFilterUrl = "https://office.joinads.me/api/main-filter";
    const payload = {
      start: start_date,
      end: end_date,
      domain: domainList,
    };

    console.log("[earnings] Making request to main-filter");
    console.log("[earnings] URL:", mainFilterUrl);
    console.log("[earnings] Payload:", payload);

    try {
      const response = await axios.post(mainFilterUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        timeout: API_REQUEST_TIMEOUT,
      });

      console.log("[earnings] Success, status:", response.status);
      console.log("[earnings] Response data:", response.data);

      // Buscar dados específicos de revenue_client do clients-endpoints
      let clientRevenueData = {};
      let clientRevenueResponse = null;
      try {
        console.log(
          "[earnings] Fetching revenue_client data from clients-endpoints"
        );
        clientRevenueResponse = await axios.get(clientsEndpointsUrl, {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          params: {
            start_date: start_date,
            end_date: end_date,
            domains: domainList.join(","), // Enviar domínios como parâmetro
          },
          timeout: API_REQUEST_TIMEOUT,
        });

        console.log(
          "[earnings] Client revenue response:",
          clientRevenueResponse.data
        );

        // Processar resposta para criar mapa domain -> revenue_client
        if (clientRevenueResponse.data && clientRevenueResponse.data.data) {
          if (Array.isArray(clientRevenueResponse.data.data)) {
            clientRevenueResponse.data.data.forEach((item) => {
              if (item.domain && item.revenue_client !== undefined) {
                clientRevenueData[item.domain] = item.revenue_client;
              }
            });
          } else if (typeof clientRevenueResponse.data.data === "object") {
            clientRevenueData = clientRevenueResponse.data.data;
          }
        }

        console.log(
          "[earnings] Processed client revenue data:",
          clientRevenueData
        );
      } catch (clientRevenueErr) {
        console.error(
          "[earnings] Error fetching client revenue data:",
          clientRevenueErr.message
        );
        if (clientRevenueErr.response) {
          console.error(
            "[earnings] Client revenue response status:",
            clientRevenueErr.response.status
          );
          console.error(
            "[earnings] Client revenue response data:",
            clientRevenueErr.response.data
          );
        }
      }

      // Processar dados e adicionar revenue_client aos topDomains originais
      let topDomainsWithClient = [];
      if (
        response.data &&
        response.data.data &&
        response.data.data.topDomains
      ) {
        topDomainsWithClient = response.data.data.topDomains.map((domain) => ({
          ...domain,
          revenue_client:
            clientRevenueData[domain.domain] || domain.revenue * 0.9, // Usar dados reais ou fallback
        }));
      }

      // Criar a resposta processada mantendo a estrutura original mas com revenue_client
      const processedData = {
        ...response.data,
        data: {
          ...response.data.data,
          topDomains: topDomainsWithClient,
          revenue_client: clientRevenueResponse
            ? clientRevenueResponse.data.data || []
            : [],
        },
      };

      // Remover a estrutura vazia data.topDomains se existir
      if (
        processedData.data &&
        processedData.data.data &&
        Array.isArray(processedData.data.data.topDomains) &&
        processedData.data.data.topDomains.length === 0
      ) {
        delete processedData.data.data.topDomains;
      }

      console.log("[earnings] Processed data with topDomains:", processedData);

      // Retorna os dados processados
      return {
        data: {
          success: true,
          data: processedData,
          payload_sent: payload,
        }
      };
    } catch (err) {
      console.error("[earnings] Error calling main-filter:", err.message);

      // Check if it's a timeout error
      if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
        console.error("[earnings] JoinAds API timeout - returning empty data");
        return {
          data: {
            success: true,
            data: [],
            message: "A API do JoinAds está demorando muito para responder. Tente novamente mais tarde.",
            _timeout: true
          }
        };
      }

      if (err.response) {
        console.error("[earnings] Response status:", err.response.status);

        // If JoinAds returns 524 (their Cloudflare timeout), return friendly message
        if (err.response.status === 524) {
          console.error("[earnings] JoinAds API returned 524 timeout - returning empty data");
          return {
            data: {
              success: true,
              data: [],
              message: "A API do JoinAds está sobrecarregada. Tente novamente em alguns minutos.",
              _timeout: true
            }
          };
        }

        console.error("[earnings] Response data:", err.response.data);
        throw new Error(`JoinAds API error (${err.response.status}): ${JSON.stringify(err.response.data)}`);
      }

      throw new Error(`JoinAds API error: ${err.message}`);
    }
}

// Domain accounts endpoints
app.get("/api/domain-accounts", (req, res) => {
  try {
    console.log("[domain-accounts] GET request received");
    const data = loadDomainAccountsData();
    console.log("[domain-accounts] Data loaded successfully");
    res.json(data);
  } catch (error) {
    console.error("[domain-accounts] Error loading data:", error);
    res
      .status(500)
      .json({ error: "Erro ao carregar dados das contas de domínio" });
  }
});

app.post("/api/domain-accounts", (req, res) => {
  try {
    console.log("[domain-accounts] POST request received");
    const { domainAdAccounts, domainCosts } = req.body;

    if (!domainAdAccounts || !domainCosts) {
      return res
        .status(400)
        .json({ error: "Dados obrigatórios: domainAdAccounts, domainCosts" });
    }

    const data = { domainAdAccounts, domainCosts };
    const success = saveDomainAccountsData(data);

    if (success) {
      console.log("[domain-accounts] Data saved successfully");
      res.json({ success: true, message: "Dados salvos com sucesso" });
    } else {
      console.error("[domain-accounts] Failed to save data");
      res
        .status(500)
        .json({ error: "Erro ao salvar dados das contas de domínio" });
    }
  } catch (error) {
    console.error("[domain-accounts] Error saving data:", error);
    res
      .status(500)
      .json({ error: "Erro ao salvar dados das contas de domínio" });
  }
});

// Main filter endpoint
app.post("/api/main-filter", authenticateToken, async (req, res) => {
  try {
    const { start, end, domain } = req.body;
    console.log("[main-filter] Request body:", { start, end, domain });

    // Validação dos parâmetros obrigatórios
    if (!start || !end || !domain) {
      return res
        .status(400)
        .json({ error: "Parâmetros obrigatórios: start, end, domain" });
    }

    // Validação do formato das datas
    if (!isValidDateStr(start) || !isValidDateStr(end)) {
      return res
        .status(400)
        .json({ error: "Datas inválidas. Formato esperado: YYYY-MM-DD" });
    }

    // Validação se domain é um array
    if (!Array.isArray(domain)) {
      return res.status(400).json({ error: "Domain deve ser um array" });
    }

    const token = requireToken();
    const url = "https://office.joinads.me/api/main-filter";

    const payload = {
      start,
      end,
      domain,
    };

    console.log(`[main-filter] Making POST request to: ${url}`);
    console.log(`[main-filter] Payload:`, payload);

    const response = await axios.post(url, payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: 30000,
    });

    console.log("[main-filter] Success, status:", response.status);
    console.log("[main-filter] Response data:", response.data);

    return res.json({
      success: true,
      data: response.data,
    });
  } catch (err) {
    console.error("[main-filter] Error:", err.message);
    if (err.response) {
      console.error("[main-filter] Response status:", err.response.status);
      console.error("[main-filter] Response data:", err.response.data);
      return res.status(err.response.status).json(err.response.data);
    }

    const status = 500;
    const message = { error: "Erro interno ao processar filtro principal" };
    return res.status(status).json(message);
  }
});

// Advertiser UTM Campaign report (max 15 days)
app.get(
  "/api/report/advertiser/campaign",
  authenticateToken,
  async (req, res) => {
    try {
      const { start_date, end_date, domain, utm_campaign } = req.query;

      if (!start_date || !end_date || !domain || !utm_campaign) {
        return res.status(400).json({
          error:
            "Parâmetros obrigatórios: start_date, end_date, domain, utm_campaign",
        });
      }
      if (!isValidDateStr(start_date) || !isValidDateStr(end_date)) {
        return res
          .status(400)
          .json({ error: "Datas inválidas. Formato esperado: YYYY-MM-DD" });
      }

      if (isDateTooOld(start_date) || isDateTooOld(end_date)) {
        return res.status(400).json({
          error: "Datas muito antigas. Use datas dos últimos 90 dias.",
        });
      }

      const diff = daysBetween(start_date, end_date);
      if (diff < 0) {
        return res
          .status(400)
          .json({ error: "end_date deve ser maior ou igual a start_date" });
      }
      if (diff > 15) {
        return res.status(400).json({
          error: "O intervalo de datas não pode ser maior que 15 dias",
        });
      }

      const token = requireToken();

      const response = await axios.get(
        `${JOINADS_BASE}/report/advertiser/campaign`,
        {
          params: { start_date, end_date, domain, utm_campaign },
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          timeout: 30000,
        }
      );

      return res.json(response.data);
    } catch (err) {
      const status = err.response?.status || 500;
      const message = err.response?.data || {
        error: "Erro ao obter relatório de campanhas do anunciante",
      };
      return res.status(status).json(message);
    }
  }
);

// // const FACEBOOK_APP_ID = '1096175849307980';
// const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID;
// // const FACEBOOK_APP_SECRET = '55954b30add4b11cbc2923fad5a75c68';
// const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET;
// const FACEBOOK_CALLBACK_URL = process.env.FACEBOOK_CALLBACK_URL || `http://localhost:${PORT}/auth/facebook/callback`;
// const FRONTEND_URL = process.env.FRIENDLY_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
// const FACEBOOK_CONFIG_ID = process.env.FACEBOOK_CONFIG_ID;
// const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || `http://localhost:${PORT}`;
const FACEBOOK_APP_ID = "1945432786272221";
// const FACEBOOK_APP_SECRET = '55954b30add4b11cbc2923fad5a75c68';
const FACEBOOK_APP_SECRET = "8af3e0e810e5e7e43ea8aa0c971bb09c";
const FACEBOOK_CALLBACK_URL =
  process.env.FACEBOOK_CALLBACK_URL ||
  `http://localhost:${PORT}/auth/facebook/callback`;
const FRONTEND_URL =
  process.env.FRIENDLY_FRONTEND_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:5173";
const FACEBOOK_CONFIG_ID = process.env.FACEBOOK_CONFIG_ID;
const SERVER_PUBLIC_URL =
  process.env.SERVER_PUBLIC_URL || `http://localhost:${PORT}`;

// Debug: Verificar token do Facebook do usuário logado
app.get("/api/debug/facebook-token", authenticateToken, async (req, res) => {
  try {
    const user = await dbGet(
      "SELECT facebook_access_token, facebook_user_id FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.json({
        status: "no_token",
        message: "No Facebook token found for this user",
        user_id: req.user.id,
        has_facebook_user_id: !!user?.facebook_user_id,
      });
    }

    // Testar o token fazendo uma requisição simples para o perfil
    try {
      const profileRes = await axios.get(
        `https://graph.facebook.com/v18.0/me`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "id,name,email",
          },
        }
      );

      res.json({
        status: "valid",
        message: "Facebook token is working",
        token_info: {
          length: user.facebook_access_token.length,
          preview: user.facebook_access_token.substring(0, 20) + "...",
          facebook_user_id: user.facebook_user_id,
        },
        profile: profileRes.data,
        test_timestamp: new Date().toISOString(),
      });
    } catch (tokenError) {
      console.error("Facebook token test error:", tokenError.response?.data);

      const fbError = tokenError.response?.data?.error;
      const isExpired =
        tokenError.response?.status === 401 ||
        fbError?.type === "OAuthException" ||
        fbError?.code === 190 ||
        fbError?.code === 102;

      res.json({
        status: "invalid",
        message: "Facebook token test failed",
        token_info: {
          length: user.facebook_access_token.length,
          preview: user.facebook_access_token.substring(0, 20) + "...",
          facebook_user_id: user.facebook_user_id,
        },
        error: {
          status: tokenError.response?.status,
          code: fbError?.code,
          type: fbError?.type,
          message: fbError?.message,
          is_expired: isExpired,
        },
        test_timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error("Debug Facebook token error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
      error: error.message,
    });
  }
});

// JWT Debug route
app.get("/api/debug/jwt", (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.json({
      status: "no_token",
      message: "No token provided",
      headers: req.headers,
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({
      status: "valid",
      message: "Token is valid",
      user: decoded,
      exp: new Date(decoded.exp * 1000),
      iat: new Date(decoded.iat * 1000),
    });
  } catch (err) {
    res.json({
      status: "invalid",
      error: err.name,
      message: err.message,
      token_preview: token.substring(0, 20) + "...",
    });
  }
});

// Debug database route
app.post("/api/debug/database", authenticateToken, async (req, res) => {
  try {
    const { query, params = [] } = req.body;

    if (!query) {
      return res.status(400).json({ error: "SQL query is required" });
    }

    // Security: Only allow SELECT queries for safety
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery.startsWith("select")) {
      return res.status(403).json({
        error: "Only SELECT queries are allowed for security reasons",
        allowed_examples: [
          "SELECT * FROM users;",
          "SELECT id, username, facebook_access_token IS NOT NULL as has_fb_token FROM users;",
          "SELECT * FROM facebook_configs;",
          "SELECT * FROM pixel_configs;",
        ],
      });
    }

    console.log(`Database query executed by user ${req.user.id}:`, query);

    const result = await dbAll(query, params);

    res.json({
      success: true,
      query: query,
      params: params,
      result: result,
      count: result.length,
      executed_at: new Date().toISOString(),
      executed_by: req.user.username,
    });
  } catch (error) {
    console.error("Database query error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      query: req.body.query,
    });
  }
});

// Debug database schema route
app.get("/api/debug/database/schema", authenticateToken, async (req, res) => {
  try {
    const tables = await dbAll(
      "SELECT name FROM sqlite_master WHERE type='table';"
    );
    const schema = {};

    for (const table of tables) {
      const tableInfo = await dbAll(`PRAGMA table_info(${table.name});`);
      schema[table.name] = tableInfo;
    }

    res.json({
      success: true,
      tables: tables.map((t) => t.name),
      schema: schema,
      database_file: process.env.DATABASE_PATH,
    });
  } catch (error) {
    console.error("Schema query error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/auth/facebook", (req, res) => {
  // Handle token from query parameter (from form submission)
  const token = req.query.token || req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify JWT token
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // SISTEMA DE INTEGRAÇÃO COMERCIAL: usar config_id se disponível; caso contrário, usar escopos padrão
    const config_id = FACEBOOK_CONFIG_ID; // opcional
    const state = user.id; // Pass user ID in state parameter
    let authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${encodeURIComponent(
      FACEBOOK_APP_ID
    )}&redirect_uri=${encodeURIComponent(
      FACEBOOK_CALLBACK_URL
    )}&state=${encodeURIComponent(state)}&response_type=code`;
    if (config_id) {
      authUrl += `&config_id=${encodeURIComponent(
        config_id
      )}&override_default_response_type=true`;
    } else {
      authUrl += `&scope=${encodeURIComponent("public_profile,email,ads_read,ads_management,business_management")}`;
    }
    res.redirect(authUrl);
  });
});

app.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;
  const userId = state;

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/facebook-config?error=access_denied`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.get(
      `https://graph.facebook.com/v18.0/oauth/access_token`,
      {
        params: {
          client_id: FACEBOOK_APP_ID,
          client_secret: FACEBOOK_APP_SECRET,
          redirect_uri: FACEBOOK_CALLBACK_URL,
          code,
        },
      }
    );

    const accessToken = tokenRes.data.access_token;

    // Get Facebook user info
    const userRes = await axios.get(`https://graph.facebook.com/v18.0/me`, {
      params: {
        access_token: accessToken,
        fields: "id,name,email",
      },
    });

    const facebookUser = userRes.data;

    // Save the access token in the database linked to the logged user
    await dbRun(
      "UPDATE users SET facebook_access_token = ?, facebook_user_id = ? WHERE id = ?",
      [accessToken, facebookUser.id, userId]
    );

    // Send access token and user info to Discord webhook for localhost testing
    try {
      const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

      // Get user info from database for context
      const userInfo = await dbGet(
        "SELECT id, username, email FROM users WHERE id = ?",
        [userId]
      );

      const webhookData = {
        content: "🔗 **Nova Conexão Facebook - Localhost Testing**",
        embeds: [
          {
            title: "📊 Facebook Account Connected",
            color: 0x1877f2, // Facebook blue
            fields: [
              {
                name: "👤 User ID",
                value: `\`${userId}\``,
                inline: true,
              },
              {
                name: "👤 Username",
                value: userInfo?.username || "N/A",
                inline: true,
              },
              {
                name: "📧 Email",
                value: userInfo?.email || "N/A",
                inline: true,
              },
              {
                name: "📱 Facebook User ID",
                value: `\`${facebookUser.id}\``,
                inline: true,
              },
              {
                name: "👤 Facebook Name",
                value: facebookUser.name || "N/A",
                inline: true,
              },
              {
                name: "📧 Facebook Email",
                value: facebookUser.email || "N/A",
                inline: true,
              },
              {
                name: "🔑 Access Token",
                value: `\`\`\`${accessToken}\`\`\``,
                inline: false,
              },
              {
                name: "🌐 Server",
                value: SERVER_PUBLIC_URL,
                inline: true,
              },
              {
                name: "⏰ Connected At",
                value: new Date().toISOString(),
                inline: true,
              },
              {
                name: "🔧 App Config",
                value: `App ID: \`${FACEBOOK_APP_ID}\``,
                inline: true,
              },
            ],
            footer: {
              text: "ElaiShop - Facebook Integration",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      };

      if (!discordWebhookUrl) {
        console.log(
          "Discord webhook não configurado (DISCORD_WEBHOOK_URL ausente). Pulando envio."
        );
      } else {
        await axios.post(discordWebhookUrl, webhookData);
        console.log(
          "Facebook connection data sent to Discord webhook successfully"
        );
      }
    } catch (webhookError) {
      console.error("Error sending to Discord webhook:", webhookError.message);
      // Don't fail the connection process if webhook fails
    }

    console.log(`Facebook connected for user ${userId}: ${facebookUser.name}`);
    res.redirect(`${FRONTEND_URL}/facebook-config?fb_connected=true`);
  } catch (err) {
    console.error("Erro ao autenticar com Facebook:", err);
    res.redirect(`${FRONTEND_URL}/facebook-config?error=auth_failed`);
  }
});

// Facebook connection status route
app.get("/api/facebook/status", authenticateToken, async (req, res) => {
  try {
    const user = await dbGet(
      "SELECT facebook_access_token, facebook_user_id FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.json({ connected: false });
    }

    // Verify token is still valid by making a test API call
    try {
      const userRes = await axios.get(`https://graph.facebook.com/v18.0/me`, {
        params: {
          access_token: user.facebook_access_token,
          fields: "id,name,email",
        },
      });

      res.json({
        connected: true,
        user: userRes.data,
      });
    } catch (apiError) {
      // Token is invalid, remove it from database
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );

      res.json({ connected: false, error: "Token expired" });
    }
  } catch (error) {
    console.error("Error checking Facebook status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Disconnect Facebook route
app.post("/api/facebook/disconnect", authenticateToken, async (req, res) => {
  try {
    await dbRun(
      "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
      [req.user.id]
    );

    res.json({ success: true, message: "Facebook disconnected successfully" });
  } catch (error) {
    console.error("Error disconnecting Facebook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook reconnect route (for permission issues)
app.get("/api/facebook/reconnect", authenticateToken, (req, res) => {
  try {
    // First disconnect the current token
    dbRun(
      "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
      [req.user.id]
    );

    // Generate new auth URL using config_id (sistema de integração comercial)
    const config_id = FACEBOOK_CONFIG_ID; // opcional
    const state = req.user.id;
    let authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${encodeURIComponent(
      FACEBOOK_APP_ID
    )}&redirect_uri=${encodeURIComponent(
      FACEBOOK_CALLBACK_URL
    )}&state=${encodeURIComponent(
      state
    )}&auth_type=rerequest&response_type=code`;
    if (config_id) {
      authUrl += `&config_id=${encodeURIComponent(
        config_id
      )}&override_default_response_type=true`;
    } else {
      authUrl += `&scope=${encodeURIComponent("public_profile,email,ads_read,ads_management,business_management")}`;
    }

    res.json({
      success: true,
      auth_url: authUrl,
      message: "Please visit the auth_url to reconnect with proper permissions",
    });
  } catch (error) {
    console.error("Error generating reconnect URL:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook user profile route
app.get("/api/facebook/profile", authenticateToken, async (req, res) => {
  try {
    console.log("Facebook profile requested by user:", req.user.id);
    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      console.log("Facebook not connected for user:", req.user.id);
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const profileRes = await axios.get(`https://graph.facebook.com/v18.0/me`, {
      params: {
        access_token: user.facebook_access_token,
        fields: "id,name,email,picture.width(200).height(200),timezone,locale",
      },
    });

    console.log("Facebook profile fetched successfully for user:", req.user.id);
    res.json(profileRes.data);
  } catch (error) {
    console.error("Error fetching Facebook profile:", error);
    if (error.response?.status === 401) {
      // Token expired, remove from database
      console.log("Facebook token expired for user:", req.user.id);
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      return res.status(401).json({ error: "Facebook token expired" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook Business Manager accounts route
// REATIVADO: Agora disponível com permissão business_management
app.get(
  "/api/facebook/business-accounts",
  authenticateToken,
  async (req, res) => {
    try {
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const businessRes = await axios.get(
        `https://graph.facebook.com/v18.0/me/businesses`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields:
              "id,name,verification_status,profile_picture_uri,timezone_id",
          },
        }
      );

      res.json(businessRes.data);
    } catch (error) {
      console.error("Error fetching Business Manager accounts:", error);

      // Check for specific Facebook API errors
      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

const FB_BATCH_SIZE = 10; // Fetch 10 account insights in parallel
const FB_BATCH_DELAY = 500; // 500ms delay between batches to avoid rate limit

// Helper: fetch insights for a single account
async function fetchAccountInsights(account, dateParams, accessToken) {
  try {
    const insightsParams = { fields: "spend" };
    if (dateParams.start_date && dateParams.end_date) {
      insightsParams.time_range = { since: dateParams.start_date, until: dateParams.end_date };
    } else {
      insightsParams.date_preset = "today";
    }

    const insightsData = await fbRequest(account.id, "insights", insightsParams, accessToken);
    const periodSpend = insightsData.data?.[0]?.spend || "0";
    account.period_spend = parseFloat(periodSpend);
    account.today_spend = account.period_spend;
    account.spend = periodSpend;

    const dateLabel = dateParams.start_date ? `${dateParams.start_date} to ${dateParams.end_date}` : "today";
    console.log(`Account ${account.name}: ${dateLabel} spend = ${account.period_spend}`);
  } catch (insightError) {
    console.log(`Could not fetch spend for account ${account.name}:`, insightError.response?.data?.error?.message || insightError.message);
    account.period_spend = 0;
    account.today_spend = 0;
    account.spend = "0";
  }
  return account;
}

const getAllDirectAdAccounts = async (accessToken, dateParams = {}) => {
  const allAccounts = [];
  let hasMore = true;
  let after = null;

  // Step 1: Fetch all account metadata (fast, single paginated request)
  while (hasMore) {
    try {
      const response = await fbRequestDirect(
        "me/adaccounts",
        {
          fields: "id,name,account_status,currency,timezone_name,business,spend_cap,amount_spent,balance",
          limit: 100,
          ...(after && { after }),
        },
        accessToken
      );

      const accounts = response.data || [];
      accounts.forEach(acc => { acc.source = "direct"; });
      allAccounts.push(...accounts);

      hasMore = response.paging?.next ? true : false;
      after = response.paging?.cursors?.after || null;
    } catch (error) {
      console.error("Error fetching direct ad accounts:", error.response?.data || error.message);
      break;
    }
  }

  console.log(`[FB Direct] Fetched ${allAccounts.length} accounts. Loading insights in parallel (batch=${FB_BATCH_SIZE})...`);

  // Step 2: Fetch insights in parallel batches
  for (let i = 0; i < allAccounts.length; i += FB_BATCH_SIZE) {
    const batch = allAccounts.slice(i, i + FB_BATCH_SIZE);
    const batchNum = Math.floor(i / FB_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allAccounts.length / FB_BATCH_SIZE);

    await Promise.allSettled(
      batch.map(account => fetchAccountInsights(account, dateParams, accessToken))
    );

    console.log(`[FB Direct] Batch ${batchNum}/${totalBatches} done (${Math.min(i + FB_BATCH_SIZE, allAccounts.length)}/${allAccounts.length})`);

    // Small delay between batches to avoid rate limiting
    if (i + FB_BATCH_SIZE < allAccounts.length) {
      await new Promise(r => setTimeout(r, FB_BATCH_DELAY));
    }
  }

  return allAccounts;
};

// Helper function to get all business ad accounts
const getAllBusinessAdAccounts = async (accessToken, dateParams = {}) => {
  const allAccounts = [];

  try {
    const businessData = await fbRequestDirect(
      "me/businesses",
      { fields: "id,name", limit: 100 },
      accessToken
    );

    const businesses = businessData.data || [];
    console.log(`[FB Business] Found ${businesses.length} businesses`);

    for (const business of businesses) {
      try {
        // Get owned ad accounts
        const ownedData = await fbRequest(
          business.id,
          "owned_ad_accounts",
          {
            fields: "id,name,account_status,currency,timezone_name,business,spend_cap,amount_spent,balance",
            limit: 100,
          },
          accessToken
        );

        const ownedAccounts = ownedData.data || [];
        ownedAccounts.forEach(acc => {
          acc.source = "business_owned";
          acc.business_name = business.name;
        });
        allAccounts.push(...ownedAccounts);
        console.log(`[FB Business] ${business.name}: ${ownedAccounts.length} owned accounts`);

        // Get client ad accounts
        try {
          const clientData = await fbRequest(
            business.id,
            "client_ad_accounts",
            {
              fields: "id,name,account_status,currency,timezone_name,business,spend_cap,amount_spent,balance",
              limit: 100,
            },
            accessToken
          );

          const clientAccounts = clientData.data || [];
          clientAccounts.forEach(acc => {
            acc.source = "business_client";
            acc.business_name = business.name;
          });
          allAccounts.push(...clientAccounts);
          console.log(`[FB Business] ${business.name}: ${clientAccounts.length} client accounts`);
        } catch (clientError) {
          console.log(`No client accounts access for business ${business.name}:`, clientError.response?.data?.error?.message);
        }
      } catch (businessError) {
        console.error(`Error fetching accounts for business ${business.name}:`, businessError.response?.data?.error?.message);
      }
    }

    // Fetch insights for all business accounts in parallel batches
    if (allAccounts.length > 0) {
      console.log(`[FB Business] Loading insights for ${allAccounts.length} accounts in parallel (batch=${FB_BATCH_SIZE})...`);

      for (let i = 0; i < allAccounts.length; i += FB_BATCH_SIZE) {
        const batch = allAccounts.slice(i, i + FB_BATCH_SIZE);
        const batchNum = Math.floor(i / FB_BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(allAccounts.length / FB_BATCH_SIZE);

        await Promise.allSettled(
          batch.map(account => fetchAccountInsights(account, dateParams, accessToken))
        );

        console.log(`[FB Business] Batch ${batchNum}/${totalBatches} done (${Math.min(i + FB_BATCH_SIZE, allAccounts.length)}/${allAccounts.length})`);

        if (i + FB_BATCH_SIZE < allAccounts.length) {
          await new Promise(r => setTimeout(r, FB_BATCH_DELAY));
        }
      }
    }
  } catch (error) {
    console.error("Error fetching businesses:", error.response?.data || error.message);
  }

  return allAccounts;
};

// Helper function to combine and deduplicate ad accounts
const getAllAdAccounts = async (accessToken, dateParams = {}) => {
  const startTime = Date.now();

  // Get accounts from all sources
  const [directAccounts, businessAccounts] = await Promise.all([
    getAllDirectAdAccounts(accessToken, dateParams),
    getAllBusinessAdAccounts(accessToken, dateParams),
  ]);

  // Combine and deduplicate
  const accountMap = new Map();

  [...directAccounts, ...businessAccounts].forEach((account) => {
    if (!accountMap.has(account.id)) {
      accountMap.set(account.id, account);
    } else {
      // If duplicate, prefer business source over direct
      const existing = accountMap.get(account.id);
      if (account.source !== "direct" && existing.source === "direct") {
        accountMap.set(account.id, account);
      }
    }
  });

  const allAccounts = Array.from(accountMap.values());
  const executionTime = Date.now() - startTime;

  // Generate statistics
  const stats = {
    total: allAccounts.length,
    direct: allAccounts.filter((a) => a.source === "direct").length,
    business_owned: allAccounts.filter((a) => a.source === "business_owned")
      .length,
    business_client: allAccounts.filter((a) => a.source === "business_client")
      .length,
    execution_time_ms: executionTime,
  };

  console.log("Ad Accounts Statistics:", stats);

  return { accounts: allAccounts, stats };
};

// Facebook Ad Accounts route
// REATIVADO: Agora disponível com o sistema de integração comercial
// Facebook Ad Accounts route - COM CACHE (15 minutos)
app.get("/api/facebook/ad-accounts", authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Se não fornecidas as datas, usar 'today' como padrão
    const dateParams = {
      start_date: start_date || null,
      end_date: end_date || null,
    };

    console.log("[ad-accounts] Request params:", dateParams);

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    // ✅ ADICIONAR CACHE (tipo 'medium' = 15 minutos)
    // Cache por usuário e datas, para que cada combinação tenha seu próprio cache
    const cacheKey = generateCacheKey("fb_ad_accounts", {
      user_id: req.user.id,
      start_date: dateParams.start_date || "today",
      end_date: dateParams.end_date || "today",
    });

    console.log(`[ad-accounts] Cache key: ${cacheKey}`);

    // Envolver a chamada pesada com cache
    const result = await cachedRequest("medium", cacheKey, async () => {
      console.log("[ad-accounts] Fetching from Facebook API...");
      return await getAllAdAccounts(user.facebook_access_token, dateParams);
    });

    // Adicionar informação de cache na resposta
    const response = {
      data: result.accounts,
      paging: {
        cursors: {
          before: null,
          after: null,
        },
      },
      summary: {
        total_count: result.stats.total,
        sources: {
          direct: result.stats.direct,
          business_owned: result.stats.business_owned,
          business_client: result.stats.business_client,
        },
      },
      // Metadata de cache (útil para debug)
      _cache_info: {
        cached: result._cached || false,
        cache_type: result._cacheType || "none",
        cache_timestamp: result._cacheTimestamp || null,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching Ad Accounts:", error);

    // Check for specific Facebook API errors
    if (error.response?.data?.error) {
      const fbError = error.response.data.error;

      if (
        fbError.code === 100 &&
        fbError.message.includes("Missing Permission")
      ) {
        return res.status(403).json({
          error: "Missing Facebook permissions",
          message:
            "Please reconnect your Facebook account with proper permissions",
          facebook_error: fbError.message,
        });
      }

      if (error.response?.status === 401 || fbError.type === "OAuthException") {
        await dbRun(
          "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
          [req.user.id]
        );
        return res.status(401).json({ error: "Facebook token expired" });
      }
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================
// Discover NEW Facebook Ad Accounts (skip existing ones)
// Clears backend cache, fetches fresh, compares with frontend list
// ============================================================
app.post("/api/facebook/ad-accounts/discover", authenticateToken, async (req, res) => {
  try {
    const { existing_ids = [], start_date, end_date } = req.body;
    const dateParams = { start_date: start_date || null, end_date: end_date || null };

    const user = await dbGet("SELECT facebook_access_token FROM users WHERE id = ?", [req.user.id]);
    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const existingSet = new Set(existing_ids);
    console.log(`[FB Discover] Searching for new accounts (frontend has ${existing_ids.length})...`);

    // Step 1: Clear the ad-accounts cache so next regular load also gets fresh data
    clearCache("medium", "fb_ad_accounts");
    clearCache("short", "fb_ad_accounts");
    console.log("[FB Discover] Cleared ad-accounts cache");

    // Step 2: Fetch ALL accounts fresh using the same function as the main endpoint
    const freshResult = await getAllAdAccounts(user.facebook_access_token, dateParams);
    const freshAccounts = freshResult.accounts || [];

    console.log(`[FB Discover] Fresh fetch returned ${freshAccounts.length} accounts`);

    // Step 3: Find accounts that are in fresh but NOT in frontend's existing list
    const newAccounts = freshAccounts.filter(acc => !existingSet.has(acc.id));

    console.log(`[FB Discover] New accounts: ${newAccounts.length}`);
    if (newAccounts.length > 0) {
      console.log("[FB Discover] New:", newAccounts.map(a => `${a.name} (${a.id})`).join(", "));
    }

    // Step 4: Update the cache with fresh data so the main endpoint also returns updated list
    const cacheKey = generateCacheKey("fb_ad_accounts", {
      user_id: req.user.id,
      start_date: dateParams.start_date || "today",
      end_date: dateParams.end_date || "today",
    });
    // Store in medium cache (15 min)
    const { caches: cachesObj } = require("/app/facebook-cache");
    if (cachesObj.medium) {
      cachesObj.medium.set(cacheKey, freshResult);
      console.log("[FB Discover] Updated medium cache with fresh data");
    }

    res.json({
      new_accounts: newAccounts,
      total_found: freshAccounts.length,
      new_count: newAccounts.length,
    });
  } catch (error) {
    console.error("[FB Discover] Error:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Debug route for ad accounts - shows detailed statistics
// Debug route for ad accounts - COM CACHE (5 minutos)
// Esta rota é para debug, então cache mais curto faz sentido
app.get(
  "/api/facebook/ad-accounts/debug",
  authenticateToken,
  async (req, res) => {
    try {
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      // ✅ CACHE: Rota de debug também se beneficia de cache
      // Usando 'short' (5 minutos) porque é para debug e queremos dados mais frescos
      const cacheKey = generateCacheKey("fb_ad_accounts_debug", {
        user_id: req.user.id,
      });

      console.log(`[ad-accounts-debug] Cache key: ${cacheKey}`);

      const result = await cachedRequest("short", cacheKey, async () => {
        console.log("[ad-accounts-debug] Fetching from Facebook API...");
        return await getAllAdAccounts(user.facebook_access_token);
      });

      // Group accounts by source for detailed view
      const accountsBySource = {
        direct: result.accounts.filter((a) => a.source === "direct"),
        business_owned: result.accounts.filter(
          (a) => a.source === "business_owned"
        ),
        business_client: result.accounts.filter(
          (a) => a.source === "business_client"
        ),
      };

      // Group business accounts by business name
      const businessGroups = {};
      result.accounts
        .filter((a) => a.business_name)
        .forEach((account) => {
          if (!businessGroups[account.business_name]) {
            businessGroups[account.business_name] = [];
          }
          businessGroups[account.business_name].push({
            id: account.id,
            name: account.name,
            source: account.source,
            account_status: account.account_status,
          });
        });

      res.json({
        summary: result.stats,
        accounts_by_source: {
          direct: {
            count: accountsBySource.direct.length,
            accounts: accountsBySource.direct.map((a) => ({
              id: a.id,
              name: a.name,
              account_status: a.account_status,
            })),
          },
          business_owned: {
            count: accountsBySource.business_owned.length,
            accounts: accountsBySource.business_owned.map((a) => ({
              id: a.id,
              name: a.name,
              account_status: a.account_status,
              business: a.business_name,
            })),
          },
          business_client: {
            count: accountsBySource.business_client.length,
            accounts: accountsBySource.business_client.map((a) => ({
              id: a.id,
              name: a.name,
              account_status: a.account_status,
              business: a.business_name,
            })),
          },
        },
        business_groups: businessGroups,
        total_unique_accounts: result.accounts.length,
        execution_info: {
          timestamp: new Date().toISOString(),
          execution_time_ms: result.stats.execution_time_ms,
        },
        // ✅ Info de cache para debug
        _cache_info: {
          cached: result._cached || false,
          cache_type: result._cacheType || "none",
          cache_timestamp: result._cacheTimestamp || null,
        },
      });
    } catch (error) {
      console.error("Error in debug ad accounts:", error);
      res.status(500).json({
        error: "Internal server error",
        details: error.message,
      });
    }
  }
);

// Facebook Campaigns route
// REATIVADO: Agora disponível com o sistema de integração comercial
// Facebook Campaigns route - COM CACHE (15 minutos)
app.get("/api/facebook/campaigns", authenticateToken, async (req, res) => {
  try {
    const { ad_account_id } = req.query;

    if (!ad_account_id) {
      return res.status(400).json({ error: "ad_account_id is required" });
    }

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    // ✅ CACHE: Campanhas não mudam com tanta frequência
    // Cache por ad_account_id e user_id
    const cacheKey = generateCacheKey("fb_campaigns", {
      ad_account_id,
      user_id: req.user.id,
    });

    console.log(`[campaigns] Cache key: ${cacheKey}`);

    // ✅ Envolver a chamada da API com cache (tipo 'medium' = 15 minutos)
    const campaignsRes = await cachedRequest("medium", cacheKey, async () => {
      console.log(
        `[campaigns] Fetching campaigns from Facebook API for account: ${ad_account_id}`
      );
      return await axios.get(
        `https://graph.facebook.com/v18.0/${ad_account_id}/campaigns`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields:
              "id,name,status,objective,created_time,updated_time,start_time,stop_time,daily_budget,lifetime_budget,budget_remaining,bid_strategy,attribution_spec",
          },
        }
      );
    });

    // ✅ Adicionar info de cache na resposta
    res.json({
      ...campaignsRes.data,
      _cache_info: {
        cached: campaignsRes._cached || false,
        cache_type: campaignsRes._cacheType || "none",
        cache_timestamp: campaignsRes._cacheTimestamp || null,
      },
    });
  } catch (error) {
    console.error("Error fetching Campaigns:", error);
    if (error.response?.status === 401) {
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      return res.status(401).json({ error: "Facebook token expired" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook Ad Sets route
// REATIVADO: Agora disponível com o sistema de integração comercial
app.get("/api/facebook/adsets", authenticateToken, async (req, res) => {
  try {
    const { campaign_id } = req.query;

    if (!campaign_id) {
      return res.status(400).json({ error: "campaign_id is required" });
    }

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const adsetsRes = await axios.get(
      `https://graph.facebook.com/v18.0/${campaign_id}/adsets`,
      {
        params: {
          access_token: user.facebook_access_token,
          fields:
            "id,name,status,created_time,updated_time,start_time,end_time,daily_budget,lifetime_budget,budget_remaining,targeting",
        },
      }
    );

    res.json(adsetsRes.data);
  } catch (error) {
    console.error("Error fetching Ad Sets:", error);
    if (error.response?.status === 401) {
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      return res.status(401).json({ error: "Facebook token expired" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook Ads route
// REATIVADO: Agora disponível com o sistema de integração comercial
app.get("/api/facebook/ads", authenticateToken, async (req, res) => {
  try {
    const { adset_id } = req.query;

    if (!adset_id) {
      return res.status(400).json({ error: "adset_id is required" });
    }

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const adsRes = await axios.get(
      `https://graph.facebook.com/v18.0/${adset_id}/ads`,
      {
        params: {
          access_token: user.facebook_access_token,
          fields: "id,name,status,created_time,updated_time,creative",
        },
      }
    );

    res.json(adsRes.data);
  } catch (error) {
    console.error("Error fetching Ads:", error);
    if (error.response?.status === 401) {
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      return res.status(401).json({ error: "Facebook token expired" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook Pixels route
// REATIVADO: Agora disponível com o sistema de integração comercial
app.get("/api/facebook/pixels", authenticateToken, async (req, res) => {
  try {
    const { ad_account_id } = req.query;

    if (!ad_account_id) {
      return res.status(400).json({ error: "ad_account_id is required" });
    }

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const pixelsRes = await axios.get(
      `https://graph.facebook.com/v18.0/${ad_account_id}/adspixels`,
      {
        params: {
          access_token: user.facebook_access_token,
          fields: "id,name,creation_time,last_fired_time,code",
        },
      }
    );

    res.json(pixelsRes.data);
  } catch (error) {
    console.error("Error fetching Pixels:", error);
    if (error.response?.status === 401) {
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      return res.status(401).json({ error: "Facebook token expired" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Facebook Insights route (Campaign performance)
// REATIVADO: Agora disponível com o sistema de integração comercial
// Facebook Insights route - COM CACHE INTELIGENTE (30 minutos)
// Cache varia conforme o período de dados solicitado
app.get("/api/facebook/insights", authenticateToken, async (req, res) => {
  try {
    const {
      object_id,
      level = "campaign",
      date_preset = "today",
      since,
      until,
    } = req.query;

    console.log("\n=== FACEBOOK INSIGHTS REQUEST ===");
    console.log("Request params:", {
      object_id,
      level,
      date_preset,
      since,
      until,
      user_id: req.user.id,
    });
    console.log("Request timestamp:", new Date().toISOString());

    if (!object_id) {
      return res.status(400).json({ error: "object_id is required" });
    }

    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      console.log("❌ Facebook not connected for user:", req.user.id);
      return res.status(401).json({ error: "Facebook not connected" });
    }

    console.log(
      "✅ User has Facebook token (length:",
      user.facebook_access_token.length,
      ")"
    );

    // ✅ CACHE INTELIGENTE: Chave única por object_id, level, date_preset, since, until
    const cacheKey = generateCacheKey("fb_insights", {
      object_id,
      level,
      date_preset,
      since: since || null,
      until: until || null,
      user_id: req.user.id,
    });

    console.log(`[insights] Cache key: ${cacheKey}`);

    // Montar parâmetros com suporte a date_preset OU time_range (since/until)
    const fbParams = {
      access_token: user.facebook_access_token,
      level: level,
      fields:
        "impressions,clicks,spend,reach,frequency,cpm,cpc,ctr,cost_per_result,results,inline_link_clicks,inline_link_click_ctr,actions,action_values,conversions,conversion_values,purchase_roas,website_purchase_roas",
    };

    if (since && until) {
      fbParams.time_range = JSON.stringify({ since, until });
      console.log("📅 Using time_range:", fbParams.time_range);
    } else {
      fbParams.date_preset = date_preset;
      console.log("📅 Using date_preset:", fbParams.date_preset);
    }

    console.log("📤 Facebook API params:", {
      ...fbParams,
      access_token: "[HIDDEN]",
    });

    // ✅ Envolver a chamada com cache (tipo 'insights' = 30 minutos)
    // Insights são dados de métricas que não mudam constantemente
    const insightsRes = await cachedRequest("insights", cacheKey, async () => {
      console.log(
        "🔗 Making Facebook API request to:",
        `https://graph.facebook.com/v18.0/${object_id}/insights`
      );

      return await axios.get(
        `https://graph.facebook.com/v18.0/${object_id}/insights`,
        { params: fbParams }
      );
    });

    console.log("✅ Facebook Insights response received successfully");
    console.log("📊 Data count:", insightsRes.data?.data?.length || 0);
    console.log("=== END FACEBOOK INSIGHTS REQUEST ===\n");

    // ✅ Calcular métricas adicionais (ROI, ROAS, etc)
    const enhancedData = insightsRes.data.data?.map(insight => {
      const spend = parseFloat(insight.spend || 0);
      const clicks = parseInt(insight.clicks || 0);
      const impressions = parseInt(insight.impressions || 0);

      // Extrair valor de conversões se houver
      let conversionValue = 0;
      let conversions = 0;

      // Procurar por purchase/conversão em actions
      if (insight.actions) {
        const purchaseAction = insight.actions.find(a =>
          a.action_type === 'purchase' ||
          a.action_type === 'offsite_conversion.fb_pixel_purchase'
        );
        if (purchaseAction) {
          conversions = parseInt(purchaseAction.value || 0);
        }
      }

      // Procurar valor em action_values
      if (insight.action_values) {
        const purchaseValue = insight.action_values.find(a =>
          a.action_type === 'purchase' ||
          a.action_type === 'offsite_conversion.fb_pixel_purchase'
        );
        if (purchaseValue) {
          conversionValue = parseFloat(purchaseValue.value || 0);
        }
      }

      // Calcular métricas customizadas
      const customMetrics = {
        // Cost per click (já vem da API, mas recalcular se necessário)
        cpc_calculated: clicks > 0 ? (spend / clicks).toFixed(6) : null,

        // Cost per thousand impressions (já vem da API)
        cpm_calculated: impressions > 0 ? ((spend / impressions) * 1000).toFixed(6) : null,

        // ROAS (Return on Ad Spend) - quanto de receita por real gasto
        roas: conversionValue > 0 && spend > 0 ? (conversionValue / spend).toFixed(2) : null,

        // ROI (Return on Investment) - porcentagem de lucro
        roi_percentage: conversionValue > 0 && spend > 0
          ? (((conversionValue - spend) / spend) * 100).toFixed(2)
          : null,

        // Profit (Lucro)
        profit: conversionValue > 0 ? (conversionValue - spend).toFixed(2) : null,

        // Cost per conversion
        cost_per_conversion: conversions > 0 ? (spend / conversions).toFixed(2) : null,

        // Conversion rate (baseado em clicks)
        conversion_rate: clicks > 0 && conversions > 0
          ? ((conversions / clicks) * 100).toFixed(2)
          : null,

        // Métricas de resumo
        _summary: {
          total_spend: spend.toFixed(2),
          total_revenue: conversionValue.toFixed(2),
          total_conversions: conversions,
          has_conversion_data: conversions > 0,
        }
      };

      return {
        ...insight,
        ...customMetrics
      };
    });

    // ✅ Adicionar info de cache na resposta
    res.json({
      ...insightsRes.data,
      data: enhancedData || insightsRes.data.data,
      _cache_info: {
        cached: insightsRes._cached || false,
        cache_type: insightsRes._cacheType || "none",
        cache_timestamp: insightsRes._cacheTimestamp || null,
      },
    });
  } catch (error) {
    console.log("\n❌ === FACEBOOK INSIGHTS ERROR ===");
    console.error("🔍 Full error object:", {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
    });

    // Log detalhado do erro da API do Facebook
    if (error.response?.data?.error) {
      const fbError = error.response.data.error;
      console.error("🚨 Facebook API Error Details:");
      console.error("   - Code:", fbError.code);
      console.error("   - Type:", fbError.type);
      console.error("   - Message:", fbError.message);
      console.error("   - Subcode:", fbError.error_subcode);
      console.error("   - User Title:", fbError.error_user_title);
      console.error("   - User Message:", fbError.error_user_msg);

      // Verificar diferentes tipos de erro de token/permissão
      const isTokenExpired =
        error.response?.status === 401 ||
        (fbError.type === "OAuthException" &&
          (fbError.code === 190 || // Invalid OAuth access token
            fbError.code === 102 || // Session key invalid
            fbError.message.includes("token") ||
            fbError.message.includes("access_token")));

      const isInvalidFieldError =
        fbError.code === 100 &&
        (fbError.message.includes("is not valid for fields param") ||
          fbError.message.includes("Invalid field"));

      const isPermissionError =
        fbError.code === 100 &&
        (fbError.message.includes("Missing Permission") ||
          fbError.message.includes("Insufficient Permission") ||
          fbError.message.includes("ads_read"));

      const isRateLimited =
        fbError.code === 17 || // User request limit reached
        fbError.code === 4 || // Application request limit reached
        fbError.code === 613; // Calls to this api have exceeded the rate limit

      console.error("🔍 Error Classification:");
      console.error("   - Is Token Expired:", isTokenExpired);
      console.error("   - Is Permission Error:", isPermissionError);
      console.error("   - Is Rate Limited:", isRateLimited);
      console.error("   - Is Invalid Field Error:", isInvalidFieldError);

      if (isInvalidFieldError) {
        console.error(
          "⚠️ Invalid field error detected - this is a configuration issue, not a token problem"
        );
        console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
        return res.status(400).json({
          error: "Invalid field in Facebook API request",
          details: fbError.message,
          code: fbError.code,
          type: "configuration_error",
        });
      }

      if (isTokenExpired) {
        console.error(
          "🔄 Clearing expired Facebook token for user:",
          req.user.id
        );
        await dbRun(
          "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
          [req.user.id]
        );
        console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
        return res.status(401).json({
          error: "Facebook token expired",
          details: fbError.message,
          code: fbError.code,
          type: fbError.type,
        });
      }

      if (isPermissionError) {
        console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
        return res.status(403).json({
          error: "Missing Facebook permissions",
          message:
            "Please reconnect your Facebook account with proper permissions (ads_read required)",
          facebook_error: fbError.message,
          code: fbError.code,
        });
      }

      if (isRateLimited) {
        console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
        return res.status(429).json({
          error: "Facebook API rate limit exceeded",
          message: "Please try again later",
          facebook_error: fbError.message,
          code: fbError.code,
        });
      }

      // Outros erros específicos da API do Facebook
      console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
      return res.status(400).json({
        error: "Facebook API Error",
        message: fbError.message,
        code: fbError.code,
        type: fbError.type,
        subcode: fbError.error_subcode,
      });
    }

    // Fallback para erros HTTP sem detalhes da API
    if (error.response?.status === 401) {
      console.error(
        "🔄 HTTP 401 - Clearing Facebook token for user:",
        req.user.id
      );
      await dbRun(
        "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
        [req.user.id]
      );
      console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
      return res.status(401).json({ error: "Facebook token expired" });
    }

    console.error("🚨 Unexpected error:", error.message);
    console.log("=== END FACEBOOK INSIGHTS ERROR ===\n");
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// Facebook complete dashboard data route
app.get("/api/facebook/dashboard", authenticateToken, async (req, res) => {
  try {
    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const accessToken = user.facebook_access_token;
    const dashboardData = {};

    try {
      // Get user profile
      const profileRes = await axios.get(
        `https://graph.facebook.com/v18.0/me`,
        {
          params: {
            access_token: accessToken,
            fields: "id,name,email,picture.width(200).height(200)",
          },
        }
      );
      dashboardData.profile = profileRes.data;

      // REATIVADO: Get business accounts - Agora disponível com permissão business_management
      try {
        const businessRes = await axios.get(
          `https://graph.facebook.com/v18.0/me/businesses`,
          {
            params: {
              access_token: accessToken,
              fields:
                "id,name,verification_status,profile_picture_uri,timezone_id",
            },
          }
        );
        dashboardData.businesses = businessRes.data.data || [];
      } catch (businessError) {
        console.log(
          "Error fetching businesses:",
          businessError.response?.data?.error?.message || businessError.message
        );
        dashboardData.businesses = [];
        dashboardData.businessError =
          businessError.response?.data?.error?.message ||
          "Error fetching business accounts";
      }

      // REATIVADO: Get ad accounts - Agora disponível com o sistema de integração comercial
      try {
        const adAccountsRes = await axios.get(
          `https://graph.facebook.com/v18.0/me/adaccounts`,
          {
            params: {
              access_token: accessToken,
              fields: "id,name,account_status,currency,amount_spent,balance",
            },
          }
        );
        dashboardData.adAccounts = adAccountsRes.data.data || [];
      } catch (adAccountError) {
        console.log(
          "Error fetching ad accounts:",
          adAccountError.response?.data?.error?.message ||
            adAccountError.message
        );
        dashboardData.adAccounts = [];
        dashboardData.adAccountsError =
          adAccountError.response?.data?.error?.message ||
          "Error fetching ad accounts";
      }

      // REATIVADO: Get campaigns - Agora disponível com o sistema de integração comercial
      if (dashboardData.adAccounts.length > 0) {
        const firstAdAccount = dashboardData.adAccounts[0];
        try {
          const campaignsRes = await axios.get(
            `https://graph.facebook.com/v18.0/${firstAdAccount.id}/campaigns`,
            {
              params: {
                access_token: accessToken,
                fields: "id,name,status,objective",
                limit: 10,
              },
            }
          );
          dashboardData.recentCampaigns = campaignsRes.data.data || [];
        } catch (campaignError) {
          console.log("Error fetching campaigns:", campaignError.message);
          dashboardData.recentCampaigns = [];
          dashboardData.campaignsError =
            campaignError.response?.data?.error?.message ||
            "Error fetching campaigns";
        }
      } else {
        dashboardData.recentCampaigns = [];
        dashboardData.campaignsError = "No ad accounts available";
      }

      res.json(dashboardData);
    } catch (apiError) {
      // Check for specific Facebook API errors
      if (apiError.response?.data?.error) {
        const fbError = apiError.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          apiError.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      throw apiError;
    }
  } catch (error) {
    console.error("Error fetching Facebook dashboard:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Debug middleware specifically for login route
app.use("/api/auth/login", (req, res, next) => {
  console.log("=== LOGIN ROUTE DEBUG ===");
  console.log("Method:", req.method);
  console.log("URL:", req.url);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("========================");
  next();
});

// Health check route - compatible with frontend
// app.get('/api/health', (_req, res) => {
//   res.json({ status: 'OK', timestamp: new Date().toISOString() });
// });

// // Verify token route - compatible with frontend
// app.get('/api/verify-token', authenticateToken, async (req, res) => {
//   try {
//     const user = await dbGet(
//       'SELECT id, username, email FROM users WHERE id = ?',
//       [req.user.id]
//     );

//     if (!user) {
//       return res.status(404).json({ error: 'User not found' });
//     }

//     res.json({
//       valid: true,
//       user: {
//         id: user.id,
//         username: user.username,
//         email: user.email
//       }
//     });
//   } catch (error) {
//     console.error('Verify token error:', error);
//     res.status(500).json({ error: 'Internal server error' });
//   }
// });

// Facebook Pages Management routes
// Lista todas as páginas que o usuário gerencia
app.get("/api/facebook/pages", authenticateToken, async (req, res) => {
  try {
    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const pagesRes = await axios.get(
      `https://graph.facebook.com/v18.0/me/accounts`,
      {
        params: {
          access_token: user.facebook_access_token,
          fields:
            "id,name,category,category_list,about,description,website,phone,emails,fan_count,followers_count,picture,cover,access_token,tasks",
        },
      }
    );

    res.json(pagesRes.data);
  } catch (error) {
    console.error("Error fetching Facebook pages:", error);

    if (error.response?.data?.error) {
      const fbError = error.response.data.error;

      if (
        fbError.code === 100 &&
        fbError.message.includes("Missing Permission")
      ) {
        return res.status(403).json({
          error: "Missing Facebook permissions",
          message:
            "Please reconnect your Facebook account with proper permissions",
          facebook_error: fbError.message,
        });
      }

      if (error.response?.status === 401 || fbError.type === "OAuthException") {
        await dbRun(
          "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
          [req.user.id]
        );
        return res.status(401).json({ error: "Facebook token expired" });
      }
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// Obtém detalhes de uma página específica
app.get("/api/facebook/pages/:pageId", authenticateToken, async (req, res) => {
  try {
    const { pageId } = req.params;
    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    const pageRes = await axios.get(
      `https://graph.facebook.com/v18.0/${pageId}`,
      {
        params: {
          access_token: user.facebook_access_token,
          fields:
            "id,name,category,category_list,about,description,website,phone,emails,fan_count,followers_count,picture,cover,location,hours,price_range,payment_options,parking,public_transit,restaurant_services,restaurant_specialties,general_info,mission,company_overview,products,awards,built,founded,impressum,personal_info,personal_interests,members,bio,affiliation,birthday,hometown,current_location,relationship_status,religion,political,quotes,sports,favorite_athletes,favorite_teams,inspirational_people,languages,work,education,checkins,link,username,verification_status,voip_info,whatsapp_number,instagram_business_account,is_webhooks_subscribed,is_community_page,is_eligible_for_branded_content,is_messenger_bot_get_started_enabled,is_messenger_platform_bot,is_owned,is_permanently_closed,is_published,is_unclaimed,is_verified,overall_star_rating,rating_count,new_like_count,talking_about_count,were_here_count,access_token",
        },
      }
    );

    res.json(pageRes.data);
  } catch (error) {
    console.error("Error fetching Facebook page details:", error);

    if (error.response?.data?.error) {
      const fbError = error.response.data.error;

      if (
        fbError.code === 100 &&
        fbError.message.includes("Missing Permission")
      ) {
        return res.status(403).json({
          error: "Missing Facebook permissions",
          message:
            "Please reconnect your Facebook account with proper permissions",
          facebook_error: fbError.message,
        });
      }

      if (error.response?.status === 401 || fbError.type === "OAuthException") {
        await dbRun(
          "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
          [req.user.id]
        );
        return res.status(401).json({ error: "Facebook token expired" });
      }
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// Obtém posts de uma página
app.get(
  "/api/facebook/pages/:pageId/posts",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { limit = 25, since, until } = req.query;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const params = {
        access_token: user.facebook_access_token,
        fields:
          "id,message,story,created_time,updated_time,type,status_type,object_id,link,name,caption,description,source,place,tags,with_tags,properties,icon,actions,privacy,targeting,feed_targeting,timeline_visibility,is_hidden,is_published,is_spherical,is_eligible_for_promotion,is_expired,is_inline_created,is_instagram_eligible,is_popular,permalink_url,picture,full_picture,attachments,likes.summary(true),comments.summary(true),shares,reactions.summary(true)",
        limit: parseInt(limit),
      };

      if (since) params.since = since;
      if (until) params.until = until;

      const postsRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}/posts`,
        { params }
      );

      res.json(postsRes.data);
    } catch (error) {
      console.error("Error fetching Facebook page posts:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Cria um novo post em uma página
app.post(
  "/api/facebook/pages/:pageId/posts",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const {
        message,
        link,
        picture,
        name,
        caption,
        description,
        published = true,
      } = req.body;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      // Primeiro, obter o access token da página
      const pageTokenRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "access_token",
          },
        }
      );

      const pageAccessToken = pageTokenRes.data.access_token;
      if (!pageAccessToken) {
        return res
          .status(403)
          .json({ error: "No access token available for this page" });
      }

      const postData = {
        access_token: pageAccessToken,
        published: published,
      };

      if (message) postData.message = message;
      if (link) postData.link = link;
      if (picture) postData.picture = picture;
      if (name) postData.name = name;
      if (caption) postData.caption = caption;
      if (description) postData.description = description;

      const postRes = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/feed`,
        postData
      );

      res.json(postRes.data);
    } catch (error) {
      console.error("Error creating Facebook page post:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Obtém insights/métricas de uma página
app.get(
  "/api/facebook/pages/:pageId/insights",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { metric, period = "day", since, until } = req.query;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const params = {
        access_token: user.facebook_access_token,
        metric:
          metric ||
          "page_fans,page_impressions,page_engaged_users,page_post_engagements,page_posts_impressions,page_video_views",
        period: period,
      };

      if (since) params.since = since;
      if (until) params.until = until;

      const insightsRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}/insights`,
        { params }
      );

      res.json(insightsRes.data);
    } catch (error) {
      console.error("Error fetching Facebook page insights:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Obtém comentários de um post específico
app.get(
  "/api/facebook/posts/:postId/comments",
  authenticateToken,
  async (req, res) => {
    try {
      const { postId } = req.params;
      const { limit = 25 } = req.query;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const commentsRes = await axios.get(
        `https://graph.facebook.com/v18.0/${postId}/comments`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields:
              "id,message,created_time,from,like_count,comment_count,user_likes,attachment,parent",
            limit: parseInt(limit),
          },
        }
      );

      res.json(commentsRes.data);
    } catch (error) {
      console.error("Error fetching post comments:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Cria um comentário em um post
app.post(
  "/api/facebook/posts/:postId/comments",
  authenticateToken,
  async (req, res) => {
    try {
      const { postId } = req.params;
      const { message } = req.body;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      const commentRes = await axios.post(
        `https://graph.facebook.com/v18.0/${postId}/comments`,
        {
          message: message,
          access_token: user.facebook_access_token,
        }
      );

      res.json(commentRes.data);
    } catch (error) {
      console.error("Error creating comment:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Deleta um comentário
app.delete(
  "/api/facebook/comments/:commentId",
  authenticateToken,
  async (req, res) => {
    try {
      const { commentId } = req.params;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      await axios.delete(`https://graph.facebook.com/v18.0/${commentId}`, {
        params: {
          access_token: user.facebook_access_token,
        },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting comment:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Obtém CTAs (Call-to-Action) de uma página
app.get(
  "/api/facebook/pages/:pageId/cta",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const ctaRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}/call_to_actions`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields:
              "id,type,status,created_time,updated_time,web_url,phone_number,email_address,intl_number_with_plus",
          },
        }
      );

      res.json(ctaRes.data);
    } catch (error) {
      console.error("Error fetching page CTAs:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Cria um CTA para uma página
app.post(
  "/api/facebook/pages/:pageId/cta",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { type, web_url, phone_number, email_address } = req.body;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      if (!type) {
        return res.status(400).json({ error: "CTA type is required" });
      }

      // Primeiro, obter o access token da página
      const pageTokenRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "access_token",
          },
        }
      );

      const pageAccessToken = pageTokenRes.data.access_token;
      if (!pageAccessToken) {
        return res
          .status(403)
          .json({ error: "No access token available for this page" });
      }

      const ctaData = {
        type: type,
        access_token: pageAccessToken,
      };

      if (web_url) ctaData.web_url = web_url;
      if (phone_number) ctaData.phone_number = phone_number;
      if (email_address) ctaData.email_address = email_address;

      const ctaRes = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/call_to_actions`,
        ctaData
      );

      res.json(ctaRes.data);
    } catch (error) {
      console.error("Error creating page CTA:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Deleta um CTA
app.delete("/api/facebook/cta/:ctaId", authenticateToken, async (req, res) => {
  try {
    const { ctaId } = req.params;
    const user = await dbGet(
      "SELECT facebook_access_token FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!user || !user.facebook_access_token) {
      return res.status(401).json({ error: "Facebook not connected" });
    }

    await axios.delete(`https://graph.facebook.com/v18.0/${ctaId}`, {
      params: {
        access_token: user.facebook_access_token,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting CTA:", error);

    if (error.response?.data?.error) {
      const fbError = error.response.data.error;

      if (
        fbError.code === 100 &&
        fbError.message.includes("Missing Permission")
      ) {
        return res.status(403).json({
          error: "Missing Facebook permissions",
          message:
            "Please reconnect your Facebook account with proper permissions",
          facebook_error: fbError.message,
        });
      }

      if (error.response?.status === 401 || fbError.type === "OAuthException") {
        await dbRun(
          "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
          [req.user.id]
        );
        return res.status(401).json({ error: "Facebook token expired" });
      }
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

// Configura eventos de página (page_events)
app.post(
  "/api/facebook/pages/:pageId/events",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { event_name, event_data, test_event_code } = req.body;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      if (!event_name) {
        return res.status(400).json({ error: "Event name is required" });
      }

      // Primeiro, obter o access token da página
      const pageTokenRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "access_token",
          },
        }
      );

      const pageAccessToken = pageTokenRes.data.access_token;
      if (!pageAccessToken) {
        return res
          .status(403)
          .json({ error: "No access token available for this page" });
      }

      const eventPayload = {
        data: [
          {
            event_name: event_name,
            event_time: Math.floor(Date.now() / 1000),
            custom_data: event_data || {},
          },
        ],
        access_token: pageAccessToken,
      };

      if (test_event_code) {
        eventPayload.test_event_code = test_event_code;
      }

      const eventRes = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/events`,
        eventPayload
      );

      res.json(eventRes.data);
    } catch (error) {
      console.error("Error sending page event:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Obtém conversas do Messenger de uma página
app.get(
  "/api/facebook/pages/:pageId/conversations",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { limit = 25 } = req.query;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      // Primeiro, obter o access token da página
      const pageTokenRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "access_token",
          },
        }
      );

      const pageAccessToken = pageTokenRes.data.access_token;
      if (!pageAccessToken) {
        return res
          .status(403)
          .json({ error: "No access token available for this page" });
      }

      const conversationsRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}/conversations`,
        {
          params: {
            access_token: pageAccessToken,
            fields:
              "id,snippet,updated_time,message_count,unread_count,participants,senders,can_reply,is_subscribed",
            limit: parseInt(limit),
          },
        }
      );

      res.json(conversationsRes.data);
    } catch (error) {
      console.error("Error fetching page conversations:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Obtém mensagens de uma conversa específica
app.get(
  "/api/facebook/conversations/:conversationId/messages",
  authenticateToken,
  async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { limit = 25 } = req.query;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      const messagesRes = await axios.get(
        `https://graph.facebook.com/v18.0/${conversationId}/messages`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "id,message,from,to,created_time,attachments,sticker,tags",
            limit: parseInt(limit),
          },
        }
      );

      res.json(messagesRes.data);
    } catch (error) {
      console.error("Error fetching conversation messages:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Envia uma mensagem via Messenger
app.post(
  "/api/facebook/pages/:pageId/messages",
  authenticateToken,
  async (req, res) => {
    try {
      const { pageId } = req.params;
      const { recipient_id, message_text, attachment_url, attachment_type } =
        req.body;
      const user = await dbGet(
        "SELECT facebook_access_token FROM users WHERE id = ?",
        [req.user.id]
      );

      if (!user || !user.facebook_access_token) {
        return res.status(401).json({ error: "Facebook not connected" });
      }

      if (!recipient_id || (!message_text && !attachment_url)) {
        return res.status(400).json({
          error: "Recipient ID and message text or attachment are required",
        });
      }

      // Primeiro, obter o access token da página
      const pageTokenRes = await axios.get(
        `https://graph.facebook.com/v18.0/${pageId}`,
        {
          params: {
            access_token: user.facebook_access_token,
            fields: "access_token",
          },
        }
      );

      const pageAccessToken = pageTokenRes.data.access_token;
      if (!pageAccessToken) {
        return res
          .status(403)
          .json({ error: "No access token available for this page" });
      }

      const messageData = {
        recipient: {
          id: recipient_id,
        },
        access_token: pageAccessToken,
      };

      if (message_text) {
        messageData.message = {
          text: message_text,
        };
      } else if (attachment_url) {
        messageData.message = {
          attachment: {
            type: attachment_type || "image",
            payload: {
              url: attachment_url,
              is_reusable: true,
            },
          },
        };
      }

      const messageRes = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/messages`,
        messageData
      );

      res.json(messageRes.data);
    } catch (error) {
      console.error("Error sending message:", error);

      if (error.response?.data?.error) {
        const fbError = error.response.data.error;

        if (
          fbError.code === 100 &&
          fbError.message.includes("Missing Permission")
        ) {
          return res.status(403).json({
            error: "Missing Facebook permissions",
            message:
              "Please reconnect your Facebook account with proper permissions",
            facebook_error: fbError.message,
          });
        }

        if (
          error.response?.status === 401 ||
          fbError.type === "OAuthException"
        ) {
          await dbRun(
            "UPDATE users SET facebook_access_token = NULL, facebook_user_id = NULL WHERE id = ?",
            [req.user.id]
          );
          return res.status(401).json({ error: "Facebook token expired" });
        }
      }

      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Pixel configuration routes
app.get("/api/pixel-configs", authenticateToken, async (req, res) => {
  try {
    const configs = await dbAll(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, created_at as createdAt FROM pixel_configs ORDER BY created_at DESC"
    );
    res.json(configs);
  } catch (error) {
    console.error("Error fetching pixel configs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/pixel-configs", authenticateToken, async (req, res) => {
  const { name, pixelId, accessToken } = req.body;

  try {
    const result = await dbRun(
      "INSERT INTO pixel_configs (name, pixel_id, access_token) VALUES (?, ?, ?)",
      [name, pixelId, accessToken]
    );

    const newConfig = await dbGet(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, created_at as createdAt FROM pixel_configs WHERE id = ?",
      [result.lastID]
    );

    res.status(201).json(newConfig);
  } catch (error) {
    console.error("Error creating pixel config:", error);
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/pixel-configs/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, pixelId, accessToken } = req.body;

  try {
    await dbRun(
      "UPDATE pixel_configs SET name = ?, pixel_id = ?, access_token = ? WHERE id = ?",
      [name, pixelId, accessToken, id]
    );

    const updatedConfig = await dbGet(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, created_at as createdAt FROM pixel_configs WHERE id = ?",
      [id]
    );

    if (!updatedConfig) {
      return res.status(404).json({ error: "Pixel configuration not found" });
    }

    res.json(updatedConfig);
  } catch (error) {
    console.error("Error updating pixel config:", error);
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/pixel-configs/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await dbRun("DELETE FROM pixel_configs WHERE id = ?", [id]);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Pixel configuration not found" });
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting pixel config:", error);
    res.status(400).json({ error: error.message });
  }
});

// Facebook configuration routes
app.get("/api/facebook-configs", authenticateToken, async (req, res) => {
  try {
    const configs = await dbAll(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, test_event_code as testEventCode, app_id as appId, external_id as externalId, created_at as createdAt FROM facebook_configs ORDER BY created_at DESC"
    );
    res.json(configs);
  } catch (error) {
    console.error("Error fetching Facebook configs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/facebook-configs", authenticateToken, async (req, res) => {
  const { name, pixelId, accessToken, testEventCode, appId, externalId } =
    req.body;

  try {
    const result = await dbRun(
      "INSERT INTO facebook_configs (name, pixel_id, access_token, test_event_code, app_id, external_id) VALUES (?, ?, ?, ?, ?, ?)",
      [
        name,
        pixelId,
        accessToken,
        testEventCode || null,
        appId || null,
        externalId || null,
      ]
    );

    const newConfig = await dbGet(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, test_event_code as testEventCode, app_id as appId, external_id as externalId, created_at as createdAt FROM facebook_configs WHERE id = ?",
      [result.lastID]
    );

    res.status(201).json(newConfig);
  } catch (error) {
    console.error("Error creating Facebook config:", error);
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/facebook-configs/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, pixelId, accessToken, testEventCode, appId, externalId } =
    req.body;

  try {
    await dbRun(
      "UPDATE facebook_configs SET name = ?, pixel_id = ?, access_token = ?, test_event_code = ?, app_id = ?, external_id = ? WHERE id = ?",
      [
        name,
        pixelId,
        accessToken,
        testEventCode || null,
        appId || null,
        externalId || null,
        id,
      ]
    );

    const updatedConfig = await dbGet(
      "SELECT id, name, pixel_id as pixelId, access_token as accessToken, test_event_code as testEventCode, app_id as appId, external_id as externalId, created_at as createdAt FROM facebook_configs WHERE id = ?",
      [id]
    );

    if (!updatedConfig) {
      return res
        .status(404)
        .json({ error: "Facebook configuration not found" });
    }

    res.json(updatedConfig);
  } catch (error) {
    console.error("Error updating Facebook config:", error);
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/facebook-configs/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await dbRun("DELETE FROM facebook_configs WHERE id = ?", [
      id,
    ]);

    if (result.changes === 0) {
      return res
        .status(404)
        .json({ error: "Facebook configuration not found" });
    }

    res.status(204).send();
  } catch (error) {
    console.error("Error deleting Facebook config:", error);
    res.status(400).json({ error: error.message });
  }
});

// Event logs routes
app.get("/api/event-logs", authenticateToken, async (req, res) => {
  const { pixelId, eventType, startDate, endDate } = req.query;

  let query =
    "SELECT id, pixel_id as pixelId, event_type as eventType, kwai_click_id as kwaiClickId, timestamp, action_params as actionParams, status, error_message as errorMessage FROM event_logs";
  const params = [];

  // Build the WHERE clause based on the filters
  const conditions = [];

  if (pixelId) {
    conditions.push("pixel_id = ?");
    params.push(pixelId);
  }

  if (eventType) {
    conditions.push("event_type = ?");
    params.push(eventType);
  }

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("timestamp <= ?");
    params.push(endDate);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY timestamp DESC";

  try {
    const logs = await dbAll(query, params);

    // Parse the action_params string to JSON
    const parsedLogs = logs.map((log) => ({
      ...log,
      actionParams: JSON.parse(log.actionParams),
    }));

    res.json(parsedLogs);
  } catch (error) {
    console.error("Error fetching event logs:", error);
    res.status(500).json({ error: error.message });
  }
});

// Facebook event logs routes
app.get("/api/facebook-logs", authenticateToken, async (req, res) => {
  const { pixelId, eventName, startDate, endDate } = req.query;

  let query =
    "SELECT id, pixel_id as pixelId, event_name as eventName, event_time as eventTime, status, payload, response, error_message as errorMessage, created_at as createdAt FROM facebook_event_logs";
  const params = [];

  // Build the WHERE clause based on the filters
  const conditions = [];

  if (pixelId) {
    conditions.push("pixel_id = ?");
    params.push(pixelId);
  }

  if (eventName) {
    conditions.push("event_name = ?");
    params.push(eventName);
  }

  if (startDate) {
    conditions.push("created_at >= ?");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("created_at <= ?");
    params.push(endDate);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY created_at DESC";

  try {
    const logs = await dbAll(query, params);

    // Parse the payload and response strings to JSON
    const parsedLogs = logs.map((log) => ({
      ...log,
      payload: JSON.parse(log.payload),
      response: log.response ? JSON.parse(log.response) : null,
    }));

    res.json(parsedLogs);
  } catch (error) {
    console.error("Error fetching Facebook logs:", error);
    res.status(500).json({ error: error.message });
  }
});

// Facebook tracking endpoint (public)
app.post("/api/fb-track", async (req, res) => {
  const { pixel_id, event_name, event_time, user_data, custom_data } = req.body;

  if (!pixel_id || !event_name) {
    return res
      .status(400)
      .json({ error: "Missing required fields: pixel_id and event_name" });
  }

  try {
    // Get the access token for the pixel ID
    const fbConfig = await dbGet(
      "SELECT access_token, test_event_code FROM facebook_configs WHERE pixel_id = ?",
      [pixel_id]
    );

    if (!fbConfig) {
      throw new Error("Invalid Facebook pixel ID");
    }

    // Get client info if not provided
    const clientInfo = getClientInfo(req);

    // Prepare user data with automatic hashing
    const processedUserData = { ...user_data };

    // Hash email if provided and not already hashed
    if (processedUserData.em && !processedUserData.em.match(/^[a-f0-9]{64}$/)) {
      processedUserData.em = hashData(processedUserData.em);
    }

    // Hash phone if provided and not already hashed
    if (processedUserData.ph && !processedUserData.ph.match(/^[a-f0-9]{64}$/)) {
      processedUserData.ph = hashData(processedUserData.ph);
    }

    // Add client info if not provided
    if (!processedUserData.client_ip_address) {
      processedUserData.client_ip_address = clientInfo.client_ip_address;
    }

    if (!processedUserData.client_user_agent) {
      processedUserData.client_user_agent = clientInfo.client_user_agent;
    }

    // Prepare the payload for Facebook API
    const fbPayload = {
      data: [
        {
          event_name,
          event_time: event_time || Math.floor(Date.now() / 1000),
          user_data: processedUserData,
          custom_data: custom_data || {},
        },
      ],
    };

    // Add test event code if available
    if (fbConfig.test_event_code) {
      fbPayload.test_event_code = fbConfig.test_event_code;
    }

    // Call the Facebook Conversion API
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${pixel_id}/events`,
      fbPayload,
      {
        headers: {
          Authorization: `Bearer ${fbConfig.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Log the event
    await dbRun(
      "INSERT INTO facebook_event_logs (pixel_id, event_name, event_time, status, payload, response) VALUES (?, ?, ?, ?, ?, ?)",
      [
        pixel_id,
        event_name,
        fbPayload.data[0].event_time,
        "success",
        JSON.stringify(fbPayload),
        JSON.stringify(response.data),
      ]
    );

    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    // Log the failed event
    await dbRun(
      "INSERT INTO facebook_event_logs (pixel_id, event_name, event_time, status, payload, error_message) VALUES (?, ?, ?, ?, ?, ?)",
      [
        pixel_id,
        event_name,
        event_time || Math.floor(Date.now() / 1000),
        "failed",
        JSON.stringify(req.body),
        error.message || "Unknown error",
      ]
    );

    res
      .status(500)
      .json({ error: error.message || "Failed to track Facebook event" });
  }
});

app.post("/api/track", async (req, res) => {
  const { pixel_id, event_type, kwai_click_id, action_params } = req.body;

  if (!pixel_id || !event_type || !kwai_click_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const pixelConfig = await dbGet(
      "SELECT access_token FROM pixel_configs WHERE pixel_id = ?",
      [pixel_id]
    );

    if (!pixelConfig) {
      throw new Error("Invalid pixel ID");
    }

    const timestamp = new Date().toISOString();

    // Prepare the payload for Kwai API
    const kwaiPayload = {
      pixel_id,
      event_type,
      kwai_click_id,
      timestamp,
      action_params: action_params || {},
    };

    // Call the Kwai API (replace with actual Kwai API endpoint)
    const response = await axios.post(
      "https://api.kwai.com/track", // Replace with actual Kwai API endpoint
      kwaiPayload,
      {
        headers: {
          Authorization: `Bearer ${pixelConfig.access_token}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Log the event
    await dbRun(
      "INSERT INTO event_logs (pixel_id, event_type, kwai_click_id, timestamp, action_params, status) VALUES (?, ?, ?, ?, ?, ?)",
      [
        pixel_id,
        event_type,
        kwai_click_id,
        timestamp,
        JSON.stringify(action_params || {}),
        "success",
      ]
    );

    res.status(200).json({ success: true, data: response.data });
  } catch (error) {
    // Log the failed event
    await dbRun(
      "INSERT INTO event_logs (pixel_id, event_type, kwai_click_id, timestamp, action_params, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        pixel_id,
        event_type,
        kwai_click_id,
        new Date().toISOString(),
        JSON.stringify(action_params || {}),
        "failed",
        error.message || "Unknown error",
      ]
    );

    res.status(500).json({ error: error.message || "Failed to track event" });
  }
});

// ===== HISPANOADS API PROXY =====
// Proxy endpoint to protect HispanoAds Bearer token
// ===================================================================
// HISPANOADS ROUTES WITH CACHE (15 minutos)
// ===================================================================

app.get("/api/hispanoads/statistics", authenticateToken, async (req, res) => {
  try {
    console.log("[HispanoAds] Request params:", req.query);

    // Get HispanoAds token from environment
    const hispanoadsToken = process.env.HISPANOADS_API_TOKEN;
    if (!hispanoadsToken) {
      console.error("[HispanoAds] Token not configured in environment");
      return res.status(500).json({ error: "HispanoAds token not configured" });
    }

    // ✅ CACHE: 15 minutos para estatísticas
    const cacheKey = generateCacheKey("hispanoads_stats", {
      ...req.query,
      user_id: req.user.id,
    });

    console.log("[HispanoAds] Cache key:", cacheKey);

    const result = await cachedRequest("medium", cacheKey, async () => {
      console.log("[HispanoAds] ❌ Cache MISS - Calling HispanoAds API...");

      const url = "https://dashboard.hispanoads.es/api/statistics/custom/ma";
      console.log(`[HispanoAds] Making request to: ${url}`);

      const response = await axios.get(url, {
        params: req.query,
        headers: {
          Authorization: `Bearer ${hispanoadsToken}`,
          Accept: "application/json",
        },
        timeout: 1000 * 60,
      });

      console.log("[HispanoAds] Success, status:", response.status);
      console.log(
        "[HispanoAds] Response data count:",
        response.data?.length || 0
      );

      return response;
    });

    console.log(
      "[HispanoAds] ✅ Response sent (cached:",
      result._cached || false,
      ")"
    );

    return res.json({
      success: true,
      data: result.data,
      _cache_info: {
        cached: result._cached || false,
        cache_type: result._cacheType || "none",
        cache_timestamp: result._cacheTimestamp || null,
      },
    });
  } catch (err) {
    console.error("[HispanoAds] Error:", err.message);
    if (err.response) {
      console.error("[HispanoAds] Response status:", err.response.status);
      console.error("[HispanoAds] Response data:", err.response.data);
      return res.status(err.response.status).json({
        success: false,
        error: err.response.data || { error: err.message },
      });
    }

    return res.status(500).json({
      success: false,
      error: { error: err.message },
    });
  }
});

// ===== HISPANOADS API PROXY =====
// Proxy endpoint to protect HispanoAds Bearer token
app.get(
  "/api/hispanoads/redeamplo/statistics",
  authenticateToken,
  async (req, res) => {
    try {
      console.log("[HispanoAds] Request params:", {});

      // Get HispanoAds token from environment
      const hispanoadsToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI4NiwiZW1haWwiOiJnZW55ODE4OEBnbWFpbC5jb20iLCJyb2wiOiJtYV9hbmFseXRpY3MiLCJuYW1lIjoiSnVsaW8gQ8Opc2FyIFRlbsOzcmlvIC0gMiIsImlhdCI6MTc2MTYzMDMxMH0.UEKtwgQgGPHIghBuTFZlcEfI3WpU8tiXFOdE7BWZC38";
      if (!hispanoadsToken) {
        console.error("[HispanoAds] Token not configured in environment");
        return res
          .status(500)
          .json({ error: "HispanoAds token not configured" });
      }

      const url = "https://dashboard.hispanoads.es/api/statistics/custom/ma";

      console.log(`[HispanoAds] Making request to: ${url}`);
      console.log(`[HispanoAds] Params:`, {});

      const response = await axios.get(url, {
        params: req.query,
        headers: {
          Authorization: `Bearer ${hispanoadsToken}`,
          Accept: "application/json",
        },
        timeout: 1000 * 60,
      });

      console.log("[HispanoAds] Success, status:", response.status);
      console.log(
        "[HispanoAds] Response data count:",
        response.data?.length || 0
      );

      return res.json({
        success: true,
        data: response.data,
      });
    } catch (err) {
      console.error("[HispanoAds] Error:", err.message);
      if (err.response) {
        console.error("[HispanoAds] Response status:", err.response.status);
        console.error("[HispanoAds] Response data:", err.response.data);
        return res.status(err.response.status).json({
          success: false,
          error: err.response.data || { error: err.message },
        });
      }

      return res.status(500).json({
        success: false,
        error: { error: err.message },
      });
    }
  }
);

// ===================================================================
// GOOGLE AD MANAGER ROUTES WITH CACHE (15 minutos)
// ===================================================================

// Endpoint que agrega métricas de múltiplas contas
app.get("/api/googleadmanager/statistics", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, dimensionType = "DATE", days } = req.query;
    const userId = req.user.id;

    console.log("[GAM Endpoint] Query params:", { startDate, endDate, dimensionType, days });

    let start = startDate;
    let end = endDate;

    if (days && !startDate && !endDate) {
      end = new Date().toISOString().split("T")[0];
      start = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
    }

    if (!start || !end) {
      end = new Date().toISOString().split("T")[0];
      start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
    }

    console.log("[GAM Endpoint] Using dates:", { start, end });

    // 1. Try persistent data store first (per-day aggregated data)
    const persistentData = await gamDataStore.getDataForRange(userId, start, end, dimensionType);
    if (persistentData) {
      console.log("[GAM] Persistent Store HIT");
      return res.json({
        ...persistentData,
        _cache_info: {
          cached: true,
          cache_type: "persistent_store",
          cache_timestamp: new Date().toISOString(),
        },
      });
    }

    // 2. Try Redis/SQLite cache
    const cachedData = await gamCache.getCachedData(userId, start, end, dimensionType);
    if (cachedData) {
      console.log("[GAM] Cache HIT");
      return res.json({
        ...cachedData,
        _cache_info: {
          cached: true,
          cache_type: "redis_or_sqlite",
          cache_timestamp: new Date().toISOString(),
        },
      });
    }

    gamDataStore.setUserRequestActive(true);
    console.log("[GAM] All caches MISS - Fetching from API with 90s timeout...");

    // 3. Fetch from API as last resort (with 90s timeout to avoid Cloudflare 524)
    const timeoutMs = 90000;
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        gamGetMultiAccountStatistics(req, {
          json: (data) => resolve(data),
          status: (code) => ({
            json: (data) => code >= 400 ? reject(new Error(data.error || 'API Error')) : resolve(data)
          })
        }, db);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: GAM API took too long')), timeoutMs))
    ]);

    // Save to Redis cache
    await gamCache.setCachedData(userId, start, end, dimensionType, result, 300);

    // Save to persistent store if single day
    if (start === end) {
      await gamDataStore.saveDayData(userId, start, dimensionType, result).catch(e => {
        console.error("[GAM] Persistent save error:", e.message);
      });
    }

    gamDataStore.setUserRequestActive(false);
    console.log("[GAM] Data fetched and stored");

    return res.json({
      ...result,
      _cache_info: {
        cached: false,
        cache_type: "fresh",
        cache_timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    gamDataStore.setUserRequestActive(false);
    console.error("[GAM] Error:", error.message);
    if (error.message && error.message.includes('TIMEOUT')) {
      return res.status(504).json({
        success: false,
        error: "GAM API is taking too long. Data will be available once cached. Please try again in a few minutes.",
        data: [],
        timeout: true
      });
    }
    return res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});


// Manual refresh - triggers background re-fetch for a specific date
app.post("/api/googleadmanager/refresh", authenticateToken, async (req, res) => {
  try {
    const { date } = req.body;
    const userId = req.user.id;
    const targetDate = date || new Date().toISOString().split("T")[0];

    if (gamDataStore.isWorkerRunning()) {
      return res.json({
        success: false,
        error: "Worker is already running. Data will be updated shortly.",
        is_refreshing: true,
      });
    }

    // Start refresh in background, respond immediately
    res.json({
      success: true,
      message: "Refresh started for " + targetDate,
      is_refreshing: true,
    });

    // Run refresh in background (don't await)
    gamDataStore.manualRefresh(userId, targetDate, "AD_UNIT").then(result => {
      console.log("[GAM Refresh] Completed:", JSON.stringify(result));
    }).catch(err => {
      console.error("[GAM Refresh] Error:", err.message);
    });

  } catch (error) {
    console.error("[GAM Refresh] Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get refresh status
app.get("/api/googleadmanager/refresh-status", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const info = await gamDataStore.getDataInfo(userId, date, "AD_UNIT");

    res.json({
      success: true,
      is_refreshing: gamDataStore.isWorkerRunning(),
      data_info: info,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/googleadmanager/status", authenticateToken, gamGetConnectionStatus);

// Clear cache for current user
app.post("/api/googleadmanager/cache/clear", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    await gamCache.clearUserCache(userId);

    res.json({
      success: true,
      message: "Cache cleared successfully"
    });
  } catch (error) {
    console.error("[GAM] Clear cache error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get cache statistics
app.get("/api/googleadmanager/cache/stats", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const stats = await gamCache.getCacheStats(userId);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error("[GAM] Cache stats error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================================================
// GOOGLE AD MANAGER OAUTH & ACCOUNT MANAGEMENT
// ===================================================================

// Iniciar fluxo OAuth para conectar conta Google Ad Manager
app.get("/api/googleadmanager/oauth/start", authenticateToken, (req, res) => {
  try {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const redirectUri = `${process.env.BACKEND_URL || 'http://localhost:3003'}/api/googleadmanager/oauth/callback`;

    // Estado para segurança (incluir user_id)
    const state = Buffer.from(JSON.stringify({
      userId: req.user.id,
      timestamp: Date.now()
    })).toString('base64');

    // Scopes necessários para Google Ad Manager
    const scopes = [
      'https://www.googleapis.com/auth/admanager',
      'https://www.googleapis.com/auth/admanager.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' ');

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `state=${state}&` +
      `access_type=offline&` +
      `prompt=consent`;

    res.json({
      success: true,
      authUrl
    });
  } catch (error) {
    console.error("[GAM OAuth] Error starting OAuth flow:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Callback OAuth - recebe código e troca por tokens
app.get("/api/googleadmanager/oauth/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gam_error=${error}`);
    }

    if (!code || !state) {
      throw new Error('Missing code or state parameter');
    }

    // Validar state
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const userId = stateData.userId;

    // Trocar código por tokens
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:3003'}/api/googleadmanager/oauth/callback`,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Buscar informações da conta (network code)
    // Primeiro, buscar email do usuário
    const userInfoResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const userEmail = userInfoResponse.data.email;

    // Buscar networks disponíveis
    const networksResponse = await axios.get('https://admanager.googleapis.com/v1/networks', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const networks = networksResponse.data.networks || [];

    if (networks.length === 0) {
      throw new Error('No Google Ad Manager networks found for this account');
    }

    // Usar o primeiro network ou permitir usuário escolher depois
    const primaryNetwork = networks[0];
    const networkCode = primaryNetwork.networkCode;
    const accountName = primaryNetwork.displayName || userEmail;

    // Extrair currency e timezone do network
    // Se não disponível, usar defaults
    const currencyCode = primaryNetwork.currencyCode || 'USD';
    const timezone = primaryNetwork.timeZone || 'America/New_York';

    console.log(`[GAM OAuth] Network info - Currency: ${currencyCode}, Timezone: ${timezone}`);

    // Salvar no banco
    const tokenExpiry = Date.now() + (expires_in * 1000);

    await dbRun(`
      INSERT INTO google_ad_manager_accounts
      (user_id, account_name, network_code, access_token, refresh_token, token_expiry, currency_code, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, accountName, networkCode, access_token, refresh_token, tokenExpiry, currencyCode, timezone]);

    console.log(`[GAM OAuth] Account connected successfully for user ${userId}`);

    // Redirecionar de volta para o frontend
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gam_success=1`);

  } catch (error) {
    console.error("[GAM OAuth] Callback error:", error.response?.data || error.message);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gam_error=${encodeURIComponent(error.message)}`);
  }
});

// Listar contas Google Ad Manager do usuário
app.get("/api/googleadmanager/accounts", authenticateToken, async (req, res) => {
  try {
    const accounts = await dbAll(
      `SELECT id, account_name, network_code, is_active, currency_code, timezone, created_at
       FROM google_ad_manager_accounts
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      accounts
    });
  } catch (error) {
    console.error("[GAM Accounts] Error fetching accounts:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Remover conta Google Ad Manager
app.delete("/api/googleadmanager/accounts/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se a conta pertence ao usuário
    const account = await dbGet(
      "SELECT id FROM google_ad_manager_accounts WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        error: "Account not found"
      });
    }

    await dbRun(
      "DELETE FROM google_ad_manager_accounts WHERE id = ?",
      [id]
    );

    res.json({
      success: true,
      message: "Account removed successfully"
    });
  } catch (error) {
    console.error("[GAM Accounts] Error removing account:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ativar/Desativar conta
app.patch("/api/googleadmanager/accounts/:id/toggle", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const account = await dbGet(
      "SELECT id, is_active FROM google_ad_manager_accounts WHERE id = ? AND user_id = ?",
      [id, req.user.id]
    );

    if (!account) {
      return res.status(404).json({
        success: false,
        error: "Account not found"
      });
    }

    const newStatus = account.is_active === 1 ? 0 : 1;

    await dbRun(
      "UPDATE google_ad_manager_accounts SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newStatus, id]
    );

    res.json({
      success: true,
      is_active: newStatus
    });
  } catch (error) {
    console.error("[GAM Accounts] Error toggling account:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Limpar cache do Google Ad Manager
app.delete("/api/googleadmanager/cache", authenticateToken, clearGAMCache);

// ===================================================================
// POST METRICS - Sistema SEPARADO para métricas individuais de posts
// ===================================================================

// Cache manager para post metrics
let postMetricsCache = null;

// Flag para indicar se uma busca de post metrics está em andamento
// Evita múltiplas requisições simultâneas ao GAM
let postMetricsFetching = false;

// Inicializar cache manager (será chamado após db estar pronto)
let postMetricsCacheInitialized = false;
async function initPostMetricsCache() {
  if (!postMetricsCache) {
    postMetricsCache = new PostMetricsCacheManager(db);
  }
  // Criar tabela se não existir (só na primeira vez)
  if (!postMetricsCacheInitialized) {
    try {
      await postMetricsCache.initTable();
      postMetricsCacheInitialized = true;
      console.log('[PostMetrics] Cache table initialized');
    } catch (err) {
      console.error('[PostMetrics] Error initializing cache table:', err.message);
    }
  }
  return postMetricsCache;
}

// GET /api/post-metrics/individual - Lista posts com métricas
// Sistema ON-DEMAND: verifica cache primeiro, busca do GAM se necessário
// Cache válido por 30 minutos no SQLite
app.get("/api/post-metrics/individual", authenticateToken, async (req, res) => {
  try {
    // Viewers use admin's data (userId = 1) to share the same metrics
    const userId = req.user.role === 'viewer' ? 1 : req.user.id;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required",
      });
    }

    const cache = await initPostMetricsCache();

    // 1. Verificar cache válido
    const cached = await cache.get(userId, startDate, endDate, 'individual');
    if (cached && cached.length > 0) {
      console.log(`[PostMetrics API] Cache HIT for user ${userId} (${cached.length} posts)`);
      return res.json({
        success: true,
        data: cached,
        totalPosts: cached.length,
        cached: true,
      });
    }

    // 2. Se já tem uma busca em andamento para este usuário, retorna loading
    if (postMetricsFetching) {
      console.log(`[PostMetrics API] Fetch already in progress, returning loading state`);
      return res.json({
        success: true,
        data: [],
        totalPosts: 0,
        cached: false,
        loading: true,
        message: "Buscando dados do Google Ad Manager...",
      });
    }

    // 3. Cache vazio ou expirado - buscar do GAM
    console.log(`[PostMetrics API] Cache MISS for user ${userId}, fetching from GAM...`);
    postMetricsFetching = true;

    try {
      const result = await getMultiAccountPostMetrics(db, userId, {
        startDate: startDate,
        endDate: endDate
      });

      if (result.success && result.data && result.data.length > 0) {
        // Salvar no cache
        await cache.set(userId, startDate, endDate, result.data, 'individual');
        console.log(`[PostMetrics API] Fetched and cached ${result.data.length} posts for user ${userId}`);

        return res.json({
          success: true,
          data: result.data,
          totalPosts: result.data.length,
          cached: false,
          fresh: true,
        });
      }

      // GAM retornou vazio
      console.log(`[PostMetrics API] GAM returned no data for user ${userId}`);
      return res.json({
        success: true,
        data: [],
        totalPosts: 0,
        cached: false,
        message: "Nenhum post com métricas encontrado para o período selecionado.",
      });
    } finally {
      postMetricsFetching = false;
    }
  } catch (error) {
    console.error('[PostMetrics API] Error:', error.message);
    postMetricsFetching = false;
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/post-metrics/by-blog - Agrupa por domínio/blog
// GET /api/post-metrics/by-blog - Agrupa por domínio/blog (APENAS DO CACHE)
app.get("/api/post-metrics/by-blog", authenticateToken, async (req, res) => {
  try {
    // Viewers use admin's data (userId = 1) to share the same metrics
    const userId = req.user.role === 'viewer' ? 1 : req.user.id;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required",
      });
    }

    const cache = await initPostMetricsCache();

    // Apenas retornar do cache
    const cached = await cache.get(userId, startDate, endDate, 'by-blog');
    if (cached && cached.length > 0) {
      return res.json({
        success: true,
        data: cached,
        cached: true,
      });
    }

    // Se não tem cache específico por blog, tenta pegar do individual e agrupar
    const individualCached = await cache.get(userId, startDate, endDate, 'individual');
    if (individualCached && individualCached.length > 0) {
      // Agrupar por domínio
      const byBlog = {};
      individualCached.forEach(post => {
        const domain = post.domain || 'unknown';
        if (!byBlog[domain]) {
          byBlog[domain] = {
            blog: domain,
            posts: [],
            totalImpressions: 0,
            totalClicks: 0,
            totalRevenue: 0,
          };
        }
        byBlog[domain].posts.push(post);
        byBlog[domain].totalImpressions += post.impressions || 0;
        byBlog[domain].totalClicks += post.clicks || 0;
        byBlog[domain].totalRevenue += post.revenue || 0;
      });

      const blogData = Object.values(byBlog).map(blog => ({
        ...blog,
        postCount: blog.posts.length,
        avgEcpm: blog.totalImpressions > 0
          ? parseFloat(((blog.totalRevenue / blog.totalImpressions) * 1000).toFixed(2))
          : 0,
        avgCtr: blog.totalImpressions > 0
          ? parseFloat(((blog.totalClicks / blog.totalImpressions) * 100).toFixed(2))
          : 0,
      }));

      return res.json({
        success: true,
        data: blogData,
        cached: true,
      });
    }

    // Se não tem cache, retorna vazio
    res.json({
      success: true,
      data: [],
      cached: false,
      message: "Cache vazio. Dados serão atualizados em breve.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/post-metrics/top - Top posts por métrica (APENAS DO CACHE)
app.get("/api/post-metrics/top", authenticateToken, async (req, res) => {
  try {
    // Viewers use admin's data (userId = 1) to share the same metrics
    const userId = req.user.role === 'viewer' ? 1 : req.user.id;
    const { startDate, endDate, metric = 'ctr', limit = 20 } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "startDate and endDate are required",
      });
    }

    const validMetrics = ['ecpm', 'ctr', 'viewability', 'impressions', 'revenue', 'clicks'];
    const sortMetric = validMetrics.includes(metric) ? metric : 'ctr';

    const cache = await initPostMetricsCache();

    // Apenas retornar do cache
    const cached = await cache.get(userId, startDate, endDate, 'individual');
    if (!cached || cached.length === 0) {
      return res.json({
        success: true,
        data: [],
        metric: sortMetric,
        total: 0,
        message: "Cache vazio. Dados serão atualizados em breve.",
      });
    }

    // Ordenar por métrica selecionada
    const sorted = [...cached].sort((a, b) => (b[sortMetric] || 0) - (a[sortMetric] || 0));
    const topPosts = sorted.slice(0, parseInt(limit));

    res.json({
      success: true,
      data: topPosts,
      metric: sortMetric,
      total: cached.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// DELETE /api/post-metrics/cache - Limpar cache
app.delete("/api/post-metrics/cache", authenticateToken, async (req, res) => {
  try {
    // Viewers use admin's data (userId = 1) to share the same metrics
    const userId = req.user.role === 'viewer' ? 1 : req.user.id;
    const cache = await initPostMetricsCache();

    const cleared = await cache.clearUserCache(userId);

    res.json({
      success: true,
      message: `Cache cleared: ${cleared} entries removed`,
    });
  } catch (error) {
    console.error("[PostMetrics API] clear cache error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/post-metrics/cache/stats - Estatísticas do cache
app.get("/api/post-metrics/cache/stats", authenticateToken, async (req, res) => {
  try {
    const cache = await initPostMetricsCache();
    const stats = await cache.getStats();

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error("[PostMetrics API] stats error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Catch-all route for debugging
// Middleware para CORS em todas as requisições
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With,Accept,Origin");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Error handling middleware
app.use((error, req, res, next) => {
  // Always add CORS headers, even on errors
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS,PATCH");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With,Accept,Origin");
  console.error("=== ERROR MIDDLEWARE ===");
  console.error("Error:", error);
  console.error("Request:", req.method, req.path);
  console.error("======================");

  res
    .status(500)
    .json({ error: "Internal server error", message: error.message });
});

// ===== ROTAS DE GERENCIAMENTO DE CACHE =====
app.get("/api/cache/stats", authenticateToken, (req, res) => {
  try {
    const stats = getCacheStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/cache/clear", authenticateToken, (req, res) => {
  try {
    const result = clearCache();
    res.json({ success: true, message: "All caches cleared", ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/cache/clear/:type", authenticateToken, (req, res) => {
  try {
    const { type } = req.params;
    const { pattern } = req.query;
    const result = clearCache(type, pattern);
    res.json({ success: true, message: `Cache ${type} cleared`, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ANALYTICS & AUTOMATION ROUTES =====
// These routes proxy to the Python analytics service (port 8001)

// Health check for analytics service
app.get("/api/analytics/health", async (req, res) => {
  try {
    const result = await analyticsService.healthCheck();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get analytics data (aggregated metrics)
app.get("/api/analytics/data", authenticateToken, async (req, res) => {
  try {
    const result = await analyticsService.getAnalyticsData();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI-generated insights
app.post("/api/analytics/insights", authenticateToken, async (req, res) => {
  try {
    const { start_date, end_date, metric_type } = req.body;
    const result = await analyticsService.getInsights(start_date, end_date, metric_type);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Chat with AI about metrics
app.post("/api/analytics/chat", authenticateToken, async (req, res) => {
  try {
    const { message, context, history } = req.body;
    const result = await analyticsService.chatWithAI(message, context, history);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate SEO-optimized blog post
app.post("/api/automation/generate", authenticateToken, async (req, res) => {
  try {
    const { blog_domain, category, keyword, tone, size, custom_prompt } = req.body;
    const result = await analyticsService.generatePost(blog_domain, category, keyword, tone, size, custom_prompt);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get task status
app.get("/api/automation/task/:taskId", authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const result = await analyticsService.getTaskStatus(taskId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get available domains for automation
app.get("/api/automation/domains", authenticateToken, async (req, res) => {
  try {
    const result = await analyticsService.getAvailableDomains();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get available categories
app.get("/api/automation/categories", authenticateToken, async (req, res) => {
  try {
    const result = await analyticsService.getAvailableCategories();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve static files from the 'public' directory
app.use(express.static(join(__dirname, "public")));

// Handle SPA routing - send all non-API requests to index.html
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(join(__dirname, "public", "index.html"));
});

// Initialize database and start server
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);

      // Inicializar tabela de cache de post metrics
      initPostMetricsCache().then(() => {
        console.log('[PostMetrics] Cache system ready (on-demand mode)');
      }).catch(err => {
        console.error('[PostMetrics] Failed to initialize cache:', err.message);
      });
    });
      

  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  db.close((err) => {
    if (err) {
      console.error("Error closing database:", err);
    } else {
      console.log("Database connection closed.");
    }
    process.exit(0);
  });
});
