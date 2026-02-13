/**
 * Post Metrics Module - Sistema SEPARADO do GAM
 * Busca métricas individuais de posts WordPress usando Custom Targeting
 *
 * NÃO MODIFICA google-ad-manager.js - usa apenas credenciais compartilhadas
 */

const axios = require("axios");

// Configurações
const API_REQUEST_TIMEOUT = 90000;
const API_BASE_URL = "https://admanager.googleapis.com/v1";

// Configuração de concorrência para não bloquear o event loop
const CONCURRENT_ACCOUNTS = 3; // Processa 3 contas em paralelo
const YIELD_INTERVAL = 5; // Libera event loop a cada 5 contas

/**
 * Libera o event loop para processar outras requisições
 * Usa setImmediate para não bloquear o servidor
 */
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Processa array em lotes com limite de concorrência
 * @param {Array} items - Array de itens para processar
 * @param {Function} processor - Função async que processa cada item
 * @param {number} concurrency - Número de itens processados em paralelo
 */
async function processInBatches(items, processor, concurrency = CONCURRENT_ACCOUNTS) {
  const results = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    // Processa lote em paralelo
    const batchResults = await Promise.allSettled(
      batch.map((item, idx) => processor(item, i + idx))
    );

    results.push(...batchResults);

    // Libera event loop entre lotes
    await yieldToEventLoop();

    // Log de progresso
    console.log(`[PostMetrics] Processed ${Math.min(i + concurrency, items.length)}/${items.length} accounts`);
  }

  return results;
}

/**
 * Client para buscar métricas de posts individuais
 */
class PostMetricsClient {
  constructor(networkCode, accessToken, refreshToken, accountName = '', domain = '') {
    this.networkCode = networkCode;
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accountName = accountName;
    this.domain = domain;
    this.clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    this.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    this.tokenExpiry = null;
  }

  /**
   * Obter access token (refresh se necessário)
   */
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    console.log(`[PostMetrics] Refreshing token for ${this.accountName}...`);

    try {
      const response = await axios.post("https://oauth2.googleapis.com/token", {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;

      return this.accessToken;
    } catch (error) {
      console.error(`[PostMetrics] Token refresh failed:`, error.message);
      throw new Error("Failed to refresh access token");
    }
  }

  /**
   * Buscar Custom Targeting Key ID pelo nome (ex: "id_post_wp")
   */
  async getCustomTargetingKeyId(keyName) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/networks/${this.networkCode}/customTargetingKeys`;

    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: API_REQUEST_TIMEOUT,
      });

      const keys = response.data.customTargetingKeys || [];
      const key = keys.find(k => k.displayName === keyName);

      if (key) {
        const keyId = key.name.split("/").pop();
        console.log(`[PostMetrics] Found key "${keyName}" with ID: ${keyId}`);
        return keyId;
      }

      console.log(`[PostMetrics] Key "${keyName}" not found`);
      return null;
    } catch (error) {
      console.error(`[PostMetrics] Error fetching keys:`, error.message);
      return null;
    }
  }

  /**
   * Buscar valores de uma Custom Targeting Key (lista de posts)
   */
  async getCustomTargetingValues(keyId) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/networks/${this.networkCode}/customTargetingKeys/${keyId}/customTargetingValues`;

    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: API_REQUEST_TIMEOUT,
      });

      return response.data.customTargetingValues || [];
    } catch (error) {
      console.error(`[PostMetrics] Error fetching values:`, error.message);
      return [];
    }
  }

  /**
   * Formatar data para API do GAM
   */
  formatDateForAPI(dateString) {
    const [year, month, day] = dateString.split('-').map(Number);
    return { year, month, day };
  }

  /**
   * Criar relatório no GAM
   */
  async createReport(reportDefinition) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/networks/${this.networkCode}/reports`;

    const response = await axios.post(url, reportDefinition, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: API_REQUEST_TIMEOUT,
    });

    return response.data;
  }

  /**
   * Executar relatório
   */
  async runReport(reportId) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/networks/${this.networkCode}/reports/${reportId}:run`;

    const response = await axios.post(url, {}, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: API_REQUEST_TIMEOUT,
    });

    return response.data;
  }

  /**
   * Verificar status da operação
   */
  async pollOperation(operationName, maxAttempts = 30) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/${operationName}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: API_REQUEST_TIMEOUT,
      });

      if (response.data.done) {
        return response.data;
      }

      console.log(`[PostMetrics] Waiting... (${attempt}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error("Report processing timeout");
  }

  /**
   * Buscar resultados do relatório
   */
  async fetchReportResults(reportResultPath) {
    const accessToken = await this.getAccessToken();
    const url = `${API_BASE_URL}/${reportResultPath}:fetchRows`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: API_REQUEST_TIMEOUT,
    });

    return response.data;
  }

  /**
   * Buscar métricas totais do blog (para calcular eCPM médio)
   */
  async getBlogTotals(startDate, endDate) {
    try {
      const reportBody = {
        reportDefinition: {
          dimensions: ["DATE"],
          metrics: [
            "IMPRESSIONS",
            "CLICKS",
            "REVENUE",
          ],
          dateRange: {
            fixed: {
              startDate: this.formatDateForAPI(startDate),
              endDate: this.formatDateForAPI(endDate),
            },
          },
          reportType: "HISTORICAL",
        },
      };

      const report = await this.createReport(reportBody);
      const operation = await this.runReport(report.reportId);
      const completed = await this.pollOperation(operation.name);
      const results = await this.fetchReportResults(completed.response.reportResult);

      // Debug: ver estrutura do resultado
      if (results.rows && results.rows.length > 0) {
        console.log(`[PostMetrics] Blog totals raw sample:`, JSON.stringify(results.rows[0]).substring(0, 300));
      }

      // Somar totais
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalRevenue = 0;

      if (results.rows) {
        for (const row of results.rows) {
          const metrics = row.metricValueGroups?.[0]?.primaryValues || [];
          // Impressions/Clicks vêm como intValue, Revenue vem como doubleValue (já em R$)
          totalImpressions += parseInt(metrics[0]?.intValue || "0");
          totalClicks += parseInt(metrics[1]?.intValue || "0");
          // Revenue vem como doubleValue e já está em moeda final (não micros)
          totalRevenue += parseFloat(metrics[2]?.doubleValue || metrics[2]?.intValue || "0");
        }
      }
      const avgEcpm = totalImpressions > 0 ? (totalRevenue / totalImpressions) * 1000 : 0;
      const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

      console.log(`[PostMetrics] Blog totals for ${this.accountName}: ${totalImpressions} imp, R$${totalRevenue.toFixed(2)}, eCPM R$${avgEcpm.toFixed(2)}`);

      return { totalImpressions, totalClicks, totalRevenue, avgEcpm, avgCtr };
    } catch (error) {
      console.error(`[PostMetrics] Error fetching blog totals for ${this.accountName}:`, error.message);
      return { totalImpressions: 0, totalClicks: 0, totalRevenue: 0, avgEcpm: 0, avgCtr: 0 };
    }
  }

  /**
   * Buscar métricas por CUSTOM_TARGETING_VALUE_ID
   * Retorna eCPM, CTR, Viewability, impressões, etc por post
   */
  async getPostMetrics(params = {}) {
    const { startDate, endDate } = params;

    const today = new Date().toISOString().split("T")[0];
    const end = endDate || today;
    const start = startDate || today;

    console.log(`[PostMetrics] Fetching metrics for ${this.accountName} from ${start} to ${end}`);

    try {
      // Primeiro buscar totais do blog para calcular eCPM médio
      const blogTotals = await this.getBlogTotals(start, end);

      // Verificar se há custom targeting key id_post_wp
      const keyId = await this.getCustomTargetingKeyId("id_post_wp");
      if (keyId) {
        const values = await this.getCustomTargetingValues(keyId);
        console.log(`[PostMetrics] Found ${values.length} custom targeting values for id_post_wp in ${this.accountName}`);
        if (values.length > 0 && values.length <= 5) {
          console.log(`[PostMetrics] Sample values:`, values.map(v => v.displayName).join(', '));
        }
      } else {
        console.log(`[PostMetrics] Key id_post_wp not found for ${this.accountName}`);
      }

      // Criar relatório com KEY_VALUES_NAME (Custom Targeting)
      // Retorna no formato: "id_post_wp=12345", "post_category=economia"
      // NOTA: KEY_VALUES_NAME só suporta métricas básicas (Impressões, Clicks)
      // eCPM é calculado usando o eCPM médio do blog
      const reportBody = {
        reportDefinition: {
          dimensions: [
            "KEY_VALUES_NAME",
            "DATE",
          ],
          metrics: [
            "IMPRESSIONS",
            "CLICKS",
          ],
          dateRange: {
            fixed: {
              startDate: this.formatDateForAPI(start),
              endDate: this.formatDateForAPI(end),
            },
          },
          reportType: "HISTORICAL",
        },
      };

      console.log(`[PostMetrics] Creating report with KEY_VALUES_NAME dimension...`);

      // Workflow: CREATE -> RUN -> POLL -> FETCH
      const report = await this.createReport(reportBody);
      const reportId = report.reportId;

      const operation = await this.runReport(reportId);
      const operationName = operation.name;

      const completedOperation = await this.pollOperation(operationName);
      const reportResultPath = completedOperation.response.reportResult;

      const results = await this.fetchReportResults(reportResultPath);

      // Debug: mostrar resultado bruto
      console.log(`[PostMetrics] Raw results for ${this.accountName}:`, JSON.stringify(results).substring(0, 500));

      // Transformar dados (passando o eCPM médio do blog)
      const transformedData = this.transformPostMetrics(results, blogTotals.avgEcpm);

      return {
        success: true,
        data: transformedData,
        accountName: this.accountName,
        networkCode: this.networkCode,
        blogTotals,
      };

    } catch (error) {
      console.error(`[PostMetrics] Error for ${this.accountName}:`, error.message);

      // Log detalhado do erro
      if (error.response?.data) {
        console.error(`[PostMetrics] API Error details:`, JSON.stringify(error.response.data, null, 2));
      }

      // Se for 429, propagar para retry
      if (error.response?.status === 429) {
        throw error;
      }

      return {
        success: false,
        data: [],
        error: error.message,
        accountName: this.accountName,
      };
    }
  }

  /**
   * Transformar dados do relatório GAM para formato amigável
   * Filtra apenas registros com id_post_wp=XXXX
   * @param {object} reportResult - Resultado do relatório GAM
   * @param {number} blogAvgEcpm - eCPM médio do blog (para aplicar nos posts)
   */
  transformPostMetrics(reportResult, blogAvgEcpm = 0) {
    if (!reportResult.rows || reportResult.rows.length === 0) {
      console.log(`[PostMetrics] No rows in report result`);
      return [];
    }

    console.log(`[PostMetrics] Processing ${reportResult.rows.length} rows (blog eCPM: R$${blogAvgEcpm.toFixed(2)})`);
    const posts = [];

    for (const row of reportResult.rows) {
      const dimensionValues = row.dimensionValues || [];
      const metricValues = row.metricValueGroups?.[0]?.primaryValues || [];

      // KEY_VALUES_NAME retorna no formato "key=value" (ex: "id_post_wp=12345")
      const keyValueName = dimensionValues[0]?.stringValue || "";
      const date = dimensionValues[1]?.stringValue || "";

      // Filtrar apenas registros com id_post_wp
      if (!keyValueName.startsWith("id_post_wp=")) {
        continue;
      }

      // Extrair o ID do post
      const postId = keyValueName.split("=")[1] || "";

      if (!postId || postId === "(not set)" || postId === "Unknown") {
        continue;
      }

      // Métricas na ordem (KEY_VALUES_NAME só suporta básicas):
      // 0: IMPRESSIONS
      // 1: CLICKS
      const impressions = parseInt(metricValues[0]?.intValue || "0");
      const clicks = parseInt(metricValues[1]?.intValue || "0");

      // Calcular CTR manualmente
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;

      // eCPM: usar o eCPM médio do blog (todos posts do mesmo blog têm o mesmo eCPM)
      // Revenue estimado: (impressions / 1000) * blogAvgEcpm
      const ecpm = blogAvgEcpm;
      const revenue = (impressions / 1000) * blogAvgEcpm;

      // Viewability não disponível com KEY_VALUES_NAME
      const viewability = 0;
      const viewableImpressions = 0;
      const measurableImpressions = impressions;

      posts.push({
        postId,
        valueId: postId,
        date,
        impressions,
        clicks,
        revenue: parseFloat(revenue.toFixed(4)),
        ecpm: parseFloat(ecpm.toFixed(2)),
        ctr: parseFloat(ctr.toFixed(2)),
        viewability: parseFloat(viewability.toFixed(2)),
        viewableImpressions,
        measurableImpressions,
        accountName: this.accountName,
        networkCode: this.networkCode,
        domain: this.domain,
      });
    }

    console.log(`[PostMetrics] Transformed ${posts.length} posts for ${this.accountName}`);
    return posts;
  }
}

/**
 * Buscar métricas de posts de múltiplas contas GAM
 */
async function getMultiAccountPostMetrics(db, userId, params = {}) {
  const { startDate, endDate } = params;

  console.log(`[PostMetrics] Starting multi-account fetch for user ${userId}`);

  return new Promise((resolve, reject) => {
    // Buscar todas as contas ativas do usuário (incluindo domínio)
    db.all(
      `SELECT id, account_name, network_code, access_token, refresh_token, domain
       FROM google_ad_manager_accounts
       WHERE user_id = ? AND is_active = 1`,
      [userId],
      async (err, accounts) => {
        if (err) {
          console.error("[PostMetrics] DB error:", err);
          return reject(err);
        }

        if (!accounts || accounts.length === 0) {
          return resolve({
            success: true,
            data: [],
            message: "No active GAM accounts found",
          });
        }

        console.log(`[PostMetrics] Found ${accounts.length} active accounts (processing ${CONCURRENT_ACCOUNTS} in parallel)`);

        const allPosts = [];
        const errors = [];

        // Função para processar uma conta
        const processAccount = async (account, index) => {
          try {
            console.log(`[PostMetrics] Processing ${index + 1}/${accounts.length}: ${account.account_name}`);

            const client = new PostMetricsClient(
              account.network_code,
              account.access_token,
              account.refresh_token,
              account.account_name,
              account.domain || ''
            );

            const result = await client.getPostMetrics({ startDate, endDate });

            if (result.success && result.data.length > 0) {
              console.log(`[PostMetrics] ${account.account_name}: ${result.data.length} posts`);
              return { success: true, data: result.data, account: account.account_name };
            }

            return { success: true, data: [], account: account.account_name };

          } catch (error) {
            console.error(`[PostMetrics] Error for ${account.account_name}:`, error.message);

            // Se for rate limit, esperar antes de continuar
            if (error.response?.status === 429) {
              console.log(`[PostMetrics] Rate limit hit on ${account.account_name}, waiting 10s...`);
              await new Promise(r => setTimeout(r, 10000));
            }

            return { success: false, error: error.message, account: account.account_name };
          }
        };

        // Processar contas em lotes paralelos (não bloqueia event loop)
        const results = await processInBatches(accounts, processAccount, CONCURRENT_ACCOUNTS);

        // Coletar resultados
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.success && result.value.data) {
            allPosts.push(...result.value.data);
          } else if (result.status === 'rejected' || !result.value?.success) {
            errors.push({
              account: result.value?.account || 'unknown',
              error: result.reason?.message || result.value?.error || 'Unknown error'
            });
          }
        }

        console.log(`[PostMetrics] Total posts collected: ${allPosts.length}`);

        // Agregar posts por postId (mesmo post pode aparecer em múltiplas contas)
        const aggregatedPosts = aggregatePostMetrics(allPosts);

        console.log(`[PostMetrics] Aggregated posts: ${aggregatedPosts.length}`);

        // Extrair lista de domínios das contas (para buscar todos os posts)
        const allDomains = accounts
          .map(acc => acc.domain)
          .filter(Boolean);

        console.log(`[PostMetrics] Domains to fetch all posts: ${allDomains.length}`);

        // Enriquecer posts com info do WordPress (URL, categoria)
        // E adicionar posts sem métricas
        const enrichedPosts = await enrichPostsWithWordPressInfo(aggregatedPosts, allDomains);

        console.log(`[PostMetrics] Enriched ${enrichedPosts.length} posts with WordPress info`);

        resolve({
          success: true,
          data: enrichedPosts,
          totalPosts: enrichedPosts.length,
          accountsProcessed: accounts.length,
          errors: errors.length > 0 ? errors : undefined,
        });
      }
    );
  });
}

/**
 * Agregar métricas de posts (somar quando mesmo postId aparece em múltiplas contas)
 * Agrupa por domínio + postId para manter separação por blog
 */
function aggregatePostMetrics(posts) {
  const aggregated = {};

  posts.forEach((post) => {
    // Usar domínio + postId como chave para manter separação por blog
    const key = `${post.domain || 'unknown'}:${post.postId}`;

    if (!aggregated[key]) {
      aggregated[key] = {
        postId: post.postId,
        domain: post.domain || '',
        impressions: 0,
        clicks: 0,
        revenue: 0,
        viewableImpressions: 0,
        measurableImpressions: 0,
        accounts: [],
      };
    }

    aggregated[key].impressions += post.impressions;
    aggregated[key].clicks += post.clicks;
    aggregated[key].revenue += post.revenue;
    aggregated[key].viewableImpressions += post.viewableImpressions;
    aggregated[key].measurableImpressions += post.measurableImpressions;

    if (!aggregated[key].accounts.includes(post.accountName)) {
      aggregated[key].accounts.push(post.accountName);
    }
  });

  // Recalcular métricas derivadas
  return Object.values(aggregated).map((post) => {
    const ecpm = post.impressions > 0 ? (post.revenue / post.impressions) * 1000 : 0;
    const ctr = post.impressions > 0 ? (post.clicks / post.impressions) * 100 : 0;
    const viewability = post.measurableImpressions > 0
      ? (post.viewableImpressions / post.measurableImpressions) * 100
      : 0;

    return {
      ...post,
      ecpm: parseFloat(ecpm.toFixed(2)),
      ctr: parseFloat(ctr.toFixed(2)),
      viewability: parseFloat(viewability.toFixed(2)),
    };
  });
}

/**
 * Buscar informações de múltiplos posts via WordPress REST API (batch)
 * Retorna URL permanente, título, slug e categorias
 */
async function getWordPressPostsBatch(domain, postIds) {
  if (!postIds || postIds.length === 0) return {};

  try {
    // Limitar a 100 posts por request
    const limitedIds = postIds.slice(0, 100);
    const idsParam = limitedIds.join(',');

    // Buscar posts
    const postsUrl = `https://${domain}/wp-json/wp/v2/posts?include=${idsParam}&_fields=id,link,slug,categories&per_page=100`;
    const postsResponse = await axios.get(postsUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'HDS-Metrics/1.0' },
    });

    // Buscar categorias do site
    const catsUrl = `https://${domain}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug`;
    let categoriesMap = {};
    try {
      const catsResponse = await axios.get(catsUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'HDS-Metrics/1.0' },
      });
      catsResponse.data.forEach(cat => {
        categoriesMap[cat.id] = cat.name;
      });
    } catch {
      // Ignore category fetch errors
    }

    // Mapear resultado por postId
    const result = {};
    postsResponse.data.forEach(post => {
      const categoryNames = (post.categories || [])
        .map(catId => categoriesMap[catId] || `Cat#${catId}`)
        .filter(Boolean);

      result[post.id] = {
        postUrl: post.link || `https://${domain}/?p=${post.id}`,
        postSlug: post.slug || '',
        category: categoryNames[0] || '', // Primeira categoria
        categories: categoryNames,
      };
    });

    console.log(`[PostMetrics] Fetched ${Object.keys(result).length} posts info from ${domain}`);
    return result;

  } catch (error) {
    console.log(`[PostMetrics] Could not fetch WordPress info from ${domain}: ${error.message}`);
    return {};
  }
}

/**
 * Buscar TODOS os posts de um domínio WordPress (sem limite)
 * Retorna lista de posts com ID, URL, slug, categoria
 * @param {string} domain - Domínio do WordPress
 */
async function getAllWordPressPosts(domain) {
  const allPosts = [];
  let page = 1;
  const perPage = 100;

  try {
    // Buscar categorias primeiro
    const catsUrl = `https://${domain}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug`;
    let categoriesMap = {};
    try {
      const catsResponse = await axios.get(catsUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'HDS-Metrics/1.0' },
      });
      catsResponse.data.forEach(cat => {
        categoriesMap[cat.id] = cat.name;
      });
    } catch {
      // Ignore category fetch errors
    }

    // Buscar TODOS os posts paginados (sem limite)
    while (true) {
      const postsUrl = `https://${domain}/wp-json/wp/v2/posts?page=${page}&per_page=${perPage}&_fields=id,link,slug,categories,date&orderby=date&order=desc`;

      try {
        const response = await axios.get(postsUrl, {
          timeout: 15000,
          headers: { 'User-Agent': 'HDS-Metrics/1.0' },
        });

        if (!response.data || response.data.length === 0) {
          break; // Não há mais posts
        }

        response.data.forEach(post => {
          const categoryNames = (post.categories || [])
            .map(catId => categoriesMap[catId] || '')
            .filter(Boolean);

          allPosts.push({
            postId: String(post.id),
            postUrl: post.link || `https://${domain}/?p=${post.id}`,
            postSlug: post.slug || '',
            category: categoryNames[0] || '',
            categories: categoryNames,
            domain: domain,
            publishedDate: post.date,
          });
        });

        // Se retornou menos que perPage, não há mais páginas
        if (response.data.length < perPage) {
          break;
        }

        page++;
        // Libera event loop entre páginas (não bloqueia outras requisições)
        await yieldToEventLoop();
      } catch (err) {
        // Se der erro 400 (página não existe) ou 404, parar
        if (err.response?.status === 400 || err.response?.status === 404) {
          break;
        }
        throw err;
      }
    }

    console.log(`[PostMetrics] Fetched ALL ${allPosts.length} posts from ${domain}`);
    return allPosts;

  } catch (error) {
    console.log(`[PostMetrics] Could not fetch all posts from ${domain}: ${error.message}`);
    return [];
  }
}

/**
 * Enriquecer posts com informações do WordPress (URL, categoria)
 * E adicionar posts sem métricas (com valores zerados)
 * @param {Array} postsWithMetrics - Posts que têm métricas do GAM
 * @param {Array} domains - Lista de domínios para buscar todos os posts
 */
async function enrichPostsWithWordPressInfo(postsWithMetrics, domains = []) {
  // Agrupar posts por domínio
  const byDomain = {};
  postsWithMetrics.forEach(post => {
    if (!post.domain) return;
    if (!byDomain[post.domain]) byDomain[post.domain] = [];
    byDomain[post.domain].push(post);
  });

  // Adicionar domínios que não têm posts com métricas
  domains.forEach(domain => {
    if (!byDomain[domain]) {
      byDomain[domain] = [];
    }
  });

  console.log(`[PostMetrics] Enriching posts from ${Object.keys(byDomain).length} domains...`);

  const allEnrichedPosts = [];

  // Para cada domínio, buscar TODOS os posts e mesclar
  for (const domain of Object.keys(byDomain)) {
    const postsWithData = byDomain[domain];
    const postIdsWithData = new Set(postsWithData.map(p => String(p.postId)));

    // Buscar TODOS os posts do WordPress (sem limite)
    const allWpPosts = await getAllWordPressPosts(domain);

    // Mesclar: posts com métricas + posts sem métricas
    for (const wpPost of allWpPosts) {
      const hasMetrics = postIdsWithData.has(wpPost.postId);

      if (hasMetrics) {
        // Encontrar o post com métricas e enriquecer
        const existingPost = postsWithData.find(p => String(p.postId) === wpPost.postId);
        if (existingPost) {
          existingPost.postUrl = wpPost.postUrl;
          existingPost.postSlug = wpPost.postSlug;
          existingPost.category = wpPost.category;
          allEnrichedPosts.push(existingPost);
        }
      } else {
        // Post sem métricas - adicionar com valores zerados
        allEnrichedPosts.push({
          postId: wpPost.postId,
          postUrl: wpPost.postUrl,
          postSlug: wpPost.postSlug,
          category: wpPost.category,
          domain: domain,
          impressions: 0,
          clicks: 0,
          revenue: 0,
          ecpm: 0,
          ctr: 0,
          viewability: 0,
          viewableImpressions: 0,
          measurableImpressions: 0,
          accounts: [],
          hasMetrics: false, // Flag para identificar posts sem dados
        });
      }
    }

    // Adicionar posts com métricas que não foram encontrados no WordPress
    // (posts antigos ou deletados)
    for (const post of postsWithData) {
      const wasFound = allWpPosts.some(wp => wp.postId === String(post.postId));
      if (!wasFound) {
        post.postUrl = post.postUrl || `https://${domain}/?p=${post.postId}`;
        post.category = post.category || '';
        post.hasMetrics = true;
        allEnrichedPosts.push(post);
      }
    }

    // Libera event loop entre domínios (não bloqueia outras requisições)
    await yieldToEventLoop();
  }

  console.log(`[PostMetrics] Total enriched posts: ${allEnrichedPosts.length} (${postsWithMetrics.length} with metrics)`);
  return allEnrichedPosts;
}

module.exports = {
  PostMetricsClient,
  getMultiAccountPostMetrics,
  aggregatePostMetrics,
  getWordPressPostsBatch,
  getAllWordPressPosts,
  enrichPostsWithWordPressInfo,
};
