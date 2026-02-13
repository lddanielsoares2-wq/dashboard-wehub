# Sistema de Múltiplas Contas Google Ad Manager

## O que foi implementado

Sistema completo de OAuth para permitir que usuários conectem múltiplas contas do Google Ad Manager e visualizem métricas agregadas.

## Arquitetura

### Backend

1. **Tabela no banco de dados**: `google_ad_manager_accounts`
   - Armazena credenciais OAuth por usuário
   - Campos: user_id, account_name, network_code, access_token, refresh_token, token_expiry, is_active

2. **Endpoints de OAuth**:
   - `GET /api/googleadmanager/oauth/start` - Inicia fluxo OAuth
   - `GET /api/googleadmanager/oauth/callback` - Recebe callback do Google

3. **Endpoints de gerenciamento**:
   - `GET /api/googleadmanager/accounts` - Lista contas do usuário
   - `DELETE /api/googleadmanager/accounts/:id` - Remove conta
   - `PATCH /api/googleadmanager/accounts/:id/toggle` - Ativa/desativa conta

4. **Endpoint de estatísticas (modificado)**:
   - `GET /api/googleadmanager/statistics` - Agora busca de TODAS as contas ativas do usuário
   - Agrega métricas automaticamente (soma impressions, clicks, revenue, etc.)
   - Cache de 15 minutos

### Como funciona a agregação

1. Sistema busca todas as contas ativas do usuário no banco
2. Faz requests paralelos para cada conta
3. Agrega os resultados somando as métricas
4. Retorna dados consolidados

**Exemplo de resposta**:
```json
{
  "success": true,
  "data": [
    {
      "date": "2025-12-18",
      "impressions": 50000,  // Soma de todas as contas
      "clicks": 1500,
      "revenue": 125.50,
      "ctr": 3.0,
      "ecpm": 2.51,
      "accounts": ["Conta 1", "Conta 2"]  // Quais contas contribuíram
    }
  ],
  "totals": {
    "impressions": 50000,
    "clicks": 1500,
    "revenue": 125.50,
    "ctr": 3.0,
    "ecpm": 2.51
  },
  "accountCount": 2,
  "accounts": [
    { "id": 1, "name": "Conta 1", "success": true, "dataCount": 5 },
    { "id": 2, "name": "Conta 2", "success": true, "dataCount": 5 }
  ]
}
```

## Frontend - Como implementar o botão

### 1. Criar página de configurações (ou adicionar à existente)

```tsx
import { useState, useEffect } from 'react';
import apiClient from '@/utility/apiClient';

export function GoogleAdManagerSettings() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);

  // Carregar contas existentes
  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const response = await apiClient.get('/googleadmanager/accounts');
      setAccounts(response.data.accounts || []);
    } catch (error) {
      console.error('Erro ao carregar contas:', error);
    }
  };

  // Conectar nova conta
  const handleConnectAccount = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get('/googleadmanager/oauth/start');

      // Redirecionar para URL de autenticação do Google
      window.location.href = response.data.authUrl;
    } catch (error) {
      console.error('Erro ao iniciar OAuth:', error);
      alert('Erro ao conectar conta');
    } finally {
      setLoading(false);
    }
  };

  // Remover conta
  const handleRemoveAccount = async (id) => {
    if (!confirm('Deseja remover esta conta?')) return;

    try {
      await apiClient.delete(`/googleadmanager/accounts/${id}`);
      loadAccounts(); // Recarregar lista
    } catch (error) {
      console.error('Erro ao remover conta:', error);
      alert('Erro ao remover conta');
    }
  };

  // Ativar/Desativar conta
  const handleToggleAccount = async (id) => {
    try {
      await apiClient.patch(`/googleadmanager/accounts/${id}/toggle`);
      loadAccounts(); // Recarregar lista
    } catch (error) {
      console.error('Erro ao alterar status:', error);
      alert('Erro ao alterar status da conta');
    }
  };

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">Contas Google Ad Manager</h2>

      {/* Botão Adicionar Conta */}
      <button
        onClick={handleConnectAccount}
        disabled={loading}
        className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded mb-4"
      >
        {loading ? 'Conectando...' : '+ Adicionar Conta'}
      </button>

      {/* Lista de contas */}
      <div className="space-y-2">
        {accounts.map((account) => (
          <div
            key={account.id}
            className="flex items-center justify-between bg-gray-100 p-4 rounded"
          >
            <div>
              <h3 className="font-semibold">{account.account_name}</h3>
              <p className="text-sm text-gray-600">
                Network Code: {account.network_code}
              </p>
              <p className="text-xs text-gray-500">
                Adicionada em: {new Date(account.created_at).toLocaleDateString()}
              </p>
            </div>

            <div className="flex gap-2">
              {/* Toggle ativo/inativo */}
              <button
                onClick={() => handleToggleAccount(account.id)}
                className={`px-3 py-1 rounded ${
                  account.is_active
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-400 text-white'
                }`}
              >
                {account.is_active ? 'Ativa' : 'Inativa'}
              </button>

              {/* Remover */}
              <button
                onClick={() => handleRemoveAccount(account.id)}
                className="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded"
              >
                Remover
              </button>
            </div>
          </div>
        ))}
      </div>

      {accounts.length === 0 && (
        <p className="text-gray-500 text-center py-8">
          Nenhuma conta conectada. Clique em "Adicionar Conta" para começar.
        </p>
      )}
    </div>
  );
}
```

### 2. Detectar callback do OAuth

Na sua página de settings, adicione um efeito para detectar quando o usuário volta do OAuth:

```tsx
useEffect(() => {
  const params = new URLSearchParams(window.location.search);

  if (params.get('gam_success')) {
    alert('Conta conectada com sucesso!');
    loadAccounts();
    // Limpar URL
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (params.get('gam_error')) {
    alert(`Erro ao conectar: ${params.get('gam_error')}`);
    // Limpar URL
    window.history.replaceState({}, '', window.location.pathname);
  }
}, []);
```

### 3. Atualizar apiClient (se necessário)

Adicione métodos para os novos endpoints:

```typescript
// Em apiClient.ts ou similar

async getGamAccounts() {
  return this.get('/googleadmanager/accounts');
}

async removeGamAccount(id: number) {
  return this.delete(`/googleadmanager/accounts/${id}`);
}

async toggleGamAccount(id: number) {
  return this.patch(`/googleadmanager/accounts/${id}/toggle`);
}

async startGamOauth() {
  return this.get('/googleadmanager/oauth/start');
}
```

## Fluxo do Usuário

1. **Usuário clica em "Adicionar Conta"**
   → Frontend chama `/api/googleadmanager/oauth/start`
   → Recebe URL de autenticação do Google
   → Redireciona usuário para Google

2. **Usuário autoriza no Google**
   → Google redireciona para `/api/googleadmanager/oauth/callback`
   → Backend troca código por tokens
   → Backend salva conta no banco
   → Redireciona usuário de volta para frontend

3. **Frontend detecta sucesso**
   → Mostra mensagem de sucesso
   → Recarrega lista de contas

4. **Sistema automaticamente agrega dados**
   → Quando usuário acessa dashboard
   → API busca dados de TODAS as contas ativas
   → Retorna métricas somadas

## Configuração do Google Cloud Console

Para o OAuth funcionar, você precisa configurar no Google Cloud Console:

1. Ir em **APIs & Services > Credentials**
2. Adicionar **Redirect URI**:
   - Desenvolvimento: `http://localhost:3003/api/googleadmanager/oauth/callback`
   - Produção: `https://back.hdsgroup.io/api/googleadmanager/oauth/callback`

3. Scopes necessários:
   - `https://www.googleapis.com/auth/admanager`
   - `https://www.googleapis.com/auth/admanager.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`

## Deploy

Quando fazer deploy para produção, atualizar `.env` no servidor:

```env
BACKEND_URL=https://back.hdsgroup.io
FRONTEND_URL=https://v2.hdsgroup.io
```

## Testando

1. **Teste local**:
   ```bash
   npm run dev
   ```

2. **Acesse** a página de configurações
3. **Clique** em "Adicionar Conta"
4. **Autorize** no Google
5. **Verifique** se a conta aparece na lista
6. **Acesse** o dashboard - deve mostrar dados agregados de todas as contas

## Segurança

- ✅ Tokens são criptografados no banco
- ✅ Refresh automático quando token expira
- ✅ Cada usuário só vê suas próprias contas
- ✅ State parameter previne CSRF
- ✅ Contas podem ser desativadas sem remover
