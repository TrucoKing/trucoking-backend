# 🎉 TrucoKing Backend — Guia de Deploy Completo

## Visão Geral do Sistema

```
Jogador → TrucoKing.html → API (Railway) → PostgreSQL
                                  ↕
                           Mercado Pago
                         (Pix in / Pix out)
```

---

## PASSO 1 — Criar conta no Mercado Pago Developers

1. Acesse: https://www.mercadopago.com.br/developers
2. Faça login com sua conta do Mercado Pago
3. Clique em **"Criar aplicação"**
4. Nome: `TrucoKing`
5. Produto: **Checkout Transparente**
6. Ative: **Pagamentos Online + Transferências**
7. Vá em **Credenciais de Produção**
8. Copie o **Access Token** (começa com APP_USR-...)

> ⚠️ Use credenciais de TESTE primeiro para testar, depois troque por PRODUÇÃO

---

## PASSO 2 — Criar conta no Railway

1. Acesse: https://railway.app
2. Faça login com GitHub (grátis)
3. Clique em **"New Project"**
4. Escolha **"Deploy from GitHub repo"**
   - Faça upload do código no GitHub primeiro (veja abaixo)
   - Ou escolha **"Empty Project"** e use o CLI

### Subir código no GitHub:
```bash
cd trucoking-backend
git init
git add .
git commit -m "TrucoKing backend inicial"
# Crie repositório em github.com e conecte:
git remote add origin https://github.com/SEU_USUARIO/trucoking-backend.git
git push -u origin main
```

---

## PASSO 3 — Adicionar banco de dados no Railway

1. No seu projeto Railway, clique **"+ New"**
2. Escolha **"Database → PostgreSQL"**
3. Aguarde criar
4. Clique no banco → aba **"Variables"**
5. Copie o valor de **DATABASE_URL**

---

## PASSO 4 — Configurar variáveis de ambiente no Railway

No seu projeto (servidor Node), vá em **"Variables"** e adicione:

| Variável | Valor |
|---|---|
| `PORT` | `3000` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Uma senha forte qualquer |
| `DATABASE_URL` | (copiada do PostgreSQL acima) |
| `MP_ACCESS_TOKEN` | (copiado do Mercado Pago) |
| `BACKEND_URL` | URL do Railway (ex: https://trucoking.up.railway.app) |
| `FRONTEND_URL` | URL do seu site |
| `ADMIN_KEY` | Uma senha forte para o painel admin |

---

## PASSO 5 — Configurar Webhook no Mercado Pago

1. No painel do MP Developers → seu app → **"Webhooks"**
2. Clique **"Adicionar"**
3. URL: `https://SEU_APP.up.railway.app/webhook/mp`
4. Eventos: marque **"Payments"**
5. Salve

> Isso garante que quando alguém pagar o Pix, o dinheiro seja
> creditado automaticamente na conta do jogador.

---

## PASSO 6 — Conectar o frontend (truco-online.html) ao backend

Abra o arquivo `truco-online.html` e adicione no início do `<script>`:

```javascript
const API = 'https://SEU_APP.up.railway.app';
let authToken = localStorage.getItem('tk_token') || null;
```

Substitua as funções de login/cadastro por chamadas à API:

```javascript
async function doLogin() {
  const email = document.getElementById('li-u').value;
  const senha = document.getElementById('li-p').value;

  const res = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha })
  });
  const data = await res.json();

  if (!res.ok) { toast(data.erro, 'err'); return; }

  authToken = data.token;
  localStorage.setItem('tk_token', authToken);
  U.user = data.user;
  U.bal = parseFloat(data.user.saldo);
  userAvatar = data.user.avatar || '😎';
  updNav();
  go('slb');
  toast('Bem-vindo, ' + data.user.nome + '!', 'ok');
}

async function doRegister() {
  const nome     = document.getElementById('rg-n').value;
  const cpf      = document.getElementById('rg-c').value;
  const email    = document.getElementById('rg-e').value;
  const telefone = document.getElementById('rg-t').value;
  const senha    = document.getElementById('rg-p').value;

  const res = await fetch(API + '/auth/cadastro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, cpf, email, telefone, senha })
  });
  const data = await res.json();

  if (!res.ok) { toast(data.erro, 'err'); return; }

  authToken = data.token;
  localStorage.setItem('tk_token', authToken);
  U.user = data.user;
  U.bal = 0;
  updNav();
  go('slb');
  toast('Conta criada com sucesso!', 'ok');
}

// Gerar QR Code Pix real
async function gerarPix() {
  const valor = parseFloat(document.getElementById('dv').value);
  if (!valor || valor < 1) { toast('Valor mínimo R$ 1,00', 'err'); return; }

  const res = await fetch(API + '/deposito/criar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken
    },
    body: JSON.stringify({ valor })
  });
  const data = await res.json();

  if (!res.ok) { toast(data.erro, 'err'); return; }

  // Mostra QR Code para o jogador
  document.getElementById('pf-dep').classList.remove('on');
  document.getElementById('pvshow').textContent = 'R$ ' + valor.toFixed(2).replace('.', ',');
  document.getElementById('pf-key').classList.add('on');

  // Se quiser mostrar QR Code visual:
  // document.getElementById('qr-img').src = 'data:image/png;base64,' + data.qr_code_base64;

  // Fica verificando se pagamento chegou (polling)
  pollDeposito(data.transacao_id);
}

// Verifica a cada 5s se o depósito foi confirmado
function pollDeposito(txId) {
  const interval = setInterval(async () => {
    const res = await fetch(API + '/deposito/status/' + txId, {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    const data = await res.json();
    if (data.status === 'aprovado') {
      clearInterval(interval);
      // Recarrega saldo
      const me = await fetch(API + '/auth/me', {
        headers: { 'Authorization': 'Bearer ' + authToken }
      });
      const user = await me.json();
      U.bal = parseFloat(user.saldo);
      updNav();
      updWallet();
      toast('Depósito confirmado! +R$ ' + data.valor.toFixed(2).replace('.', ','), 'ok');
      document.getElementById('pf-key').classList.remove('on');
    }
  }, 5000);
  // Para de verificar após 10 minutos
  setTimeout(() => clearInterval(interval), 600000);
}

// Saque real
async function confSaq() {
  const valor     = parseFloat(document.getElementById('sv').value);
  const pix_chave = document.getElementById('sk').value;
  if (!valor || valor < 20) { toast('Mín. R$ 20', 'err'); return; }
  if (!pix_chave) { toast('Informe chave Pix!', 'err'); return; }
  if (valor > U.bal) { toast('Saldo insuficiente!', 'err'); return; }

  const res = await fetch(API + '/saque/solicitar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken
    },
    body: JSON.stringify({ valor, pix_chave, pix_tipo: 'email' })
  });
  const data = await res.json();

  if (!res.ok) { toast(data.erro, 'err'); return; }

  U.bal -= valor;
  updNav();
  updWallet();
  toast('Saque enviado! Pix em até 5 min.', 'ok');
  document.getElementById('pf-saq').classList.remove('on');
}
```

---

## PASSO 7 — Instalar dependências localmente (para testar)

```bash
cd trucoking-backend
npm install

# Crie o arquivo .env baseado no .env.example
cp .env.example .env
# Edite o .env com seus valores reais

# Rode o servidor
npm run dev
```

---

## Custos Estimados

| Serviço | Custo |
|---|---|
| Railway (servidor + DB) | ~$5/mês (~R$25) |
| Mercado Pago | 1,5% por transação |
| Domínio .com.br | ~R$40/ano |
| **Total fixo** | **~R$25/mês** |

Com 15% de taxa por partida e 100 partidas/dia de R$5:
- Receita bruta: R$300/dia
- Custo MP (1,5%): ~R$4,50/dia
- **Lucro líquido: ~R$295/dia = R$8.850/mês**

---

## Endpoints da API

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/cadastro` | Criar conta |
| POST | `/auth/login` | Fazer login |
| GET | `/auth/me` | Dados do usuário |
| PATCH | `/auth/avatar` | Mudar avatar |
| POST | `/deposito/criar` | Gerar QR Pix |
| GET | `/deposito/status/:id` | Verificar pagamento |
| POST | `/saque/solicitar` | Solicitar saque |
| GET | `/carteira` | Saldo + histórico |
| POST | `/jogo/entrar` | Entrar na mesa |
| POST | `/jogo/resultado` | Registrar vencedor |
| POST | `/webhook/mp` | Webhook Mercado Pago |
| GET | `/admin/usuarios` | Painel admin |
| GET | `/admin/transacoes` | Transações admin |

---

## Suporte

Qualquer dúvida no processo de deploy, pode perguntar!
