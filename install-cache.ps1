Write-Host "=== Instalando dependências do sistema de cache ===" -ForegroundColor Cyan

Write-Host "1. Instalando node-cache..." -ForegroundColor Yellow
pnpm add node-cache

Write-Host "2. Criando arquivo facebook-cache.js..." -ForegroundColor Yellow
$cacheFile = @"
const NodeCache = require('node-cache');

const cacheConfig = {
  short: new NodeCache({ stdTTL: 300 }),
  medium: new NodeCache({ stdTTL: 900 }),
  long: new NodeCache({ stdTTL: 3600 }),
  insights: new NodeCache({ stdTTL: 1800 }),
};

function getCache(cache, key, fetchFn) {
  const value = cache.get(key);
  if (value) {
    console.log('[Cache HIT]', key);
    return value;
  }

  console.log('[Cache MISS]', key);
  return fetchFn().then((result) => {
    cache.set(key, result);
    console.log('[Cache SAVED]', key);
    return result;
  });
}

module.exports = {
  cacheConfig,
  getCache
};
"@

Set-Content -Path "./facebook-cache.js" -Value $cacheFile -Encoding UTF8

Write-Host "=== Finalizado com sucesso ===" -ForegroundColor Green
