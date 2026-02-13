// ====================================================================
// SISTEMA DE CACHE EM MEMÓRIA - BACKEND
// ====================================================================
// Este arquivo implementa um sistema de cache em memória de 4 níveis
// usando a biblioteca node-cache para otimizar requisições à API do Facebook
// ====================================================================

const NodeCache = require("node-cache");

// ====================================================================
// ETAPA 1: CONFIGURAÇÃO DOS NÍVEIS DE CACHE
// ====================================================================
// Define 4 níveis de cache com diferentes TTLs (Time To Live) baseados
// na frequência de mudança dos dados:
// - short: Dados que mudam frequentemente (ex: ad accounts)
// - medium: Dados com mudanças moderadas (ex: campanhas, business accounts)
// - long: Dados que mudam raramente (ex: perfil do Facebook)
// - insights: Dados de métricas/estatísticas (ex: insights de anúncios)
// ====================================================================

const CACHE_CONFIGS = {
  short: {
    ttl: 300,         // 5 minutos - Para dados que mudam com frequência
    checkperiod: 60,  // Verifica expiração a cada 1 minuto
  },
  medium: {
    ttl: 900,         // 15 minutos - Para dados com mudanças moderadas
    checkperiod: 120, // Verifica expiração a cada 2 minutos
  },
  long: {
    ttl: 3600,        // 1 hora - Para dados que raramente mudam
    checkperiod: 300, // Verifica expiração a cada 5 minutos
  },
  insights: {
    ttl: 1800,        // 30 minutos - Para métricas e estatísticas
    checkperiod: 180, // Verifica expiração a cada 3 minutos
  },
};

// ====================================================================
// ETAPA 2: INSTANCIAÇÃO DOS CACHES
// ====================================================================
// Cria uma instância separada de NodeCache para cada nível
// useClones: false -> Performance otimizada (não clona objetos)
// IMPORTANTE: Cada cache opera de forma independente em memória
// ====================================================================

const caches = {
  short: new NodeCache({
    stdTTL: CACHE_CONFIGS.short.ttl,           // TTL padrão: 300s
    checkperiod: CACHE_CONFIGS.short.checkperiod, // Check: 60s
    useClones: false, // Otimização: não clona objetos (mais rápido)
  }),
  medium: new NodeCache({
    stdTTL: CACHE_CONFIGS.medium.ttl,          // TTL padrão: 900s
    checkperiod: CACHE_CONFIGS.medium.checkperiod, // Check: 120s
    useClones: false,
  }),
  long: new NodeCache({
    stdTTL: CACHE_CONFIGS.long.ttl,            // TTL padrão: 3600s
    checkperiod: CACHE_CONFIGS.long.checkperiod, // Check: 300s
    useClones: false,
  }),
  insights: new NodeCache({
    stdTTL: CACHE_CONFIGS.insights.ttl,        // TTL padrão: 1800s
    checkperiod: CACHE_CONFIGS.insights.checkperiod, // Check: 180s
    useClones: false,
  }),
};

// ====================================================================
// ETAPA 3: ESTATÍSTICAS DE CACHE
// ====================================================================
// Rastreia hits (cache encontrado) e misses (cache não encontrado)
// para cada nível de cache, permitindo análise de performance
// ====================================================================

const stats = {
  short: { hits: 0, misses: 0 },
  medium: { hits: 0, misses: 0 },
  long: { hits: 0, misses: 0 },
  insights: { hits: 0, misses: 0 },
};

// ====================================================================
// ETAPA 4: GERAÇÃO DE CHAVES DE CACHE
// ====================================================================
// Gera chaves únicas e consistentes para armazenar dados no cache
// Formato: "prefix:param1=value1&param2=value2"
// Os parâmetros são ordenados alfabeticamente para garantir consistência
// ====================================================================

function generateCacheKey(prefix, params = {}) {
  // Ordena os parâmetros alfabeticamente para garantir a mesma chave
  // independente da ordem em que os parâmetros são passados
  const sortedParams = Object.keys(params)
    .sort()
    .map((key) => `${key}=${JSON.stringify(params[key])}`)
    .join("&");

  // Retorna: "prefix:param1=value1&param2=value2" ou apenas "prefix"
  return sortedParams ? `${prefix}:${sortedParams}` : prefix;
}

// ====================================================================
// ETAPA 5: FUNÇÃO PRINCIPAL - REQUISIÇÃO COM CACHE
// ====================================================================
// Esta é a função principal que implementa o padrão Cache-Aside:
// 1. Tenta buscar do cache primeiro (READ)
// 2. Se encontrar (HIT), retorna dados cacheados
// 3. Se não encontrar (MISS), executa a função, salva no cache e retorna
// ====================================================================

async function cachedRequest(cacheType, key, fn) {
  // 5.1: Validação - Verifica se o tipo de cache existe
  if (!caches[cacheType]) {
    throw new Error(
      `Invalid cache type: ${cacheType}. Valid types: ${Object.keys(
        caches
      ).join(", ")}`
    );
  }

  const cache = caches[cacheType];

  // 5.2: CACHE READ - Tenta buscar do cache
  const cachedValue = cache.get(key);

  // 5.3: CACHE HIT - Dados encontrados no cache
  if (cachedValue !== undefined) {
    stats[cacheType].hits++; // Incrementa contador de hits
    console.log(`✅ [Cache HIT] ${key}`);

    // Retorna dados cacheados com metadados
    return {
      ...cachedValue,
      _cached: true,                              // Flag indicando cache
      _cacheType: cacheType,                      // Tipo de cache usado
      _cacheTimestamp: new Date().toISOString(),  // Timestamp da leitura
    };
  }

  // 5.4: CACHE MISS - Dados não encontrados, busca da fonte
  stats[cacheType].misses++; // Incrementa contador de misses
  console.log(`❌ [Cache MISS] ${key} - Calling Facebook API...`);

  // 5.5: FETCH - Executa a função fornecida (ex: chamada à API do Facebook)
  const startTime = Date.now();
  const result = await fn(); // Aguarda resultado da função
  const duration = Date.now() - startTime;

  // 5.6: CACHE WRITE - Salva resultado no cache para futuras requisições
  cache.set(key, result);
  console.log(`💾 [Cache SAVED] ${key} (took ${duration}ms)`);

  // 5.7: Retorna resultado (sem metadados de cache pois é dado fresco)
  return result;
}

// ====================================================================
// ETAPA 6: INVALIDAÇÃO DE CACHE
// ====================================================================
// Função para limpar cache (manualmente ou por padrão)
// Suporta limpar: todos os caches, um tipo específico, ou por padrão
// ====================================================================

function clearCache(type = null, pattern = null) {
  const cleared = { total: 0, byType: {} };

  // 6.1: Determina quais caches limpar (todos ou um específico)
  const typesToClear = type ? [type] : Object.keys(caches);

  typesToClear.forEach((cacheType) => {
    // 6.2: Validação do tipo de cache
    if (!caches[cacheType]) {
      console.warn(`Invalid cache type: ${cacheType}`);
      return;
    }

    const cache = caches[cacheType];

    // 6.3: Limpeza seletiva por padrão (ex: limpar apenas keys com "facebook")
    if (pattern) {
      const keys = cache.keys();
      const matchingKeys = keys.filter((key) => key.includes(pattern));
      matchingKeys.forEach((key) => cache.del(key)); // Deleta cada chave
      cleared.byType[cacheType] = matchingKeys.length;
      cleared.total += matchingKeys.length;
      console.log(
        `🗑️  [Cache CLEARED] ${cacheType}: ${matchingKeys.length} keys matching "${pattern}"`
      );
    }
    // 6.4: Limpeza completa do cache
    else {
      const keyCount = cache.keys().length;
      cache.flushAll(); // Limpa todas as chaves do cache
      cleared.byType[cacheType] = keyCount;
      cleared.total += keyCount;
      console.log(`🗑️  [Cache CLEARED] ${cacheType}: ${keyCount} keys`);
    }
  });

  // 6.5: Retorna relatório de quantas chaves foram limpas
  return cleared;
}

// ====================================================================
// ETAPA 7: ANÁLISE E MÉTRICAS DE PERFORMANCE
// ====================================================================
// Fornece estatísticas detalhadas sobre o uso do cache
// Útil para monitorar performance e otimizar configurações de TTL
// ====================================================================

function getCacheStats() {
  const cacheStats = {};

  // 7.1: Calcula estatísticas para cada tipo de cache
  Object.keys(caches).forEach((type) => {
    const cache = caches[type];
    const keys = cache.keys();
    const { hits, misses } = stats[type];
    const total = hits + misses;
    // Hit Rate: percentual de requisições que foram atendidas pelo cache
    const hitRate = total > 0 ? ((hits / total) * 100).toFixed(2) : "0.00";

    cacheStats[type] = {
      keys: keys.length,        // Quantidade de chaves no cache
      hits,                     // Quantidade de cache hits
      misses,                   // Quantidade de cache misses
      hitRate: `${hitRate}%`,   // Taxa de sucesso do cache
      ttl: CACHE_CONFIGS[type].ttl, // TTL configurado
    };
  });

  // 7.2: Calcula totais globais (todos os caches combinados)
  const totalHits = Object.values(stats).reduce((sum, s) => sum + s.hits, 0);
  const totalMisses = Object.values(stats).reduce(
    (sum, s) => sum + s.misses,
    0
  );
  const totalRequests = totalHits + totalMisses;
  const totalHitRate =
    totalRequests > 0 ? ((totalHits / totalRequests) * 100).toFixed(2) : "0.00";
  const totalKeys = Object.keys(caches).reduce(
    (sum, type) => sum + caches[type].keys().length,
    0
  );

  // 7.3: Retorna relatório completo de estatísticas
  return {
    timestamp: new Date().toISOString(),
    caches: cacheStats,           // Stats por tipo
    totals: {                      // Stats globais
      keys: totalKeys,
      hits: totalHits,
      misses: totalMisses,
      hitRate: `${totalHitRate}%`,
    },
  };
}

// ====================================================================
// ETAPA 8: INFORMAÇÕES DETALHADAS DO CACHE
// ====================================================================
// Retorna informações detalhadas sobre cada entrada de um cache específico
// Incluindo tempo de expiração e TTL restante
// ====================================================================

function getCacheInfo(type) {
  // 8.1: Validação do tipo de cache
  if (!caches[type]) {
    throw new Error(`Invalid cache type: ${type}`);
  }

  const cache = caches[type];
  const keys = cache.keys();
  const entries = {};

  // 8.2: Para cada chave, obtém informações detalhadas
  keys.forEach((key) => {
    const value = cache.get(key);
    const ttl = cache.getTtl(key); // Timestamp de expiração
    entries[key] = {
      hasValue: value !== undefined,
      expiresAt: ttl ? new Date(ttl).toISOString() : null,          // Data/hora de expiração
      ttlRemaining: ttl ? Math.floor((ttl - Date.now()) / 1000) : null, // Segundos restantes
    };
  });

  // 8.3: Retorna informações completas do cache
  return {
    type,                           // Tipo de cache
    config: CACHE_CONFIGS[type],    // Configuração (TTL, checkperiod)
    stats: stats[type],             // Estatísticas (hits, misses)
    entries,                        // Detalhes de cada entrada
  };
}

// ====================================================================
// EXPORTAÇÃO DAS FUNÇÕES
// ====================================================================

module.exports = {
  cachedRequest,      // Função principal para requisições com cache
  generateCacheKey,   // Gerador de chaves de cache
  clearCache,         // Invalidação de cache
  getCacheStats,      // Estatísticas de performance
  getCacheInfo,       // Informações detalhadas
  caches,             // Instâncias dos caches (para uso avançado)
  CACHE_CONFIGS,      // Configurações dos caches
};
