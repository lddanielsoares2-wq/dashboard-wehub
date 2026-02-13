# Google Ad Manager - Calendário Funcional com Datas Customizadas

## ✅ Sistema Implementado e Testado

O Google Ad Manager agora aceita **datas específicas customizadas** ao invés de ranges relativos (YESTERDAY, LAST_7_DAYS, etc.).

## Mudanças Realizadas

### 1. Função `getDateRange()` - Agora usa custom dates

**Antes:**
```javascript
getDateRange(startDate, endDate) {
  // Usava ranges relativos baseado na diferença de dias
  if (daysDiff <= 1) return { relative: "YESTERDAY" };
  else if (daysDiff <= 7) return { relative: "LAST_7_DAYS" };
  // ...
}
```

**Depois:**
```javascript
getDateRange(startDate, endDate) {
  // Usa datas específicas no formato Google.Type.Date
  const startDateFormatted = this.formatDateForAPI(startDate);
  const endDateFormatted = this.formatDateForAPI(endDate);

  return {
    custom: {
      startDate: startDateFormatted,
      endDate: endDateFormatted
    }
  };
}
```

### 2. Função `formatDateForAPI()` - Parse direto sem timezone issues

**Antes:**
```javascript
formatDateForAPI(dateString) {
  const date = new Date(dateString); // Pode causar problemas de timezone
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1, // getMonth() retorna 0-11
    day: date.getDate(),
  };
}
```

**Depois:**
```javascript
formatDateForAPI(dateString) {
  // Parse direto da string "YYYY-MM-DD"
  const [year, month, day] = dateString.split('-').map(Number);

  return {
    year: year,
    month: month, // Já vem 1-indexed (1 = Janeiro)
    day: day
  };
}
```

### 3. Logs adicionados para debug

```javascript
console.log("[GAM] Custom date range:", { start, end });
console.log("[GAM] Report definition:", JSON.stringify(reportDefinition, null, 2));
console.log("[GAM Endpoint] Query params:", { startDate, endDate, dimensionType, days });
console.log("[GAM Endpoint] Using dates:", { start, end });
```

## Como Funciona

### Fluxo Completo:

1. **Frontend envia requisição**:
   ```typescript
   apiClient.getGoogleAdManagerStatistics({
     startDate: '2025-12-10', // YYYY-MM-DD
     endDate: '2025-12-18',   // YYYY-MM-DD
     dimensionType: 'AD_UNIT'
   })
   ```

2. **Backend recebe e processa**:
   ```
   GET /api/googleadmanager/statistics?startDate=2025-12-10&endDate=2025-12-18
   ```

3. **Date Range é convertido para formato Google**:
   ```javascript
   {
     custom: {
       startDate: { year: 2025, month: 12, day: 10 },
       endDate: { year: 2025, month: 12, day: 18 }
     }
   }
   ```

4. **Report Definition enviado para Google**:
   ```json
   {
     "displayName": "Metrics Report 1734567890123",
     "reportDefinition": {
       "dimensions": ["AD_UNIT_NAME"],
       "metrics": ["IMPRESSIONS", "CLICKS", "REVENUE", "AVERAGE_ECPM", "CTR", "UNFILLED_IMPRESSIONS"],
       "dateRange": {
         "custom": {
           "startDate": { "year": 2025, "month": 12, "day": 10 },
           "endDate": { "year": 2025, "month": 12, "day": 18 }
         }
       },
       "reportType": "HISTORICAL",
       "reportCurrency": "USD"
     }
   }
   ```

5. **Google retorna dados exatamente do período solicitado**

## Formato de Entrada e Saída

### Entrada (Frontend → Backend):
- **Formato**: `YYYY-MM-DD` (string)
- **Exemplo**: `"2025-12-18"`

### Processamento (Backend → Google API):
- **Formato**: `Google.Type.Date` (objeto)
- **Exemplo**: `{ year: 2025, month: 12, day: 18 }`
- **Nota**: Month é 1-indexed (1 = Janeiro, 12 = Dezembro)

### Saída (Google API → Backend → Frontend):
- **Revenue**: USD (dólar americano)
- **eCPM**: USD (dólar americano)
- **Datas**: Exatamente o range solicitado

## Testes

Execute o arquivo de teste para verificar:
```bash
cd /home/marcio/hdsv2/back
node test-gam-dates.js
```

**Testes incluídos**:
- ✅ Formatação de datas específicas
- ✅ Criação de date range customizado
- ✅ Edge cases (dias e meses < 10)
- ✅ Estrutura completa do report
- ✅ Moeda em USD
- ✅ Custom date range ao invés de relative

## Exemplos de Uso

### Exemplo 1: Buscar dados de um dia específico
```javascript
// Frontend
const response = await apiClient.getGoogleAdManagerStatistics({
  startDate: '2025-12-18',
  endDate: '2025-12-18',
  dimensionType: 'AD_UNIT'
});
```

### Exemplo 2: Buscar dados de uma semana
```javascript
const response = await apiClient.getGoogleAdManagerStatistics({
  startDate: '2025-12-10',
  endDate: '2025-12-17',
  dimensionType: 'DATE'
});
```

### Exemplo 3: Buscar dados de um mês específico
```javascript
const response = await apiClient.getGoogleAdManagerStatistics({
  startDate: '2025-11-01',
  endDate: '2025-11-30',
  dimensionType: 'ORDER'
});
```

## Logs de Debug

Quando você fizer uma requisição, verá logs como:

```
[GAM Endpoint] Query params: { startDate: '2025-12-18', endDate: '2025-12-18', dimensionType: 'AD_UNIT' }
[GAM Endpoint] Using dates: { start: '2025-12-18', end: '2025-12-18' }
[GAM] Cache key: gam_multi_stats:...
[GAM Multi] Fetching statistics for user 1 from 2025-12-18 to 2025-12-18
[GAM] Starting report workflow from 2025-12-18 to 2025-12-18 with dimension AD_UNIT
[GAM] Custom date range: {
  start: { year: 2025, month: 12, day: 18 },
  end: { year: 2025, month: 12, day: 18 }
}
[GAM] Report currency set to: USD
[GAM] Report definition: { ... }
```

## Compatibilidade

### Frontend
- ✅ **GoogleAdManagerTable.tsx** - Já envia startDate/endDate corretamente
- ✅ **AllTable.tsx** - Já envia startDate/endDate corretamente
- ✅ **apiClient.ts** - Interface já define startDate/endDate como string

### Backend
- ✅ **google-ad-manager.js** - Atualizado para usar custom dates
- ✅ **index.js** - Endpoint recebe e passa datas corretamente
- ✅ **Multi-account** - Suporta custom dates

## Limitações da API do Google

- **Máximo 90 dias**: O Google Ad Manager pode limitar queries a 90 dias
- **Data mínima**: Depende de quando a conta foi criada
- **Timezone**: A API usa o timezone configurado na conta do Google Ad Manager

## Troubleshooting

### Problema: "No data returned from report"
**Possíveis causas**:
- Datas fora do range disponível
- Conta sem dados no período
- Timezone da conta diferente do esperado

**Solução**: Verificar logs e testar com datas recentes (últimos 7 dias)

### Problema: Datas não batem com o esperado
**Possível causa**: Timezone da conta Google Ad Manager

**Solução**: Verificar configurações de timezone na conta Google Ad Manager

## Moeda USD

Todas as métricas de revenue e eCPM são retornadas em **USD (dólar americano)** graças ao parâmetro:
```javascript
reportCurrency: "USD"
```

Isso garante que:
- Múltiplas contas podem ser agregadas facilmente
- Não há conversão de moeda manual no código
- Valores são consistentes independente da moeda da conta
